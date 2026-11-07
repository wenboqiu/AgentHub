#!/usr/bin/env node
// 用 WorkBuddy 自己的 CLI 执行一张 AgentHub 任务单。命令行触发，不需要常驻进程。
//
//   node scripts/task-run.mjs 24                # 跑 24 号单
//   node scripts/task-run.mjs --next            # 自动挑一张最该接的单
//   node scripts/task-run.mjs 24 --dry          # 只打印将要执行的命令，不真跑
//   node scripts/task-run.mjs 24 --executor claude   # 换执行器（默认 workbuddy）
//
// 干活的进程：WorkBuddy 自带的 codebuddy CLI（`codebuddy -p`），和桌面端同一个引擎、同一套登录态。
// 流程：认领 -> 在该单的目录里跑 -> 写产物 /tmp/agenthub-task-<id>.md -> 转「待验收」。
// 配置：~/.agenthub/watcher/config.json（和 watch-tasks.mjs 共用），token 复用桌面端登录态。

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, openSync, closeSync } from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const HOME = homedir()
const STATE_DIR = join(HOME, '.agenthub', 'watcher')
const CONFIG_PATH = join(STATE_DIR, 'config.json')
const RUNS_DIR = join(STATE_DIR, 'runs')
const WATCH = join(dirname(fileURLToPath(import.meta.url)), 'watch-tasks.mjs')

const DEFAULT_CONFIG = {
  serverUrl: 'https://agenthub.wondergarden.top',
  machine: 'my-pc',
  machineAliases: ['my-pc', 'LAPTOP-UEUKV16C'],
  cwdMap: { 'D:\\Work2\\': join(HOME, 'Work') + '/' },
  maxPerRun: 2,
  includeDoing: false,
  respectAgent: true,
  // 执行者：workbuddy = codebuddy CLI（优先 npm 完整版，回退应用内置 lite-wb）；claude = 本机 claude CLI
  executor: 'workbuddy',
  runTimeoutMinutes: 30,
}

const argv = process.argv.slice(2)
const flag = name => argv.includes(`--${name}`)
const value = name => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null
}
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && argv[i - 1] !== '--dry'))

mkdirSync(RUNS_DIR, { recursive: true })
const readJson = (path, fallback) => {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}
const writeJson = (path, data) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

const config = { ...DEFAULT_CONFIG, ...readJson(CONFIG_PATH, {}) }

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

/** 调 watch-tasks 的认领 / 收尾，保持账本只有一处真相 */
function watch(args) {
  const res = spawnSync(process.execPath, [WATCH, ...args], { encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`watch-tasks ${args.join(' ')} 失败：${(res.stderr || '').trim()}`)
  return res.stdout ? JSON.parse(res.stdout) : null
}

/** 找 WorkBuddy CLI：优先 npm 完整版（有独立登录态，应用内置 lite-wb 无 TUI 不能 /login），
 *  再看环境变量 / 配置，最后按平台猜应用内置安装位置。
 *  Windows 一律取无扩展名的 JS 入口（spawn 时用 node 直驱；Node 会拒绝直接 spawn .cmd） */
function workbuddyCli() {
  const npmPkg = join('@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy')
  const candidates = [
    process.env.WORKBUDDY_CLI,
    config.workbuddyCli,
    // npm 完整版（@tencent-ai/codebuddy-code）真实入口：mac 上 bin/codebuddy 可能是包装脚本，优先 .real
    join(HOME, '.local/bin/codebuddy.real'),
    join(HOME, '.local/lib/node_modules', npmPkg),
    join(HOME, '.npm-global/bin/codebuddy'),
    '/usr/local/bin/codebuddy',
    '/opt/homebrew/bin/codebuddy',
    ...(platform() === 'win32'
      ? [
          join(process.env.APPDATA ?? '', 'npm', 'node_modules', npmPkg),
          join(HOME, '.local', 'node_modules', npmPkg),
          join(HOME, '.npm-global', 'node_modules', npmPkg),
          // 应用内置 CLI：默认装 C:\Program Files，也可能自定义到别的盘（如 D:\Program Files）
          join(process.env.ProgramFiles ?? 'C:\\Program Files', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'),
          join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'),
          join(process.env.LOCALAPPDATA ?? '', 'Programs', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'),
          join(process.env.LOCALAPPDATA ?? '', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'),
        ]
      : ['/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy']),
  ].filter(Boolean)
  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  return null
}

/** 执行器 -> 可执行文件与参数 */
function executorCmd(name, prompt, dir) {
  if (name === 'claude') {
    return { bin: 'claude', args: ['-p', prompt, '--permission-mode', 'acceptEdits', '--allowedTools', 'Edit,Write,Read,Glob,Grep,Bash'], dir }
  }
  const bin = workbuddyCli()
  if (!bin) throw new Error('没找到 WorkBuddy 自带的 CLI，用 --executor claude 或设置 WORKBUDDY_CLI')
  let args = ['-p', prompt, '--permission-mode', 'acceptEdits', '--allowedTools', 'Edit,Write,Read,Glob,Grep,Bash', '--output-format', 'text']
  // CLI 默认会在 127.0.0.1 上占一个端口；桌面端开着时可能撞车，配置里给个固定端口就稳了
  if (config.workbuddyPort) args.push('--port', String(config.workbuddyPort))
  // Windows：入口是无扩展名 JS 脚本，用当前 node 直驱（daemon 本身跑在 node 上；.cmd 会被 spawn 拒绝）
  if (platform() === 'win32') return { bin: process.execPath, args: [bin, ...args], dir }
  return { bin, args, dir }
}

/** 执行器子进程的环境消毒：去掉宿主（如 WorkBuddy 会话）注入的产品配置，
 *  否则 CLI 会解析到 workbuddy-desktop（token 为空）而不是自己 /login 的凭据 */
function sanitizeEnv(env) {
  const clean = { ...env }
  for (const key of [
    'ACC_PRODUCT_CONFIG', 'ACC_PRODUCT_CONFIG_V2', 'ACC_PRODUCT_CONFIG_V3', 'ACC_PRODUCT_CONFIG_PATH',
    'WORKBUDDY_RESOURCES_PATH', 'NODE_OPTIONS',
  ]) delete clean[key]
  return clean
}

function promptFor(task, dir, artifactPath) {
  const lines = [
    `你在执行 AgentHub 任务单 #${task.id}。工作目录：${dir}`,
    '',
    `## 任务单标题`,
    task.title || '(无标题)',
  ]
  if ((task.notes ?? '').trim()) lines.push('', '## 说明', task.notes.trim())
  const checklist = task.checklist ?? []
  if (checklist.length) {
    lines.push('', '## 待办清单')
    for (const item of checklist) lines.push(`- [${item.done ? 'x' : ' '}] ${item.text}`)
  }
  // constraints 是结构化对象：{ paths: string[], net, push, scripts, note }
  const c = task.constraints
  if (c && typeof c === 'object') {
    const rules = []
    if ((c.paths ?? []).length) rules.push(`只允许改这些路径：${c.paths.join('、')}`)
    else rules.push('只改工作目录内的文件')
    rules.push(`联网：${c.net ? '允许' : '不允许'}`)
    rules.push(`推远端（git push）：${c.push ? '允许' : '不允许'}`)
    rules.push(`跑脚本：${c.scripts ? '允许' : '只做必要的最小验证'}`)
    if ((c.note ?? '').trim()) rules.push(c.note.trim())
    lines.push('', '## 执行边界（硬约束）', ...rules.map(r => `- ${r}`))
  } else if (typeof c === 'string' && c.trim()) {
    lines.push('', '## 执行边界（硬约束）', c.trim())
  }
  lines.push(
    '',
    '## 要求',
    `1. 就在 ${dir} 里把活干完，这个目录之外的文件不要动。`,
    '2. 不要 git commit、git push，除非任务单里明确要求。',
    '3. 不要改 ~/.agenthub 下的账本和配置，也不要动 AgentHub 的监听脚本。',
    '4. 干完后把结论写成 Markdown 存到 ' + artifactPath + '，四段：做了什么 / 怎么验证 / 影响面 / 后续与风险。',
    '5. 做不到就直说卡在哪，不要假装完成。',
  )
  return lines.join('\n')
}

function logTail(path, lines = 120) {
  try {
    const text = readFileSync(path, 'utf8')
    return text.split('\n').slice(-lines).join('\n').trim()
  } catch {
    return ''
  }
}

async function main() {
  const executor = value('executor') ?? config.executor ?? 'workbuddy'
  const dry = flag('dry')
  let id = Number(positional[0])

  if (!id && flag('next')) {
    const detect = watch(['--detect'])
    const first = (detect.candidates ?? [])[0]
    if (!first) {
      console.log(JSON.stringify({ picked: null, note: '没有可接的单', blocked: detect.blocked }, null, 2))
      return
    }
    id = first.id
  }
  if (!id) {
    console.error('用法：node scripts/task-run.mjs <id> | --next [--dry] [--executor workbuddy|claude]')
    process.exit(2)
  }

  const { tasks } = await api('/tasks')
  const task = tasks.find(t => t.id === id)
  if (!task) throw new Error(`任务 ${id} 不存在或不属于这个账号`)

  const detect = watch(['--detect'])
  const candidate = (detect.candidates ?? []).find(c => c.id === id)
  // 手动指定的单可能已经接过、或者状态不是待办，所以目录单独探一次，不依赖候选列表
  const probe = watch(['--probe', task.cwd ?? ''])
  const dir = candidate?.dir ?? probe.dir
  if (!dir) {
    throw new Error(`目录落不到本机：${task.cwd} -> ${probe.how}，先补 ~/.agenthub/watcher/config.json 的 cwdMap`)
  }
  if (task.status !== 'todo') {
    console.log(`[task-run] 注意：#${id} 当前状态是 ${task.status}，仍按你的要求重跑`)
  }

  // Windows 的 /tmp 会落到当前盘根目录（cwd 在 D: 就是 D:\tmp），跨盘就错位了；统一用系统临时目录
  const artifactPath = platform() === 'win32'
    ? join(tmpdir(), `agenthub-task-${id}.md`)
    : join('/tmp', `agenthub-task-${id}.md`)
  const prompt = promptFor(task, dir, artifactPath)
  const cmd = executorCmd(executor, prompt, dir)

  if (dry) {
    console.log(JSON.stringify({
      id, title: task.title, status: task.status, executor, dir, cwd: task.cwd,
      bin: cmd.bin, args: cmd.args.map(a => (a === prompt ? '<prompt>' : a)), artifact: artifactPath,
      signal: '真跑去掉 --dry',
    }, null, 2))
    return
  }

  watch(['--claim', String(id)])
  const logPath = join(RUNS_DIR, `${id}.log`)
  const fd = openSync(logPath, 'w')
  const started = Date.now()
  console.log(`[task-run] #${id} 用 ${executor} 在 ${dir} 开跑，日志 ${logPath}`)

  const timeoutMs = (config.runTimeoutMinutes ?? 30) * 60_000
  const child = spawn(cmd.bin, cmd.args, { cwd: cmd.dir, stdio: ['ignore', 'pipe', 'pipe'], env: sanitizeEnv(process.env) })
  const chunks = []
  const write = d => { try { writeFileSync(fd, d) } catch {} }
  child.stdout.on('data', d => { chunks.push(d); write(d) })
  child.stderr.on('data', d => { chunks.push(d); write(d) })

  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, timeoutMs)

  const code = await new Promise(resolve => {
    child.on('error', err => { write(`\n[task-run] 启动失败：${err.message}\n`); resolve(-1) })
    child.on('close', c => resolve(c ?? -1))
  })
  clearTimeout(timer)
  closeSync(fd)

  const seconds = Math.round((Date.now() - started) / 1000)

  if (timedOut) {
    watch(['--fail', String(id), '--reason', `执行超过 ${config.runTimeoutMinutes} 分钟被中断，日志 ${logPath}`])
    console.log(JSON.stringify({ id, status: 'failed', reason: 'timeout', seconds, log: logPath }, null, 2))
    process.exit(1)
  }
  if (code !== 0) {
    const tail = logTail(logPath, 40)
    // 环境问题不算这张单的失败：放回池子里等下次，别把单子记成 failed
    const env = /EADDRINUSE/.test(tail) ? 'port'
      : /Permission request rejected|not logged in|请先登录|unauthorized/i.test(tail) ? 'auth'
      : null
    if (env) {
      watch(['--release', String(id)])
      const hint = env === 'port'
        ? 'WorkBuddy CLI 的本地端口被占了：在 ~/.agenthub/watcher/config.json 里设 workbuddyPort（例如 50999）再跑'
        : 'WorkBuddy CLI 读不到桌面端登录态：从终端或 launchd 启动，不要从 WorkBuddy 的 agent 会话里启动'
      console.log(JSON.stringify({ id, status: 'retry-later', reason: env, hint, log: logPath }, null, 2))
      process.exit(1)
    }
    watch(['--fail', String(id), '--reason', `${executor} 退出码 ${code}：${tail.slice(-200)}`])
    console.log(JSON.stringify({ id, status: 'failed', exit: code, seconds, log: logPath }, null, 2))
    process.exit(1)
  }

  // 执行器没写产物就自己攒一份，免得任务单上只有一句“已完成”
  if (!existsSync(artifactPath)) {
    const tail = logTail(logPath, 80) || '(执行器没有输出)'
    writeFileSync(artifactPath, [
      `# 任务单 #${id}：${task.title}`,
      '',
      '## 做了什么',
      `由 ${executor} 在 ${dir} 执行，用时 ${seconds}s。`,
      '',
      '## 怎么验证',
      '见下方执行器原始输出。',
      '',
      '## 影响面',
      `${dir} 内的文件改动。`,
      '',
      '## 后续与风险',
      '产物由执行器输出自动回填，验收时请以实际 diff 为准。',
      '',
      '---',
      '```',
      tail,
      '```',
    ].join('\n'))
  }

  const done = watch(['--finish', String(id), '--md', artifactPath])
  console.log(JSON.stringify({ id, status: done.status, executor, seconds, artifact: artifactPath, log: logPath }, null, 2))
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
