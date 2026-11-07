import type pg from 'pg'
import { TaskError } from './tasks.ts'

// 通知两级过滤管线（思路来自 DeepSeek Super-agent 的事件过滤：程序规则做 Fast Path，
// 语义判断做 Slow Path）。本模块实现 Fast Path：agent 静音、免打扰时段、最低优先级门槛，
// 并为 Slow Path 预留 setSemanticFilter 接缝（当前默认不启用，接 LLM 判断时无需改调用方）。
//
// 硬性规则：审批（approval）与等待授权（waiting）永远放行——审批 30 分钟无人处理会按
// 拒绝处理，会话会卡住，任何规则都不允许把它们静音。

export const AGENT_KEYS = ['claude', 'codex', 'doubao', 'workbuddy', 'zcode', 'codebuddy'] as const
export type AgentKey = (typeof AGENT_KEYS)[number]
export type Priority = 'high' | 'medium' | 'low'
export type NotifyKind = 'done' | 'aborted' | 'reminder'
export const NOTIFY_KINDS: readonly NotifyKind[] = ['done', 'aborted', 'reminder']
export type QuietSettings = { enabled: boolean; start: string; end: string; tzOffsetMinutes: number; muteKinds: NotifyKind[] }
export type NotifySettings = { agents: Record<AgentKey, boolean>; minPriority: Priority; quiet: QuietSettings }

export type NotifyEvent =
  | { kind: 'session'; agent: AgentKey; state: 'done' | 'aborted' | 'waiting'; sessionId: string }
  | { kind: 'approval' }
  | { kind: 'reminder'; entityType: 'task' | 'goal'; entityId: number }

type DB = Pick<pg.Pool, 'query'>

export const PRIORITY_RANK: Record<Priority, number> = { low: 0, medium: 1, high: 2 }

export const DEFAULT_SETTINGS: NotifySettings = {
  agents: { claude: true, codex: true, doubao: true, workbuddy: true, zcode: true, codebuddy: true },
  minPriority: 'low',
  quiet: { enabled: false, start: '22:00', end: '08:00', tzOffsetMinutes: 480, muteKinds: ['done'] },
}

export async function migrateNotify(db: DB) {
  await db.query(`CREATE TABLE IF NOT EXISTS notify_settings (
    user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now())`)
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
const isTime = (v: unknown): v is string => typeof v === 'string' && TIME_RE.test(v)

// 深校验补丁并合并到 base 上，返回规范化后的完整设置；非法字段抛 TaskError(400)
export function normalizeSettings(patch: unknown, base: NotifySettings): NotifySettings {
  if (patch === undefined || patch === null) return base
  if (typeof patch !== 'object' || Array.isArray(patch)) throw new TaskError('通知设置必须是对象')
  const p = patch as Record<string, unknown>
  const out: NotifySettings = JSON.parse(JSON.stringify(base))
  for (const k of Object.keys(p)) if (!['agents', 'minPriority', 'quiet'].includes(k)) throw new TaskError(`未知的设置字段：${k}`)
  if ('agents' in p) {
    const a = p.agents
    if (typeof a !== 'object' || a === null || Array.isArray(a)) throw new TaskError('agents 必须是对象')
    for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
      if (!(AGENT_KEYS as readonly string[]).includes(k)) throw new TaskError(`未知的 agent：${k}`)
      if (typeof v !== 'boolean') throw new TaskError('agent 开关必须是布尔值')
      out.agents[k as AgentKey] = v
    }
  }
  if ('minPriority' in p) {
    if (!['high', 'medium', 'low'].includes(p.minPriority as string)) throw new TaskError('优先级不合法')
    out.minPriority = p.minPriority as Priority
  }
  if ('quiet' in p) {
    const o = p.quiet
    if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new TaskError('quiet 必须是对象')
    const q = o as Record<string, unknown>
    for (const k of Object.keys(q)) if (!['enabled', 'start', 'end', 'tzOffsetMinutes', 'muteKinds'].includes(k)) throw new TaskError(`未知的免打扰字段：${k}`)
    if ('enabled' in q) {
      if (typeof q.enabled !== 'boolean') throw new TaskError('免打扰开关必须是布尔值')
      out.quiet.enabled = q.enabled
    }
    for (const k of ['start', 'end'] as const) if (k in q) {
      if (!isTime(q[k])) throw new TaskError('免打扰时间须为 HH:MM')
      out.quiet[k] = q[k] as string
    }
    if ('tzOffsetMinutes' in q) {
      if (typeof q.tzOffsetMinutes !== 'number' || !Number.isInteger(q.tzOffsetMinutes) || q.tzOffsetMinutes < -840 || q.tzOffsetMinutes > 840) throw new TaskError('时区偏移不合法')
      out.quiet.tzOffsetMinutes = q.tzOffsetMinutes
    }
    if ('muteKinds' in q) {
      const m = q.muteKinds
      if (!Array.isArray(m) || m.some(k => !(NOTIFY_KINDS as readonly string[]).includes(k as string))) throw new TaskError('免打扰类型不合法')
      out.quiet.muteKinds = [...new Set(m as NotifyKind[])]
    }
  }
  return out
}

export async function getSettings(db: DB, userId: number): Promise<NotifySettings> {
  const r = await db.query<{ data: unknown }>('SELECT data FROM notify_settings WHERE user_id=$1', [userId])
  return normalizeSettings(r.rows[0]?.data ?? {}, DEFAULT_SETTINGS)
}

export async function saveSettings(db: DB, userId: number, patch: unknown): Promise<NotifySettings> {
  const next = normalizeSettings(patch ?? {}, await getSettings(db, userId))
  await db.query(
    `INSERT INTO notify_settings(user_id, data, updated_at) VALUES($1,$2,now())
     ON CONFLICT (user_id) DO UPDATE SET data=$2, updated_at=now()`,
    [userId, JSON.stringify(next)],
  )
  return next
}

// 判断 now 是否落在免打扰窗口内（按用户本地时间）。start===end 视为全天静音
export function inQuietWindow(now: Date, q: QuietSettings): boolean {
  const minuteOfDay = Math.floor(((((now.getTime() + q.tzOffsetMinutes * 60_000) % 86_400_000) + 86_400_000) % 86_400_000) / 60_000)
  const s = Number(q.start.slice(0, 2)) * 60 + Number(q.start.slice(3))
  const e = Number(q.end.slice(0, 2)) * 60 + Number(q.end.slice(3))
  if (s === e) return true
  return s < e ? minuteOfDay >= s && minuteOfDay < e : minuteOfDay >= s || minuteOfDay < e
}

// 会话事件的有效优先级：取所有关联任务里最高的优先级；没关联任务按 medium
async function sessionPriority(db: DB, userId: number, sessionId: string): Promise<Priority> {
  const r = await db.query<{ priority: Priority }>(
    'SELECT t.priority FROM task_sessions ts JOIN tasks t ON t.user_id=ts.user_id AND t.id=ts.task_id WHERE ts.user_id=$1 AND ts.session_id=$2',
    [userId, sessionId],
  )
  let best: Priority = 'medium'
  for (const row of r.rows) if (PRIORITY_RANK[row.priority] > PRIORITY_RANK[best]) best = row.priority
  return best
}

async function entityPriority(db: DB, userId: number, entityType: 'task' | 'goal', entityId: number): Promise<Priority> {
  const r = await db.query<{ priority: Priority }>(
    `SELECT priority FROM ${entityType === 'task' ? 'tasks' : 'goals'} WHERE user_id=$1 AND id=$2`,
    [userId, entityId],
  )
  return r.rows[0]?.priority ?? 'medium'
}

// Slow Path 接缝：返回 false = 静音；true / null = 不表态（放行）；抛错按放行处理。
// 将来接 LLM 语义判断时通过 setSemanticFilter 注入，事件量大时只在 Fast Path 全通过后调用。
export type SemanticFilter = (ev: NotifyEvent) => Promise<boolean | null>
let semanticFilter: SemanticFilter | null = null
export function setSemanticFilter(fn: SemanticFilter | null) {
  semanticFilter = fn
}

// Fast Path 评估。只在底层已判定「可通知」的事件上调用；返回 false 表示该事件静音
export async function evaluateNotify(db: DB, userId: number, ev: NotifyEvent): Promise<boolean> {
  if (ev.kind === 'approval') return true
  if (ev.kind === 'session' && ev.state === 'waiting') return true
  const s = await getSettings(db, userId)
  if (ev.kind === 'session' && s.agents[ev.agent] === false) return false
  const nk: NotifyKind | 'waiting' = ev.kind === 'session' ? ev.state : 'reminder'
  if (nk !== 'waiting' && s.quiet.enabled && s.quiet.muteKinds.includes(nk) && inQuietWindow(new Date(), s.quiet)) return false
  if (s.minPriority !== 'low') {
    const p = ev.kind === 'session'
      ? await sessionPriority(db, userId, ev.sessionId)
      : await entityPriority(db, userId, ev.entityType, ev.entityId)
    if (PRIORITY_RANK[p] < PRIORITY_RANK[s.minPriority]) return false
  }
  if (semanticFilter) {
    try {
      if ((await semanticFilter(ev)) === false) return false
    } catch {
      /* 语义层故障不阻塞通知 */
    }
  }
  return true
}
