import pg from 'pg'

export const STATES = ['idle', 'running', 'waiting', 'done', 'aborted', 'ended'] as const
export type State = (typeof STATES)[number]
export const AGENTS = ['claude', 'codex'] as const
export type Agent = (typeof AGENTS)[number]

export type EventIn = {
  agent: Agent
  sessionId: string
  machine: string
  cwd: string
  state: State
  at: string
  title?: string
  summary?: string
  pid?: number | null
  quiet?: boolean
}

export type Session = {
  id: string
  agent: Agent
  machine: string
  cwd: string
  project: string
  title: string
  state: State
  summary: string
  stateSince: string
  acked: boolean
  pid: number | null
  eventAt: string
  updatedAt: string
}

const ALERT_STATES: State[] = ['waiting', 'done', 'aborted']

export function createPool(url: string) {
  return new pg.Pool({ connectionString: url, max: 10 })
}

async function migrateAll(pool: { query: pg.Pool['query'] }) {
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    id text primary key,
    agent text not null,
    machine text not null,
    cwd text not null default '',
    project text not null default '',
    title text not null default '',
    state text not null,
    summary text not null default '',
    state_since timestamptz not null,
    acked boolean not null default true,
    pid integer,
    event_at timestamptz not null,
    updated_at timestamptz not null default now()
  )`)
  await pool.query('CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC)')
  await pool.query(`CREATE TABLE IF NOT EXISTS runs (
    id text primary key,
    session_id text not null,
    machine text not null,
    status text not null,
    error text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`)
  await pool.query('CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, created_at DESC)')
  await pool.query(`CREATE TABLE IF NOT EXISTS messages (
    id bigserial primary key,
    session_id text not null,
    run_id text,
    role text not null,
    text text not null,
    created_at timestamptz not null default now()
  )`)
  await pool.query('CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id)')
  await pool.query(`CREATE TABLE IF NOT EXISTS approvals (
    id text primary key,
    run_id text not null,
    session_id text not null,
    tool text not null,
    detail text not null,
    status text not null,
    created_at timestamptz not null default now(),
    decided_at timestamptz
  )`)
  await pool.query('CREATE INDEX IF NOT EXISTS idx_approvals_session ON approvals(session_id, status)')
}

// 多个进程同时启动（或测试并行）时，CREATE TABLE IF NOT EXISTS 会互相撞，用 advisory lock 串行
export async function migrate(pool: pg.Pool) {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock(727001)')
    await migrateAll(client)
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {})
    client.release()
  }
}

type Row = {
  id: string
  agent: Agent
  machine: string
  cwd: string
  project: string
  title: string
  state: State
  summary: string
  state_since: Date
  acked: boolean
  pid: number | null
  event_at: Date
  updated_at: Date
}

function toSession(r: Row): Session {
  return {
    id: r.id,
    agent: r.agent,
    machine: r.machine,
    cwd: r.cwd,
    project: r.project,
    title: r.title,
    state: r.state,
    summary: r.summary,
    stateSince: r.state_since.toISOString(),
    acked: r.acked,
    pid: r.pid,
    eventAt: r.event_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  }
}

// cwd 最后一段（兼容 / 和 \）
export function projectOf(cwd: string) {
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

export type EventResult = { session: Session; notify: boolean } | null

// 一个事件的状态流转。返回 null 表示被丢弃（乱序旧事件）
export async function applyEvent(pool: pg.Pool, ev: EventIn): Promise<EventResult> {
  const id = `${ev.agent}:${ev.sessionId}`
  const at = new Date(ev.at)
  const cur = (await pool.query<Row>('SELECT * FROM sessions WHERE id = $1', [id])).rows[0]
  if (cur && at.getTime() < cur.event_at.getTime()) return null

  const quiet = ev.quiet === true
  const alert = ALERT_STATES.includes(ev.state)
  let acked: boolean
  if (ev.state === 'running') acked = true
  else if (alert) {
    if (quiet) {
      // 补报历史：done/aborted 直接记为已处理；已经是同一状态时保持库里的已处理标记
      if (cur && cur.state === ev.state) acked = cur.acked
      else acked = ev.state !== 'waiting'
    } else acked = false
  } else acked = cur ? cur.acked : true
  const notify = alert && !quiet
  const stateSince = !cur || cur.state !== ev.state || notify ? at : cur.state_since
  const cwd = ev.cwd || cur?.cwd || ''
  const title = cur?.title || ev.title || ''
  const summary = ev.summary !== undefined && ev.summary !== '' ? ev.summary : ev.state === 'running' ? '' : (cur?.summary ?? '')
  const pid = ev.pid ? ev.pid : (cur?.pid ?? null)
  const row = (
    await pool.query<Row>(
      `INSERT INTO sessions (id, agent, machine, cwd, project, title, state, summary, state_since, acked, pid, event_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
       ON CONFLICT (id) DO UPDATE SET machine=$3, cwd=$4, project=$5, title=$6, state=$7, summary=$8,
         state_since=$9, acked=$10, pid=$11, event_at=$12, updated_at=now()
       RETURNING *`,
      [id, ev.agent, ev.machine, cwd, projectOf(cwd), title, ev.state, summary.slice(0, 300), stateSince, acked, pid, at],
    )
  ).rows[0]
  return { session: toSession(row), notify }
}

export async function listSessions(pool: pg.Pool, all: boolean): Promise<Session[]> {
  const where = all ? '' : "WHERE state <> 'ended' AND updated_at > now() - interval '24 hours'"
  const r = await pool.query<Row>(`SELECT * FROM sessions ${where} ORDER BY updated_at DESC`)
  return r.rows.map(toSession)
}

export async function ackSession(pool: pg.Pool, id: string): Promise<Session | null> {
  const r = await pool.query<Row>('UPDATE sessions SET acked = true WHERE id = $1 RETURNING *', [id])
  return r.rows[0] ? toSession(r.rows[0]) : null
}

export async function ackAll(pool: pg.Pool): Promise<Session[]> {
  const r = await pool.query<Row>('UPDATE sessions SET acked = true WHERE acked = false RETURNING *')
  return r.rows.map(toSession)
}

export async function removeSession(pool: pg.Pool, id: string): Promise<boolean> {
  const r = await pool.query('DELETE FROM sessions WHERE id = $1', [id])
  await pool.query('DELETE FROM messages WHERE session_id = $1', [id])
  await pool.query('DELETE FROM approvals WHERE session_id = $1', [id])
  await pool.query('DELETE FROM runs WHERE session_id = $1', [id])
  return (r.rowCount ?? 0) > 0
}

export async function purgeOld(pool: pg.Pool): Promise<number> {
  const r = await pool.query("DELETE FROM sessions WHERE updated_at < now() - interval '7 days'")
  await pool.query("DELETE FROM runs WHERE updated_at < now() - interval '7 days'")
  await pool.query("DELETE FROM approvals WHERE created_at < now() - interval '7 days'")
  return r.rowCount ?? 0
}

export async function getSession(pool: pg.Pool, id: string): Promise<Session | null> {
  const r = await pool.query<Row>('SELECT * FROM sessions WHERE id = $1', [id])
  return r.rows[0] ? toSession(r.rows[0]) : null
}

// ---------- 远程控制：runs / messages / approvals ----------

export const RUN_STATUSES = ['queued', 'running', 'done', 'failed', 'stopped'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]
export const MESSAGE_ROLES = ['user', 'assistant', 'tool', 'approval', 'system'] as const
export type MessageRole = (typeof MESSAGE_ROLES)[number]
export const KEEP_MESSAGES = 200

export type Run = { id: string; sessionId: string; machine: string; status: RunStatus; error: string; createdAt: string; updatedAt: string }
export type Message = { id: number; sessionId: string; runId: string | null; role: MessageRole; text: string; createdAt: string }
export type ApprovalStatus = 'pending' | 'allowed' | 'denied' | 'expired'
export type Approval = {
  id: string
  runId: string
  sessionId: string
  tool: string
  detail: string
  status: ApprovalStatus
  createdAt: string
  decidedAt: string | null
}

type RunRow = { id: string; session_id: string; machine: string; status: RunStatus; error: string; created_at: Date; updated_at: Date }
type MessageRow = { id: string | number; session_id: string; run_id: string | null; role: MessageRole; text: string; created_at: Date }
type ApprovalRow = {
  id: string
  run_id: string
  session_id: string
  tool: string
  detail: string
  status: ApprovalStatus
  created_at: Date
  decided_at: Date | null
}

const toRun = (r: RunRow): Run => ({
  id: r.id,
  sessionId: r.session_id,
  machine: r.machine,
  status: r.status,
  error: r.error,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
})
const toMessage = (r: MessageRow): Message => ({
  id: Number(r.id),
  sessionId: r.session_id,
  runId: r.run_id,
  role: r.role,
  text: r.text,
  createdAt: r.created_at.toISOString(),
})
const toApproval = (r: ApprovalRow): Approval => ({
  id: r.id,
  runId: r.run_id,
  sessionId: r.session_id,
  tool: r.tool,
  detail: r.detail,
  status: r.status,
  createdAt: r.created_at.toISOString(),
  decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
})

// Postgres 的 text 不能含 NUL；并按长度截断
export function cleanText(v: string, max: number) {
  return v.replaceAll('\0', '').slice(0, max)
}

export async function createRun(pool: pg.Pool, id: string, sessionId: string, machine: string): Promise<Run> {
  const r = await pool.query<RunRow>("INSERT INTO runs (id, session_id, machine, status) VALUES ($1,$2,$3,'queued') RETURNING *", [id, sessionId, machine])
  return toRun(r.rows[0])
}

export async function getRun(pool: pg.Pool, id: string): Promise<Run | null> {
  const r = await pool.query<RunRow>('SELECT * FROM runs WHERE id = $1', [id])
  return r.rows[0] ? toRun(r.rows[0]) : null
}

export async function activeRun(pool: pg.Pool, sessionId: string): Promise<Run | null> {
  const r = await pool.query<RunRow>("SELECT * FROM runs WHERE session_id = $1 AND status IN ('queued','running') LIMIT 1", [sessionId])
  return r.rows[0] ? toRun(r.rows[0]) : null
}

export async function latestRun(pool: pg.Pool, sessionId: string): Promise<Run | null> {
  const r = await pool.query<RunRow>('SELECT * FROM runs WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1', [sessionId])
  return r.rows[0] ? toRun(r.rows[0]) : null
}

export async function setRunStatus(pool: pg.Pool, id: string, status: RunStatus, error = ''): Promise<Run | null> {
  const r = await pool.query<RunRow>('UPDATE runs SET status = $2, error = $3, updated_at = now() WHERE id = $1 RETURNING *', [id, status, cleanText(error, 1000)])
  return r.rows[0] ? toRun(r.rows[0]) : null
}

// 执行器断线：它名下 queued/running 的 run 全部标 failed
export async function failActiveRuns(pool: pg.Pool, machine: string, error: string): Promise<Run[]> {
  const r = await pool.query<RunRow>(
    "UPDATE runs SET status = 'failed', error = $2, updated_at = now() WHERE machine = $1 AND status IN ('queued','running') RETURNING *",
    [machine, error],
  )
  return r.rows.map(toRun)
}

// 排序按 created_at、id；每个会话只留最近 KEEP_MESSAGES 条
async function trimMessages(pool: pg.Pool, sessionId: string) {
  await pool.query(
    `DELETE FROM messages WHERE session_id = $1 AND id NOT IN (
       SELECT id FROM messages WHERE session_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2)`,
    [sessionId, KEEP_MESSAGES],
  )
}

export async function insertMessage(pool: pg.Pool, sessionId: string, runId: string | null, role: MessageRole, text: string): Promise<Message> {
  // 数据库主机校时时可能回拨；新消息不能排到已有消息之前（同时间用 id 排序）。
  const r = await pool.query<MessageRow>(`INSERT INTO messages (session_id, run_id, role, text, created_at)
    VALUES ($1,$2,$3,$4,GREATEST(now(), (SELECT max(created_at) FROM messages WHERE session_id = $1))) RETURNING *`, [
    sessionId,
    runId,
    role,
    cleanText(text, 4000),
  ])
  await trimMessages(pool, sessionId)
  return toMessage(r.rows[0])
}

// 历史记录：run_id 为 null，跳过和已有消息（同角色同文本）完全重复的；
// created_at 排在现有最早消息之前，这样详情页里历史在新对话上面
export async function insertHistory(pool: pg.Pool, sessionId: string, items: { role: string; text: string }[]): Promise<Message[]> {
  const existing = await pool.query<{ role: string; text: string }>('SELECT role, text FROM messages WHERE session_id = $1', [sessionId])
  const seen = new Set(existing.rows.map(r => `${r.role}\u0001${r.text}`))
  const fresh: { role: string; text: string }[] = []
  for (const it of items) {
    const text = cleanText(it.text, 4000)
    const key = `${it.role}\u0001${text}`
    if (!text || seen.has(key)) continue
    seen.add(key)
    fresh.push({ role: it.role, text })
  }
  const out: Message[] = []
  const n = fresh.length
  for (let i = 0; i < n; i++) {
    const r = await pool.query<MessageRow>(
      `INSERT INTO messages (session_id, run_id, role, text, created_at)
       VALUES ($1, null, $2, $3, COALESCE((SELECT min(created_at) FROM messages WHERE session_id = $1), now()) - ($4 * interval '1 millisecond'))
       RETURNING *`,
      [sessionId, fresh[i].role, fresh[i].text, n - i],
    )
    out.push(toMessage(r.rows[0]))
  }
  await trimMessages(pool, sessionId)
  return out
}

export async function listMessages(pool: pg.Pool, sessionId: string, limit: number): Promise<Message[]> {
  const r = await pool.query<MessageRow>(
    'SELECT * FROM (SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2) t ORDER BY created_at ASC, id ASC',
    [sessionId, limit],
  )
  return r.rows.map(toMessage)
}

export async function createApproval(pool: pg.Pool, id: string, runId: string, sessionId: string, tool: string, detail: string): Promise<Approval> {
  const r = await pool.query<ApprovalRow>(
    "INSERT INTO approvals (id, run_id, session_id, tool, detail, status) VALUES ($1,$2,$3,$4,$5,'pending') RETURNING *",
    [id, runId, sessionId, cleanText(tool, 100), cleanText(detail, 1000)],
  )
  return toApproval(r.rows[0])
}

export async function getApproval(pool: pg.Pool, id: string): Promise<Approval | null> {
  const r = await pool.query<ApprovalRow>('SELECT * FROM approvals WHERE id = $1', [id])
  return r.rows[0] ? toApproval(r.rows[0]) : null
}

// 只有 pending 才能被决定；返回 null 表示已经不是 pending
export async function decideApproval(pool: pg.Pool, id: string, status: 'allowed' | 'denied'): Promise<Approval | null> {
  const r = await pool.query<ApprovalRow>("UPDATE approvals SET status = $2, decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING *", [id, status])
  return r.rows[0] ? toApproval(r.rows[0]) : null
}

export async function expireApprovalsOfRuns(pool: pg.Pool, runIds: string[]): Promise<Approval[]> {
  if (!runIds.length) return []
  const r = await pool.query<ApprovalRow>("UPDATE approvals SET status = 'expired', decided_at = now() WHERE run_id = ANY($1) AND status = 'pending' RETURNING *", [runIds])
  return r.rows.map(toApproval)
}

export async function expireApproval(pool: pg.Pool, id: string, runId: string): Promise<Approval | null> {
  const r = await pool.query<ApprovalRow>(
    "UPDATE approvals SET status = 'expired', decided_at = now() WHERE id = $1 AND run_id = $2 AND status = 'pending' RETURNING *",
    [id, runId],
  )
  return r.rows[0] ? toApproval(r.rows[0]) : null
}

export async function pendingApprovals(pool: pg.Pool, sessionId?: string): Promise<Approval[]> {
  const r = sessionId
    ? await pool.query<ApprovalRow>("SELECT * FROM approvals WHERE status = 'pending' AND session_id = $1 ORDER BY created_at", [sessionId])
    : await pool.query<ApprovalRow>("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at")
  return r.rows.map(toApproval)
}
