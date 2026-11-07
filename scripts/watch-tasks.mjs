#!/usr/bin/env node
// 任务单监听：从 AgentHub 拉「派发过来但还没开动」的任务单，做去重记账、目录映射和收尾回写。
// 只负责确定性的搬运，真正的改代码由调用它的 agent 做。
//
//   node scripts/watch-tasks.mjs                  # 列出本轮该接的单（JSON）
//   node scripts/watch-tasks.mjs --claim 12,13    # 认领，写进账本（防止重复开工）
//   node scripts/watch-tasks.mjs --finish 12 --md /tmp/12.md   # 回写产物并转待验收
//   node scripts/watch-tasks.mjs --fail 12 --reason "..."      # 记一笔失败，单子留在待办
//   node scripts/watch-tasks.mjs --baseline       # 把当前待办全部登记为「存量」，以后不再自动接
//   node scripts/watch-tasks.mjs --release 12     # 把某张存量单放出来，下次可以接
//   node scripts/watch-tasks.mjs --ledger         # 看账本
//
// 配置：~/.agenthub/watcher/config.json（首次运行自动生成），token 复用桌面端登录态。

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, unlinkSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, dirname } from 'node:path'

const HOME = homedir()
const STATE_DIR = join(HOME, '.agenthub', 'watcher')
const CONFIG_PATH = join(STATE_DIR, 'config.json')
const LEDGER_PATH = join(STATE_DIR, 'ledger.json')
const LOCK_PATH = join(STATE_DIR, 'lock.json')

const DEFAULT_CONFIG = {
  serverUrl: 'https://agenthub.wondergarden.top',
  machine: 'my-pc',
  // 任务单上可能写着别的机器名（例如出单时选的是 Windows 那台），在这里登记为「也能接」
  machineAliases: ['my-pc', 'LAPTOP-UEUKV16C'],
  // 任务单上的目录 -> 本机目录前缀；按最长前缀匹配，大小写不敏感
  cwdMap: { 'D:\\Work2\\': join(HOME, 'Work') + '/' },
  maxPerRun: 2,
  includeDoing: false,
  // true：单上写了 Claude/Codex/ZCode 的活留给它们自己的执行器，不抢
  respectAgent: true,
}

const argv = process.argv.slice(2)
const flag = name => argv.includes(`--${name}`)
const value = name => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null
}

mkdirSync(STATE_DIR, { recursive: true })
const readJson = (path, fallback) => {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}
const clearLock = () => { try { unlinkSync(LOCK_PATH) } catch {} }
const writeJson = (path, data) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

const config = { ...DEFAULT_CONFIG, ...readJson(CONFIG_PATH, {}) }
if (!existsSync(CONFIG_PATH)) writeJson(CONFIG_PATH, config)
const ledger = readJson(LEDGER_PATH, { updatedAt: null, tasks: {} })

// 桌面端的登录态里就有 serverUrl 和 token，不再单独存一份密码
function desktopConfig() {
  const candidates = platform() === 'darwin'
    ? [join(HOME, 'Library', 'Application Support', 'com.wenbo.agenthub', 'config.json')]
    : [join(process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming'), 'com.wenbo.agenthub', 'config.json')]
  for (const path of candidates) {
    const data = readJson(path, null)
    if (data?.token) return data
  }
  return null
}

const desktop = desktopConfig()
const serverUrl = (process.env.AGENTHUB_URL || desktop?.serverUrl || config.serverUrl).replace(/\/+$/, '')
const token = process.env.AGENTHUB_TOKEN || desktop?.token
if (!token) {
  console.error('找不到 AgentHub 登录状态：先在桌面端登录一次，或设置 AGENTHUB_TOKEN')
  process.exit(2)
}

async function api(path, init = {}) {
  const res = await fetch(`${serverUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  })
  const body = await res.text()
  const data = body ? JSON.parse(body) : null
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${data?.message ?? body.slice(0, 200)}`)
  return data
}

// 任务单上的目录换成本机目录：先试原样（本机路径），再按映射表最长前缀替换
function mapCwd(cwd) {
  if (!cwd) return { dir: null, how: 'none' }
  const normalized = cwd.replace(/[\\/]+$/, '')
  if (existsSync(normalized) && statSync(normalized).isDirectory()) return { dir: normalized, how: 'direct', key: null }
  const entries = Object.entries(config.cwdMap ?? {}).sort((a, b) => b[0].length - a[0].length)
  for (const [from, to] of entries) {
    const fromNorm = from.replace(/[\\/]+$/, '')
    if (normalized.toLowerCase().startsWith(fromNorm.toLowerCase())) {
      const tail = normalized.slice(fromNorm.length).replace(/^[\\/]+/, '').replaceAll('\\', '/')
      const dir = join(to, tail)
      if (existsSync(dir) && statSync(dir).isDirectory()) return { dir, how: 'mapped', key: from }
      return { dir: null, how: 'missing', key: from, tried: dir }
    }
  }
  return { dir: null, how: 'unmapped' }
}

const machineOk = machine => !machine || (config.machineAliases ?? [config.machine]).includes(machine)
const hasBody = task => Boolean((task.notes ?? '').trim()) || (task.checklist ?? []).length > 0

// 单上写了 Claude / Codex / ZCode 的，是派给那台机器的执行器的，不许抢；
// 只接「没指定执行工具」或「指定 WorkBuddy」的单——后者在 AgentHub 里派不出去，只能靠监听接。
const DISPATCHABLE = new Set(['claude', 'codex', 'zcode'])
const agentOk = task => config.respectAgent === false || !task.agent || !DISPATCHABLE.has(task.agent)

function candidates(tasks) {
  const now = Date.now()
  return tasks
    .filter(t => t.status === 'todo' || (config.includeDoing && t.status === 'doing'))
    .filter(t => !t.queuedAt)               // 排队等目标电脑上线的先不碰
    .filter(t => !(t.sessionIds ?? []).length)  // 已经挂了会话的说明有人在跑
    .filter(t => !ledger.tasks[t.id])       // 账本里去过的跳过
    .filter(t => machineOk(t.machine))
    .filter(agentOk)                        // 指定了别的执行工具就不抢
    .map(t => {
      const mapped = mapCwd(t.cwd)
      return { task: t, mapped, weight: (t.priority === 'high' ? 0 : t.priority === 'medium' ? 1 : 2), age: now - Date.parse(t.createdAt) }
    })
    .filter(({ mapped }) => mapped.dir)      // 目录进不去的单子只报告不接手
    .sort((a, b) => a.weight - b.weight || Date.parse(a.task.createdAt) - Date.parse(b.task.createdAt))
}

const shape = ({ task, mapped }) => ({
  id: task.id,
  title: task.title,
  priority: task.priority,
  status: task.status,
  agent: task.agent,
  machine: task.machine,
  cwd: task.cwd,
  dir: mapped.dir,
  cwdMapping: mapped.how,
  createdAt: task.createdAt,
  notes: task.notes,
  checklist: task.checklist,
  constraints: task.constraints,
})

async function main() {
  if (flag('ledger')) {
    const rows = Object.entries(ledger.tasks).map(([id, v]) => ({ id: Number(id), ...v }))
    console.log(JSON.stringify({ updatedAt: ledger.updatedAt, tasks: rows }, null, 2))
    return
  }

  if (flag('probe')) {
    console.log(JSON.stringify({ cwd: value('probe'), ...mapCwd(value('probe')) }, null, 2))
    return
  }

  if (flag('unlock')) {
    clearLock()
    console.log(JSON.stringify({ unlocked: true }, null, 2))
    return
  }

  const { tasks } = await api('/tasks')

  if (flag('baseline')) {
    const live = tasks.filter(t => t.status === 'todo' || t.status === 'doing')
    for (const t of live) {
      if (!ledger.tasks[t.id]) ledger.tasks[t.id] = { state: 'baseline', title: t.title, at: new Date().toISOString() }
    }
    ledger.updatedAt = new Date().toISOString()
    writeJson(LEDGER_PATH, ledger)
    console.log(JSON.stringify({ baselined: live.map(t => t.id), note: '这些存量单不会自动接手，要接用 --release <id>' }, null, 2))
    return
  }

  if (flag('release')) {
    const ids = value('release').split(',').map(Number)
    for (const id of ids) delete ledger.tasks[id]
    ledger.updatedAt = new Date().toISOString()
    writeJson(LEDGER_PATH, ledger)
    console.log(JSON.stringify({ released: ids }, null, 2))
    return
  }

  if (flag('claim')) {
    const ids = value('claim').split(',').map(Number)
    const byId = new Map(tasks.map(t => [t.id, t]))
    const claimed = []
    for (const id of ids) {
      const t = byId.get(id)
      if (!t) throw new Error(`任务 ${id} 不存在或不属于这个账号`)
      ledger.tasks[id] = { state: 'working', title: t.title, at: new Date().toISOString() }
      claimed.push(id)
    }
    ledger.updatedAt = new Date().toISOString()
    writeJson(LEDGER_PATH, ledger)
    clearLock()
    console.log(JSON.stringify({ claimed }, null, 2))
    return
  }

  if (flag('finish')) {
    const id = Number(value('finish'))
    const mdPath = value('md')
    if (!mdPath || !existsSync(mdPath)) throw new Error('--finish 需要 --md <markdown 文件>')
    const md = readFileSync(mdPath, 'utf8')
    const { artifact } = await api(`/tasks/${id}/artifact`, { method: 'PATCH', body: JSON.stringify({ md }) })
    const { task } = await api(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'review' }) })
    ledger.tasks[id] = { state: 'done', title: task.title, at: new Date().toISOString(), artifactAt: artifact?.updatedAt ?? null }
    ledger.updatedAt = new Date().toISOString()
    writeJson(LEDGER_PATH, ledger)
    clearLock()
    console.log(JSON.stringify({ finished: id, status: task.status, artifact: artifact?.updatedAt ?? null }, null, 2))
    return
  }

  if (flag('fail')) {
    const id = Number(value('fail'))
    const reason = value('reason') ?? '未说明'
    ledger.tasks[id] = { state: 'failed', reason, at: new Date().toISOString() }
    ledger.updatedAt = new Date().toISOString()
    writeJson(LEDGER_PATH, ledger)
    clearLock()
    console.log(JSON.stringify({ failed: id, reason }, null, 2))
    return
  }

  // 默认：报本轮能接的单
  // --detect 是只读探测（给 2 分钟一次的通知通道用）：不读锁、不写锁，绝不挡住真正干活的定时任务
  const detect = flag('detect')
  if (!detect && existsSync(LOCK_PATH)) {
    const lock = readJson(LOCK_PATH, {})
    if (lock.at && Date.now() - Date.parse(lock.at) < 45 * 60_000) {
      console.log(JSON.stringify({ busy: true, since: lock.at, pid: lock.pid, candidates: [] }, null, 2))
      return
    }
  }
  const picked = candidates(tasks).slice(0, config.maxPerRun)
  if (picked.length && !detect) writeJson(LOCK_PATH, { at: new Date().toISOString(), pid: process.pid })
  const blocked = tasks
    .filter(t => (t.status === 'todo') && !ledger.tasks[t.id] && machineOk(t.machine) && !(t.sessionIds ?? []).length && !mapCwd(t.cwd).dir)
    .map(t => ({ id: t.id, title: t.title, cwd: t.cwd, why: mapCwd(t.cwd).how }))
  console.log(JSON.stringify({
    server: serverUrl,
    machine: config.machine,
    counts: { total: tasks.length, todo: tasks.filter(t => t.status === 'todo').length, picked: picked.length },
    candidates: picked.map(shape),
    blocked,
  }, null, 2))
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
