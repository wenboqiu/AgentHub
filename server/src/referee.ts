// 代批：会话卡在 waiting（等授权）时，先让项目经理判断能不能自己放行。
//
// 只有一条原则：**机器只放行它完全看懂的安全操作，其余一律交给人。**
// 所以这里不产出 deny —— 拒绝会打断 agent 且容易误伤，判不准就该让人来看。
//
// 但「交给人」里其实混着两类完全不同的问题，混在一起才显得规则太笨：
//   · 能不能做（客观安全）—— 规则完胜：确定、0 延迟、可单测、不受 prompt 注入影响；
//   · 该不该做（主观意图）—— 只有带项目上下文的人/项目经理才知道。
// 所以每条裁决都带一个 tier，把「这条为什么轮不到规则定」标出来（见 VerdictTier）。
//
// 输入是 executor 上报的 tool + detail（Claude 的 Bash 是命令原文、Write 是「路径\n内容」，
// Codex 的 command / fileChange，ZCode 是 input 的 JSON），加上会话的工作目录。
// 所有判断都是纯函数，不碰数据库，方便单测和回放。

import type pg from 'pg'

export type RefereePolicy = {
  enabled: boolean
  /** 只读命令与查看类工具 */
  allowRead: boolean
  /** 项目目录内写文件 */
  allowWrite: boolean
  /** 测试 / 类型检查 / 构建 */
  allowTests: boolean
  /** 联网（装包、请求外网） */
  allowNetwork: boolean
  /** 每小时最多自动放行几次，超了全部交给人——防跑飞 */
  maxPerHour: number
}

export const DEFAULT_POLICY: RefereePolicy = {
  enabled: false,
  allowRead: true,
  allowWrite: true,
  allowTests: true,
  allowNetwork: false,
  maxPerHour: 60,
}

/**
 * 裁决的层级。规则只回答「能不能」，「该不该」得看项目上下文：
 * - allow  ：规则看懂且安全，当场放行（快车道：不烧 token、不让人等）
 * - danger ：硬红线，任何上下文都不能让它变安全（删库、越界写、敏感文件、丢本地改动）
 * - gray   ：风险取决于上下文（装包、联网、推远端、写到任务边界外、跑项目自定义脚本）
 * - unknown：规则看不懂（不认识的命令/工具），不能让机器猜
 *
 * 目前 gray / unknown 都仍然交给人，差别只在界面怎么解释「为什么停下来」，
 * 以及将来只有 gray 才值得叫醒项目经理。
 */
export type VerdictTier = 'allow' | 'danger' | 'gray' | 'unknown'

export type Verdict = { action: 'allow' | 'escalate'; tier: VerdictTier; rule: string; reason: string }

/**
 * 任务自己的执行边界：派活时由人（或项目经理出任务单时）定下来，
 * 审批时先按它判——这比每条审批临时去问模型更准、更快，也可解释。
 */
export type TaskConstraints = {
  /** 允许改的子目录（相对工作目录）；空 = 整个工作目录。声明了就收窄，不只放行 */
  paths: string[]
  /** 联网与装依赖 */
  net: boolean
  /** 推远端 */
  push: boolean
  /** 跑项目里的自定义脚本（sh / node / npm run xxx） */
  scripts: boolean
  /** 一句话边界说明，直接拼进执行端的系统提示 */
  note: string
}

export const NO_CONSTRAINTS: TaskConstraints = { paths: [], net: false, push: false, scripts: false, note: '' }

/**
 * 规则表版本：判定逻辑（DANGEROUS / SENSITIVE / 各命令分类）有实质变化时必须手动递增。
 * 签署 Mandate 时写进快照，事后才能回答「当时按哪一版规则判的」。
 */
export const RULESET_VERSION = 'referee-2026-11'

/**
 * 冻结进 Mandate 的完整授权范围：在任务边界之上多了命令类、CLI 工具白名单、最长运行时间。
 * 目录声明只是提示，不是安全隔离——真正的约束来自 CLI 白名单与 sandbox。
 */
export type MandateScope = TaskConstraints & {
  /** 允许的命令类（read | test | build | write）；空 = 沿用本文件的规则表 */
  commands: string[]
  /** 下发给 CLI 的工具白名单（如 Read、Edit、Bash(npm test:*)） */
  allowedTools: string[]
  /** 单任务最长运行分钟数（本期只存储并随 run.start 下发，执行器暂不强制） */
  maxRuntimeMin: number
}

export const MAX_SCOPE_ITEMS = 40
export const DEFAULT_MAX_RUNTIME_MIN = 30
export const MAX_RUNTIME_MIN_CAP = 24 * 60
export const MANDATE_COMMAND_CLASSES = ['read', 'test', 'build', 'write'] as const

export const MAX_CONSTRAINT_PATHS = 12
export const MAX_CONSTRAINT_NOTE = 400

/** 从数据库 jsonb 或界面表单里读出一份干净的边界。看不懂的一律当没声明。 */
export function normalizeConstraints(v: unknown): TaskConstraints {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
  const raw = Array.isArray(o.paths) ? o.paths.filter((p): p is string => typeof p === 'string') : []
  const paths = raw
    .map(p => p.replaceAll('\0', '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''))
    // 边界只能是工作目录内的相对路径：绝对路径、跨盘、`..` 逃逸都不接受
    .filter(p => p && p !== '.' && !p.startsWith('/') && !p.startsWith('..') && !/^[a-zA-Z]:/.test(p))
    .slice(0, MAX_CONSTRAINT_PATHS)
  return {
    paths: [...new Set(paths)],
    net: o.net === true,
    push: o.push === true,
    scripts: o.scripts === true,
    note: typeof o.note === 'string' ? o.note.replaceAll('\0', '').trim().slice(0, MAX_CONSTRAINT_NOTE) : '',
  }
}

/** 清洗 Mandate 范围：沿用边界的清洗语义，看不懂的一律当没声明 */
export function normalizeScope(v: unknown): MandateScope {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
  const list = (x: unknown, max: number, keep: (s: string) => boolean = () => true): string[] =>
    Array.isArray(x)
      ? [...new Set(x.filter((s): s is string => typeof s === 'string').map(s => s.replaceAll('\0', '').trim().slice(0, max)).filter(s => s && keep(s)))].slice(0, MAX_SCOPE_ITEMS)
      : []
  const minutes = typeof o.maxRuntimeMin === 'number' && Number.isFinite(o.maxRuntimeMin) && o.maxRuntimeMin >= 1
    ? Math.min(Math.floor(o.maxRuntimeMin), MAX_RUNTIME_MIN_CAP)
    : DEFAULT_MAX_RUNTIME_MIN
  return {
    ...normalizeConstraints(v),
    commands: list(o.commands, 20, s => (MANDATE_COMMAND_CLASSES as readonly string[]).includes(s)),
    allowedTools: list(o.allowedTools, 200),
    maxRuntimeMin: minutes,
  }
}

export const hasConstraints = (c: TaskConstraints): boolean =>
  c.paths.length > 0 || c.net || c.push || c.scripts || !!c.note

/** 拼给执行端看的一段边界：写进系统提示，让 agent 一开始就知道自己能做什么 */
export function boundaryLine(c: TaskConstraints): string {
  if (!hasConstraints(c)) return ''
  const items = [
    c.paths.length ? `只能改 ${c.paths.join('、')}，其余目录要停下来问人` : '可改整个工作目录',
    c.net ? '允许联网与装依赖' : '不要联网、不要装新依赖',
    c.push ? '允许推远端' : '不要推远端',
    c.scripts ? '允许跑项目里的自定义脚本' : '不要跑自定义脚本',
  ]
  return `【本次边界】${items.join('；')}${c.note ? `\n补充：${c.note}` : ''}`
}

const allow = (rule: string, reason: string): Verdict => ({ action: 'allow', tier: 'allow', rule, reason })
/** 硬红线：上下文不能让它变安全 */
const danger = (rule: string, reason: string): Verdict => ({ action: 'escalate', tier: 'danger', rule, reason })
/** 灰色地带：风险取决于项目现状和任务意图，有上下文才能判 */
const gray = (rule: string, reason: string): Verdict => ({ action: 'escalate', tier: 'gray', rule, reason })
/** 规则看不懂：不要把解释权交给机器 */
const unsure = (rule: string, reason: string): Verdict => ({ action: 'escalate', tier: 'unknown', rule, reason })

/** 把路径统一成可比较的形式：反斜杠转正斜杠、消掉 . 和 ..、去掉尾部斜杠 */
const norm = (p: string): string => {
  const s = p.replace(/\\/g, '/')
  const out: string[] = []
  for (const part of s.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      out.pop()
      continue
    }
    out.push(part)
  }
  return (s.startsWith('/') ? '/' : '') + out.join('/')
}
const inside = (root: string, p: string): boolean => {
  const r = norm(root).toLowerCase(), t = norm(p).toLowerCase()
  return !!r && (t === r || t.startsWith(`${r}/`))
}
const isAbsolute = (p: string): boolean => /^([a-zA-Z]:\/|\/)/.test(p)

/**
 * 任务边界声明了具体目录时：落在里面的才算「本来就是该改的」。
 * 没声明 = 不收窄，由全局策略说了算。
 */
function outsideGrants(grants: TaskConstraints, cwd: string, p: string): boolean {
  if (!grants.paths.length) return false
  return !grants.paths.some(g => {
    const gp = resolvePath(g, cwd)
    return !!gp && inside(gp, p)
  })
}

/** 相对路径按当前目录展开；`~` 之类展不开的一律当作「不确定」返回空串 */
function resolvePath(p: string, cwd: string): string {
  const t = norm(p.trim())
  if (!t) return ''
  if (t.startsWith('~') || t.startsWith('$')) return ''
  if (isAbsolute(t)) return t
  return `${norm(cwd)}/${t}`.replace(/\/\.\//g, '/')
}

/** 敏感文件：读到或写到都要人看一眼，凭据泄露和误改都不可逆 */
const SENSITIVE = [
  /(^|\/)\.env(\.[^/]*)?$/i,
  /(^|\/)\.env\.(local|production|development)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/i,
  /(^|\/)\.ssh\//i,
  /(^|\/)\.(aws|kube|gnupg)\//i,
  /(^|\/)(credentials|\.netrc|\.npmrc|\.pypirc)$/i,
  /\.(pem|key|p12|pfx)$/i,
]

export function isSensitive(p: string): boolean {
  return SENSITIVE.some(re => re.test(norm(p)))
}

/** 危险操作：命中就交给人。宁可多问，不可猜错。 */
const DANGEROUS: [RegExp, string][] = [
  [/\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)?/i, 'rm'],
  // 普通 push 是灰色地带（任务可能就是要推），改写远端历史才是硬红线
  [/\bgit\s+push\b[^;|&]*(--force|-f)\b/i, '强推远端'],
  [/\bgit\s+reset\s+--hard\b/i, '丢弃未提交改动'],
  [/\bgit\s+clean\s+-[a-zA-Z]*[fd]/i, '清理未跟踪文件'],
  [/\bgit\s+checkout\s+--\s/i, '覆盖工作区文件'],
  [/\bgit\s+(filter-branch|update-ref)\b/i, '改写历史'],
  [/\b(drop|truncate)\s+(table|database|schema)\b/i, '删库'],
  [/\b(npm|pnpm|yarn|cargo|twine)\s+publish\b/i, '发布包'],
  [/\bcurl\b[^|]*\|\s*(ba|z)?sh\b/i, '下载即执行'],
  [/\bwget\b[^|]*\|\s*(ba|z)?sh\b/i, '下载即执行'],
  [/\bsudo\b|\bdoas\b/i, '提权'],
  [/\b(chmod|chown)\s+(-R\s+)?(777|000)/i, '放开权限'],
  [/\b(shutdown|reboot|halt|mkfs|diskpart|format)\b/i, '系统级操作'],
  [/>\s*\/dev\/(sd|nvme|disk)/i, '写裸设备'],
  [/\b(base64|openssl)\b[^|]*-d[^|]*\|\s*(ba)?sh/i, '解码执行'],
]

/** 按 shell 分隔符拆段：`a && b`、`a | b`、`a; b` 各段单独判断，任一段危险整条就交给人 */
export function shellSegments(cmd: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '\\') {
      cur += ch + (cmd[i + 1] ?? '')
      i++
      continue
    }
    // 2>&1 这类重定向不是分隔符：& 后面跟数字时保留
    if (ch === '&' && /\d/.test(cmd[i + 1] ?? '')) {
      cur += ch
      continue
    }
    if ((ch === '&' && cmd[i + 1] === '&') || (ch === '|' && cmd[i + 1] === '|')) {
      out.push(cur)
      cur = ''
      i++
      continue
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n') {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out.map(s => s.trim()).filter(Boolean)
}

/** 段的首个命令词；跳过前置的环境变量赋值和路径前缀 */
export function firstWord(seg: string): string {
  const toks = seg.trim().split(/\s+/).filter(Boolean)
  let i = 0
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++
  const w = toks[i] ?? ''
  return w.replace(/^["']|["']$/g, '').replace(/^.*[\\/]/, '').toLowerCase()
}

function argsOf(seg: string): string[] {
  const toks = seg.trim().split(/\s+/).filter(Boolean)
  let i = 0
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++
  return toks.slice(i).map(t => t.replace(/^["']|["']$/g, ''))
}

/** 段里的输出重定向目标（`> a`、`>> a`、`2> a`） */
function redirectTargets(seg: string): string[] {
  const out: string[] = []
  const re = /\d?>>?\s*([^\s;&|]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(seg))) if (m[1] && !m[1].startsWith('&')) out.push(m[1])
  return out
}

const READ_CMDS = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'ag', 'find', 'fd', 'file', 'stat',
  'du', 'df', 'tree', 'which', 'whereis', 'echo', 'printf', 'sort', 'uniq', 'cut', 'tr',
  'basename', 'dirname', 'realpath', 'jq', 'date', 'whoami', 'uname', 'diff', 'cmp', 'less',
  'more', 'type', 'nl', 'column', 'xxd', 'md5sum', 'sha256sum',
])
const GIT_READ = new Set([
  'status', 'diff', 'log', 'show', 'branch', 'remote', 'rev-parse', 'ls-files', 'blame',
  'describe', 'shortlog', 'reflog', 'config', 'tag', 'stash', 'worktree', 'grep', 'show-ref',
])
const GIT_WRITE = new Set(['add', 'commit', 'checkout', 'switch', 'restore', 'merge', 'rebase', 'cherry-pick', 'rm', 'mv', 'apply', 'reset', 'stash', 'tag'])
const SAFE_SCRIPTS = new Set(['test', 'tests', 'lint', 'build', 'typecheck', 'type-check', 'check', 'coverage', 'format', 'fmt'])
const TEST_CMDS = new Set(['vitest', 'jest', 'mocha', 'pytest', 'tsc', 'eslint', 'prettier', 'biome', 'ruff', 'mypy', 'phpunit'])
const PKG = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx', 'pnpx'])
const NET_CMDS = new Set(['curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'telnet', 'ftp', 'ping'])
const WRITE_CMDS = new Set(['mkdir', 'touch', 'cp', 'mv', 'tee', 'ln', 'install', 'truncate', 'patch'])
const SHELL_CMDS = new Set(['sh', 'bash', 'zsh', 'fish', 'pwsh', 'powershell', 'cmd', 'node', 'python', 'python3', 'deno', 'ruby', 'perl', 'php', 'make', 'sed', 'awk', 'xargs', 'eval'])
/** find 本身只读，带上这些参数就等于执行任意命令 */
const FIND_EXEC = /\s-(exec|execdir|ok|okdir|delete|fprint0?)\b/
/** 纯内部状态，不碰文件系统也不联网 */
const HARMLESS_TOOLS = new Set(['todowrite', 'todostore', 'taskcreate', 'taskupdate', 'tasklist', 'exitplanmode', 'notebookread'])

export type ToolKind = 'ask' | 'command' | 'write' | 'read' | 'network' | 'harmless' | 'unknown'

export function toolKind(tool: string): ToolKind {
  const t = tool.trim().toLowerCase()
  if (!t) return 'unknown'
  if (t === 'userinput') return 'ask'
  if (['bash', 'command', 'shell', 'shell_command', 'exec', 'execute', 'run_command'].includes(t)) return 'command'
  if (['write', 'edit', 'multiedit', 'notebookedit', 'filechange', 'apply_patch', 'applypatch', 'str_replace_editor', 'create_file'].includes(t)) return 'write'
  if (['read', 'grep', 'glob', 'ls', 'list', 'listdir', 'search', 'view'].includes(t)) return 'read'
  if (['webfetch', 'websearch', 'fetch', 'browser', 'browse'].includes(t)) return 'network'
  if (HARMLESS_TOOLS.has(t)) return 'harmless'
  // MCP 工具能做任何事，不代批
  return 'unknown'
}

/** 从 detail 里捞出路径：Claude 的 Write 是「路径\n内容」，Codex 是每行一个文件，ZCode 是 JSON */
export function detailPaths(tool: string, detail: string): string[] {
  const text = detail.trim()
  if (!text) return []
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const v = JSON.parse(text) as Record<string, unknown>
      const one = (x: unknown): string[] => (typeof x === 'string' ? [x] : [])
      const keys = ['file_path', 'filePath', 'path', 'notebook_path', 'target_file', 'file']
      for (const k of keys) if (typeof v[k] === 'string') return one(v[k])
      // ZCode / 某些 MCP：input 里嵌一层
      if (v.input && typeof v.input === 'object') return detailPaths(tool, JSON.stringify(v.input))
    } catch {
      // 落到下面的按行解析
    }
  }
  // 只有 Codex 的 fileChange 是「每行一个文件」；Claude 的 Write/Edit 是「路径\n内容」，
  // 只取第一行，否则内容里的任意一行都会被当成路径去判越界
  if (toolKind(tool) === 'write') {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
    const t = tool.trim().toLowerCase()
    return t === 'filechange' || t === 'apply_patch' || t === 'applypatch' ? lines : lines.slice(0, 1)
  }
  // 读取类工具的 detail 就是一个路径
  if (toolKind(tool) === 'read') return [text]
  return []
}

/** git 子命令：跳过 -C <dir>、-c k=v 这类全局选项 */
function gitSub(args: string[]): string {
  let i = 1
  while (i < args.length && args[i].startsWith('-')) {
    i += args[i] === '-C' || args[i] === '-c' ? 2 : 1
  }
  return (args[i] ?? '').toLowerCase()
}

/** 判一段命令。返回 null 表示「只读且安全」 */
function judgeSegment(seg: string, cwd: string, policy: RefereePolicy, grants: TaskConstraints): Verdict | null {
  // 写入位置越界：不管写什么命令，只要重定向到项目外就交给人
  for (const target of redirectTargets(seg)) {
    const p = resolvePath(target, cwd)
    if (!p || !inside(cwd, p)) return danger('redirect-outside', `输出到项目外：${target}`)
    if (isSensitive(p)) return danger('sensitive', `写入敏感文件：${target}`)
    if (outsideGrants(grants, cwd, p)) return gray('write-guard', `输出到任务边界外：${target}`)
  }

  for (const [re, label] of DANGEROUS) {
    if (re.test(seg)) return danger('dangerous', `危险操作（${label}），交给人确认`)
  }

  // 参数里出现敏感文件的路径形态（cat ~/.ssh/id_rsa、cp .env /tmp）：读也不该代批
  for (const tok of seg.split(/\s+/)) {
    if (!/[/~]/.test(tok)) continue
    if (isSensitive(tok)) return danger('sensitive', `涉及敏感文件：${tok}`)
  }

  const word = firstWord(seg)
  const args = argsOf(seg)
  if (!word) return null

  if (word === 'find' && FIND_EXEC.test(seg)) return unsure('arbitrary', 'find 带执行参数，等于跑任意命令')

  // cd 会改变后续段的相对路径语义：只允许进项目内，并据此更新 cwd
  if (word === 'cd') {
    // 出了项目，后面的相对路径就没有参照系了，规则跟不上
    const target = args[1] ?? ''
    if (!target || target === '-') return unsure('cd-unknown', '切换目录，路径不确定')
    const p = resolvePath(target, cwd)
    if (!p || !inside(cwd, p)) return unsure('cd-outside', `切到项目外：${target}`)
    return null
  }

  if (word === 'git') {
    const sub = gitSub(args)
    if (!sub) return allow('git-read', 'git 无操作')
    // 推远端：这个任务可能本来就要推（边界里声明过），否则让人判断该不该上去
    if (sub === 'push') {
      return grants.push
        ? allow('task-push', '推远端（任务边界内已授权）')
        : gray('push', '推远端，需要人确认这次改动该不该上去')
    }
    if (sub === 'stash') {
      const action = (args[2] ?? '').toLowerCase()
      if (!action || action === 'list' || action === 'show') return allow('git-read', '查看 stash')
      return policy.allowWrite ? allow('git-write', '项目内改动 stash') : gray('write-off', '写操作，但没开写权限')
    }
    if (GIT_READ.has(sub)) return allow('git-read', `只读：git ${sub}`)
    if (GIT_WRITE.has(sub)) {
      return policy.allowWrite ? allow('git-write', `项目内改动：git ${sub}`) : gray('write-off', '写操作，但没开写权限')
    }
    return unsure('git-unknown', `不认识的 git 子命令：${sub}`)
  }

  if (word === 'go' || word === 'cargo' || word === 'dotnet' || word === 'mvn' || word === 'gradle') {
    const sub = (args[1] ?? '').toLowerCase()
    if (['build', 'test', 'check', 'clippy', 'fmt', 'vet', 'run'].includes(sub)) {
      return policy.allowTests ? allow('tests', `构建/测试：${word} ${sub}`) : gray('tests-off', '构建测试，但没开测试权限')
    }
    if (sub === 'get' || sub === 'add' || sub === 'install') {
      return grants.net || policy.allowNetwork
        ? allow('network', `装依赖：${word} ${sub}`)
        : gray('network-off', '联网装包，需要人确认')
    }
    return unsure('build-unknown', `不认识的 ${word} 子命令：${sub}`)
  }

  if (PKG.has(word)) {
    const sub = (args[1] ?? '').toLowerCase()
    // npx / pnpx 直接跑某个工具：认识的安全工具才放行
    if (word === 'npx' || word === 'pnpx') {
      if (TEST_CMDS.has(sub)) return policy.allowTests ? allow('tests', `测试/检查：${word} ${sub}`) : gray('tests-off', '测试检查，但没开测试权限')
      return unsure('npx-unknown', `npx 跑未知工具：${sub || '（空）'}`)
    }
    if (['ls', 'list', 'view', 'info', 'outdated', 'why', 'root', 'prefix'].includes(sub)) {
      return allow('read', `查看依赖：${word} ${sub}`)
    }
    if (['test', 't', 'build', 'lint', 'typecheck', 'type-check', 'check', 'format', 'fmt', 'run', 'start'].includes(sub)) {
      // npm run xxx：只有已知的安全脚本才放行，任意脚本可能是任意命令
      const script = sub === 'run' || sub === 'start' ? (args[2] ?? '').toLowerCase() : sub
      if (!script || SAFE_SCRIPTS.has(script)) {
        return policy.allowTests ? allow('tests', `测试/构建：${word} ${args.slice(1, 3).join(' ')}`) : gray('tests-off', '构建测试，但没开测试权限')
      }
      // 项目自己的脚本内容不可预判，但「这个项目这一步该不该跑」是上下文问题
      return grants.scripts
        ? allow('task-script', `跑项目脚本（任务边界内）：${word} run ${script}`)
        : gray('script-unknown', `项目自定义脚本：${word} run ${script}，需要人确认`)
    }
    if (['install', 'i', 'add', 'update', 'upgrade', 'ci', 'create', 'exec', 'dlx'].includes(sub)) {
      return grants.net || policy.allowNetwork
        ? allow('network', `装依赖：${word} ${sub}`)
        : gray('network-off', '联网装包，需要人确认')
    }
    return unsure('pkg-unknown', `不认识的包管理器子命令：${word} ${sub}`)
  }

  if (TEST_CMDS.has(word)) {
    return policy.allowTests ? allow('tests', `测试/检查：${word}`) : gray('tests-off', '测试检查，但没开测试权限')
  }
  if (NET_CMDS.has(word)) {
    if (grants.net) return allow('task-net', `联网（任务边界内已授权）：${word}`)
    return policy.allowNetwork ? allow('network', `联网：${word}`) : gray('network-off', '联网操作，需要人确认')
  }
  if (WRITE_CMDS.has(word)) {
    // 目标路径逐个查：cp a b、mkdir -p x 都取非选项参数
    const targets = args.slice(1).filter(a => !a.startsWith('-'))
    for (const t of targets) {
      const p = resolvePath(t, cwd)
      // 越界和敏感是硬红线，先查；再看是不是落在任务声明过的边界内
      if (!p || !inside(cwd, p)) return danger('write-outside', `写到项目外：${t}`)
      if (isSensitive(p)) return danger('sensitive', `写入敏感文件：${t}`)
      if (outsideGrants(grants, cwd, p)) return gray('write-guard', `写到任务边界外：${t}`)
    }
    // 边界里明确列了目录 = 派活时就授权了写；否则按全局开关
    if (!grants.paths.length && !policy.allowWrite) return gray('write-off', '写操作，但没开写权限')
    return allow('write-inside', `项目内写：${word}`)
  }
  if (SHELL_CMDS.has(word)) {
    return grants.scripts
      ? allow('task-script', `跑脚本（任务边界内已授权）：${word}`)
      : unsure('arbitrary', `执行脚本（${word}），内容不可预判`)
  }
  if (READ_CMDS.has(word)) return allow('read', `只读：${word}`)

  return unsure('unknown-cmd', `不认识的命令：${word}`)
}

/** 命令整条判断：任一段危险就交给人，全部安全才放行 */
export function judgeCommand(cmd: string, cwd: string, policy: RefereePolicy, grants: TaskConstraints = NO_CONSTRAINTS): Verdict {
  const segs = shellSegments(cmd)
  if (!segs.length) return unsure('empty', '命令为空')
  let dir = cwd
  let last: Verdict = allow('read', '只读命令')
  for (const seg of segs) {
    const v = judgeSegment(seg, dir, policy, grants)
    // cd 已经校验过在项目内，后续相对路径按新目录算
    if (v === null && firstWord(seg) === 'cd') {
      const target = argsOf(seg)[1] ?? ''
      const p = resolvePath(target, dir)
      if (p) dir = p
      continue
    }
    if (v === null) continue
    if (v.action === 'escalate') return v
    last = v
  }
  return last
}

/**
 * 总入口。判不了的一律 escalate，交回给人，不做兜底放行。
 * grants 是这条会话所属任务自己声明的执行边界，比全局策略更具体，优先按它判。
 */
export function judgeApproval(input: {
  tool: string
  detail: string
  cwd: string
  policy: RefereePolicy
  grants?: TaskConstraints
}): Verdict {
  const { tool, detail, cwd, policy } = input
  const grants = input.grants ?? NO_CONSTRAINTS
  if (!policy.enabled) return unsure('off', '项目经理代批未开启')
  if (!cwd.trim()) return unsure('no-cwd', '这个会话没有工作目录，无法判断边界')

  const kind = toolKind(tool)

  // 提问是需求判断，不是权限问题：机器猜错比慢一点代价大得多
  if (kind === 'ask') return unsure('ask', 'agent 在向你提问，需要人来定')
  if (kind === 'harmless') return allow('harmless', '内部状态操作')

  if (kind === 'command') return judgeCommand(detail, cwd, policy, grants)

  if (kind === 'write') {
    const paths = detailPaths(tool, detail)
    if (!paths.length) return unsure('write-unknown', '看不到要写哪个文件')
    for (const raw of paths) {
      const p = resolvePath(raw, cwd)
      if (!p) return unsure('write-unknown', `路径不确定：${raw}`)
      // 敏感文件和越界是硬红线：先判，再谈权限开没开
      if (isSensitive(p)) return danger('sensitive', `写入敏感文件：${raw}`)
      if (!inside(cwd, p)) return danger('write-outside', `写到项目外：${raw}`)
      if (outsideGrants(grants, cwd, p)) return gray('write-guard', `写到任务边界外：${raw}`)
    }
    if (!grants.paths.length && !policy.allowWrite) return gray('write-off', '写文件，但没开写权限')
    return allow('write-inside', `项目内写：${paths[0]}${paths.length > 1 ? ` 等 ${paths.length} 个` : ''}`)
  }

  if (kind === 'read') {
    if (!policy.allowRead) return gray('read-off', '只读操作，但没开只读权限')
    // 只读也可能读凭据：detail 本身就是路径
    for (const raw of detailPaths(tool, detail)) {
      if (isSensitive(raw)) return danger('sensitive', `读取敏感文件：${raw}`)
    }
    return allow('read', `只读：${tool}`)
  }

  if (kind === 'network') {
    if (grants.net) return allow('task-net', `联网（任务边界内已授权）：${tool}`)
    return policy.allowNetwork ? allow('network', `联网：${tool}`) : gray('network-off', '联网操作，需要人确认')
  }

  return unsure('unknown-tool', `不熟悉的工具：${tool}`)
}

/** 给界面用的一句话：为什么被自动放行 / 为什么交给人 */
export function verdictLabel(rule: string): string {
  const map: Record<string, string> = {
    off: '代批未开启',
    ask: '提问交给人',
    'read': '只读操作',
    harmless: '内部状态',
    'write-inside': '项目内写文件',
    'write-guard': '任务边界外',
    'git-read': '只看不改',
    'git-write': '项目内无关紧要的改动',
    'task-net': '任务已授权联网',
    'task-push': '任务已授权推远端',
    'task-script': '任务已授权跑脚本',
    'tests': '测试与构建',
    network: '联网（已授权）',
    push: '推远端',
    dangerous: '危险操作',
    sensitive: '敏感文件',
    'write-outside': '越界写',
    'redirect-outside': '越界输出',
    'network-off': '联网未授权',
    'write-off': '写权限未开',
    'read-off': '只读权限未开',
    'tests-off': '测试权限未开',
    'script-unknown': '项目自定义脚本',
    arbitrary: '执行脚本',
    'unknown-tool': '不熟悉的工具',
    'unknown-cmd': '不认识的命令',
  }
  return map[rule] ?? rule
}

/** 层级标签：告诉人这条为什么停下来，以及将来谁该判 */
export function tierLabel(tier: VerdictTier): string {
  const map: Record<VerdictTier, string> = {
    allow: '规则放行',
    danger: '硬红线，必须人看',
    gray: '边界外，看上下文',
    unknown: '规则看不懂',
  }
  return map[tier]
}

/** 审批记录的裁决来源：人点的还是项目经理代批的，事后要能分清 */
export async function migrateReferee(db: Pick<pg.Pool, 'query'>) {
  await db.query("ALTER TABLE approvals ADD COLUMN IF NOT EXISTS decided_by text NOT NULL DEFAULT 'user'")
  await db.query("ALTER TABLE approvals ADD COLUMN IF NOT EXISTS decision_rule text NOT NULL DEFAULT ''")
  await db.query("ALTER TABLE approvals ADD COLUMN IF NOT EXISTS decision_reason text NOT NULL DEFAULT ''")
  // 裁决层级：pending 时是「为什么轮不到规则定」，decided 时是「凭什么放的」
  await db.query("ALTER TABLE approvals ADD COLUMN IF NOT EXISTS decision_tier text NOT NULL DEFAULT ''")
  await db.query('CREATE INDEX IF NOT EXISTS idx_approvals_auto ON approvals(user_id, decided_by, decided_at DESC)')
}
