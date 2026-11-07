#!/usr/bin/env node
// 任务单常驻监听：挂在服务端 WebSocket 上，任务单一落库就收到推送，秒级反应，不用轮询。
// 由 launchd 常驻（KeepAlive），断了自动重连。
//
// 两种模式（~/.agenthub/watcher/config.json 的 daemon.mode）：
//   "notify"  只弹通知，等你看（默认，不花模型额度）
//   "run"     收到就交给 task-run.mjs 执行，干完回写产物并转待验收
//
// 执行者由 config.executor 决定："workbuddy"（默认，应用自带的 codebuddy CLI）/ "claude"。
// 注意：daemon 必须由终端或 launchd 启动，**不要**从 WorkBuddy 的 agent 会话里起——
// 沙箱不允许 agent 读桌面端凭据目录，那样起的 daemon 调不动 WorkBuddy CLI。
//
//   node scripts/task-daemon.mjs          # 前台跑（调试用）
//   node scripts/task-daemon.mjs --once   # 只连一次、处理完现有单就退

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const STATE_DIR = join(homedir(), '.agenthub', 'watcher')
const CONFIG_PATH = join(STATE_DIR, 'config.json')
const NOTIFIED_PATH = join(STATE_DIR, 'notified.json')
const LOG_PATH = join(STATE_DIR, 'daemon.log')
const RUNS_DIR = join(STATE_DIR, 'runs')

mkdirSync(RUNS_DIR, { recursive: true })
const readJson = (path, fallback) => {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}
const writeJson = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data, null, 2) + '\n') }
const log = msg => appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`)

const config = readJson(CONFIG_PATH, {})
const settings = { mode: 'notify', sweepMinutes: 10, ...(config.daemon ?? {}) }

function desktopConfig() {
  const candidates = platform() === 'darwin'
    ? [join(homedir(), 'Library', 'Application Support', 'com.wenbo.agenthub', 'config.json')]
    : [join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'com.wenbo.agenthub', 'config.json')]
  for (const path of candidates) {
    const data = readJson(path, null)
    if (data?.token) return data
  }
  return null
}

const desktop = desktopConfig()
const serverUrl = (process.env.AGENTHUB_URL || desktop?.serverUrl || config.serverUrl || 'https://agenthub.wondergarden.top').replace(/\/+$/, '')
const token = process.env.AGENTHUB_TOKEN || desktop?.token
if (!token) { console.error('找不到 AgentHub 登录状态'); process.exit(2) }

const wsUrl = `${serverUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`

const notify = (title, body) => {
  if (platform() !== 'darwin') return
  try {
    spawn('/usr/bin/osascript', ['-e', `display notification ${JSON.stringify(body)} with title "AgentHub 新任务单" subtitle ${JSON.stringify(title)} sound name "Glass"`], { stdio: 'ignore' }).unref()
  } catch (err) { log(`通知失败: ${err.message}`) }
}

// 复用 watch-tasks 的判定：它就是唯一一份「这张单该不该接」的定义，daemon 不再实现一遍
function detect() {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [join(HERE, 'watch-tasks.mjs'), '--detect'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.on('close', () => {
      try { resolve(JSON.parse(out)) } catch { resolve({ candidates: [], blocked: [] }) }
    })
    child.on('error', () => resolve({ candidates: [], blocked: [] }))
  })
}

function run(cmd, args) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', c => { out += c })
    child.stderr.on('data', c => { out += c })
    child.on('close', code => resolve({ code, out }))
  })
}

const seenIds = new Set(readJson(NOTIFIED_PATH, { ids: [] }).ids ?? [])
const queue = []
let busy = false

function remember(id) {
  seenIds.add(id)
  writeJson(NOTIFIED_PATH, { ids: [...seenIds].slice(-200), updatedAt: new Date().toISOString() })
}

async function work(candidate) {
  const { id, title, dir } = candidate
  const executor = settings.executor ?? config.executor ?? 'workbuddy'
  log(`开始 #${id} ${title} @ ${dir}（执行者 ${executor}）`)
  // 认领 / 执行 / 写产物 / 转待验收全在 task-run 里，daemon 只管触发，不重复实现一遍
  const res = await run(process.execPath, [join(HERE, 'task-run.mjs'), String(id), '--executor', executor])
  const ok = res.code === 0
  const tail = res.out.trim().split('\n').slice(-2).join(' | ').slice(0, 300)
  log(`${ok ? '完成' : '失败'} #${id} ${tail}`)
  notify(ok ? `#${id} 已完成` : `#${id} 没干成`, ok ? `${title} · 待验收` : `${title} · 看 daemon.log`)
}

async function pump() {
  if (busy) return
  busy = true
  try {
    while (queue.length) {
      const next = queue.shift()
      try { await work(next) } catch (err) { log(`处理 #${next.id} 异常: ${err.message}`) }
    }
  } finally { busy = false }
}

async function handle(candidate) {
  if (seenIds.has(candidate.id)) return
  remember(candidate.id)
  log(`发现新单 #${candidate.id} ${candidate.title} @ ${candidate.dir}`)
  if (settings.mode !== 'run') {
    notify(candidate.title, `#${candidate.id} · ${candidate.priority} · 待你看`)
    return
  }
  queue.push(candidate)
  pump()
}

async function evaluate() {
  const data = await detect()
  if (data.busy) return
  for (const c of data.candidates ?? []) await handle(c)
}

let attempt = 0
function connect() {
  const ws = new WebSocket(wsUrl)
  let opened = false

  ws.onopen = () => {
    opened = true
    attempt = 0
    log(`已连上 ${serverUrl}（模式 ${settings.mode}）`)
    evaluate() // 补上断线期间漏掉的单
  }

  ws.onmessage = event => {
    let msg
    try { msg = JSON.parse(event.data) } catch { return }
    // 服务端在任务新建 / 改动 / 确认 / 派发时都会推 {type:'task', task}
    if (msg.type === 'task' || msg.type === 'task.removed') evaluate()
  }

  ws.onclose = () => {
    const delay = Math.min(60_000, 2000 * 2 ** attempt++)
    log(`连接断开，${Math.round(delay / 1000)} 秒后重连`)
    setTimeout(connect, delay)
  }

  ws.onerror = () => { if (!opened) log('连接失败') }
}

// 兜底巡检：WebSocket 静默假死时也能发现漏单
setInterval(() => { evaluate().catch(err => log(`巡检失败: ${err.message}`)) }, Math.max(1, settings.sweepMinutes) * 60_000)

log(`daemon 启动 pid=${process.pid} 模式=${settings.mode}`)
connect()

if (process.argv.includes('--once')) {
  setTimeout(async () => { await evaluate(); log('--once 结束'); process.exit(0) }, 5000)
}
