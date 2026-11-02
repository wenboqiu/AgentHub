import pg from 'pg'
import { migrateTasks } from './tasks.ts'

export const STATES = ['idle', 'running', 'waiting', 'done', 'aborted', 'ended', 'unknown'] as const
export type State = (typeof STATES)[number]
export const AGENTS = ['claude', 'codex', 'doubao'] as const
export type Agent = (typeof AGENTS)[number]

export type EventIn = {
  expectedAt?: string
  readAt?: string
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
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id bigserial primary key,
    email text unique not null,
    password_hash text not null,
    created_at timestamptz not null default now()
  )`)
  await pool.query(`CREATE TABLE IF NOT EXISTS auth_sessions (
    id bigserial primary key,
    token_hash text unique not null,
    user_id bigint not null references users(id) on delete cascade,
    device text not null default '',
    created_at timestamptz not null default now(),
    last_used_at timestamptz not null default now()
  )`)
  await pool.query('CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id)')
  // 旧版（0.2 及以前）的状态表没有 user_id：里面只有临时数据，直接丢掉重建
  const old = await pool.query(
    `SELECT 1 FROM information_schema.tables t WHERE t.table_schema = current_schema() AND t.table_name = 'sessions'
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = t.table_schema AND c.table_name = 'sessions' AND c.column_name = 'user_id')`,
  )
  if (old.rowCount) {
    await pool.query('BEGIN')
    try {
      await pool.query('DROP TABLE IF EXISTS approvals, messages, runs, sessions')
      await createStateTables(pool)
      await pool.query('COMMIT')
    } catch (e) {
      await pool.query('ROLLBACK').catch(() => {})
      throw e
    }
    return
  }
  await createStateTables(pool)
}

async function createStateTables(pool: { query: pg.Pool['query'] }) {
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    user_id bigint not null references users(id) on delete cascade,
    id text not null,
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
    updated_at timestamptz not null default now(),
    primary key (user_id, id)
  )`)
  await pool.query('CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(user_id, updated_at DESC)')
  await pool.query(`CREATE TABLE IF NOT EXISTS runs (
    id text primary key,
    user_id bigint not null references users(id) on delete cascade,
    session_id text not null,
    machine text not null,
    status text not null,
    error text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`)
  await pool.query('CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(user_id, session_id, created_at DESC)')
  // 执行记录不再必须挂在会话上：任务可以单独计时（session_id 为空、task_id 有值）
  await pool.query('ALTER TABLE runs ADD COLUMN IF NOT EXISTS task_id bigint')
  await pool.query('ALTER TABLE runs ALTER COLUMN session_id DROP NOT NULL')
  // 标题快照：任务/会话被删掉后，历史执行记录仍然能看出当时在做什么
  await pool.query("ALTER TABLE runs ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT ''")
  await pool.query('CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(user_id, task_id, created_at DESC)')
  await pool.query(`CREATE TABLE IF NOT EXISTS messages (
    id bigserial primary key,
    user_id bigint not null references users(id) on delete cascade,
    session_id text not null,
    run_id text,
    role text not null,
    text text not null,
    created_at timestamptz not null default now()
  )`)
  await pool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS source_id text, ADD COLUMN IF NOT EXISTS branch_point text')
  await pool.query(`CREATE TABLE IF NOT EXISTS message_feedback (
    user_id bigint not null references users(id) on delete cascade,
    session_id text not null, source_id text not null, rating text not null,
    primary key (user_id,session_id,source_id)
  )`)
  await pool.query('CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(user_id, session_id, id)')
  await pool.query('CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(user_id, created_at)')
  await pool.query(`CREATE TABLE IF NOT EXISTS approvals (
    id text primary key,
    user_id bigint not null references users(id) on delete cascade,
    run_id text not null,
    session_id text not null,
    tool text not null,
    detail text not null,
    status text not null,
    created_at timestamptz not null default now(),
    decided_at timestamptz
  )`)
  await pool.query('CREATE INDEX IF NOT EXISTS idx_approvals_session ON approvals(user_id, session_id, status)')
}

// 多个进程同时启动（或测试并行）时，CREATE TABLE IF NOT EXISTS 会互相撞，用 advisory lock 串行
export async function migrate(pool: pg.Pool) {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock(727001)')
    await migrateAll(client)
    await migrateTasks(client)
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
export async function applyEvent(pool: pg.Pool, userId: number, ev: EventIn): Promise<EventResult> {
  const id = `${ev.agent}:${ev.sessionId}`
  const at = new Date(ev.at)
  const cur = (await pool.query<Row>('SELECT * FROM sessions WHERE user_id = $1 AND id = $2', [userId, id])).rows[0]
  // 本机核对只修正查询时的版本，不能覆盖核对期间收到的新事件。
  if (ev.expectedAt !== undefined && (!cur || cur.event_at.getTime() !== Date.parse(ev.expectedAt))) return null
  if (cur && at.getTime() < cur.event_at.getTime()) return null

  // Native read receipts acknowledge one exact completed turn only. Never clear an
  // approval or overwrite a newer completion that arrived during the local read.
  if (ev.readAt !== undefined) {
    if (!cur || ev.agent !== 'codex' || !ev.quiet || ev.expectedAt === undefined ||
        cur.machine !== ev.machine || cur.state !== ev.state || !['done', 'aborted'].includes(cur.state) ||
        at.getTime() !== cur.event_at.getTime() || !Number.isFinite(Date.parse(ev.readAt)) || Date.parse(ev.readAt) < at.getTime()) return null
  }

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
  if (ev.readAt !== undefined) acked = true
  const duplicate = !!cur && cur.state === ev.state && cur.event_at.getTime() === at.getTime()
  if (duplicate && cur.acked) acked = true
  const notify = alert && !quiet && !duplicate
  const stateSince = !cur || cur.state !== ev.state || notify ? at : cur.state_since
  const cwd = ev.cwd || cur?.cwd || ''
  const title = (ev.agent === 'codex' || ev.agent === 'doubao' ? ev.title : undefined) || cur?.title || ev.title || ''
  const summary = ev.summary !== undefined && ev.summary !== '' ? ev.summary : ev.state === 'running' ? '' : (cur?.summary ?? '')
  const pid = ev.pid ? ev.pid : (cur?.pid ?? null)
  const row = (
    await pool.query<Row>(
      `INSERT INTO sessions (user_id, id, agent, machine, cwd, project, title, state, summary, state_since, acked, pid, event_at, updated_at)
       VALUES ($13,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
       ON CONFLICT (user_id, id) DO UPDATE SET machine=$3, cwd=$4, project=$5, title=$6, state=$7, summary=$8,
         state_since=$9, acked=$10, pid=$11, event_at=$12, updated_at=now()
       RETURNING *`,
      [id, ev.agent, ev.machine, cwd, projectOf(cwd), title, ev.state, summary.slice(0, 300), stateSince, acked, pid, at, userId],
    )
  ).rows[0]
  return { session: toSession(row), notify }
}

export async function listSessions(pool: pg.Pool, userId: number, all: boolean): Promise<Session[]> {
  const where = all ? '' : "AND state <> 'ended' AND updated_at > now() - interval '24 hours'"
  const r = await pool.query<Row>(`SELECT * FROM sessions WHERE user_id = $1 ${where} ORDER BY updated_at DESC`, [userId])
  return r.rows.map(toSession)
}

export async function ackSession(pool: pg.Pool, userId: number, id: string): Promise<Session | null> {
  const r = await pool.query<Row>('UPDATE sessions SET acked = true WHERE user_id = $1 AND id = $2 RETURNING *', [userId, id])
  return r.rows[0] ? toSession(r.rows[0]) : null
}

export async function ackAll(pool: pg.Pool, userId: number): Promise<Session[]> {
  const r = await pool.query<Row>('UPDATE sessions SET acked = true WHERE user_id = $1 AND acked = false RETURNING *', [userId])
  return r.rows.map(toSession)
}

export async function removeSession(pool: pg.Pool, userId: number, id: string): Promise<boolean> {
  const r = await pool.query('DELETE FROM sessions WHERE user_id = $1 AND id = $2', [userId, id])
  await pool.query('DELETE FROM messages WHERE user_id = $1 AND session_id = $2', [userId, id])
  await pool.query('DELETE FROM message_feedback WHERE user_id = $1 AND session_id = $2', [userId, id])
  await pool.query('DELETE FROM approvals WHERE user_id = $1 AND session_id = $2', [userId, id])
  await pool.query('DELETE FROM runs WHERE user_id = $1 AND session_id = $2', [userId, id])
  return (r.rowCount ?? 0) > 0
}

export const PENDING_MARK = ':pending-'
export const isPendingId = (id: string) => id.includes(PENDING_MARK)

// 新开会话：先建一个临时会话（id = <agent>:pending-<runId>），拿到真实 id 后改名
export async function createPendingSession(pool: Pick<pg.Pool, 'query'>, userId: number, id: string, base: Pick<Session, 'agent' | 'machine' | 'cwd'>, title: string): Promise<Session> {
  const row = (
    await pool.query<Row>(
      `INSERT INTO sessions (user_id, id, agent, machine, cwd, project, title, state, summary, state_since, acked, pid, event_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'running','',now(),true,null,now(),now()) RETURNING *`,
      [userId, id, base.agent, base.machine, base.cwd, projectOf(base.cwd), cleanText(title, 200)],
    )
  ).rows[0]
  return toSession(row)
}

// 拿到真实 id 之前 run 就失败/停止：临时会话标 aborted，让用户看到失败
export async function abortPendingSession(pool: pg.Pool, userId: number, id: string, error: string): Promise<Session | null> {
  const r = await pool.query<Row>(
    "UPDATE sessions SET state = 'aborted', summary = $3, acked = false, state_since = now(), event_at = now(), updated_at = now(), pid = null WHERE user_id = $1 AND id = $2 RETURNING *",
    [userId, id, cleanText(error, 300)],
  )
  return r.rows[0] ? toSession(r.rows[0]) : null
}

// 临时会话改成真实 id（一个事务里）。真实行已存在（hook / 轮询抢先上报）则合并：保留真实行，删掉临时行
export async function renamePendingSession(pool: pg.Pool, userId: number, from: string, to: string): Promise<Session | null> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const pending = (await client.query<Row>('SELECT * FROM sessions WHERE user_id = $1 AND id = $2 FOR UPDATE', [userId, from])).rows[0]
    if (!pending) {
      await client.query('ROLLBACK')
      return null
    }
    const real = (await client.query<Row>('SELECT * FROM sessions WHERE user_id = $1 AND id = $2 FOR UPDATE', [userId, to])).rows[0]
    let out: Row
    if (!real) {
      out = (await client.query<Row>('UPDATE sessions SET id = $3, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING *', [userId, from, to])).rows[0]
    } else {
      out = real
      if (!real.title && pending.title) {
        out = (await client.query<Row>('UPDATE sessions SET title = $3 WHERE user_id = $1 AND id = $2 RETURNING *', [userId, to, pending.title])).rows[0]
      }
      await client.query('DELETE FROM sessions WHERE user_id = $1 AND id = $2', [userId, from])
    }
    for (const t of ['runs', 'messages', 'approvals']) {
      await client.query(`UPDATE ${t} SET session_id = $3 WHERE user_id = $1 AND session_id = $2`, [userId, from, to])
    }
    await client.query(`INSERT INTO message_feedback(user_id,session_id,source_id,rating)
      SELECT user_id,$3,source_id,rating FROM message_feedback WHERE user_id=$1 AND session_id=$2 ON CONFLICT DO NOTHING`,[userId,from,to])
    await client.query('DELETE FROM message_feedback WHERE user_id=$1 AND session_id=$2',[userId,from])
    await client.query(`INSERT INTO task_sessions(user_id,task_id,session_id,created_at)
      SELECT user_id,task_id,$3,created_at FROM task_sessions WHERE user_id=$1 AND session_id=$2 ON CONFLICT DO NOTHING`, [userId,from,to])
    await client.query('DELETE FROM task_sessions WHERE user_id=$1 AND session_id=$2', [userId,from])
    await client.query('COMMIT')
    return toSession(out)
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

export async function purgeOld(pool: pg.Pool): Promise<number> {
  // 会话和明细保留 30 天（日历执行日志要能翻回去看）；runs 保留 90 天供月度概览
  const r = await pool.query("DELETE FROM sessions WHERE updated_at < now() - interval '30 days'")
  await pool.query("DELETE FROM runs WHERE updated_at < now() - interval '90 days'")
  await pool.query("DELETE FROM approvals WHERE created_at < now() - interval '7 days'")
  await pool.query("DELETE FROM auth_sessions WHERE last_used_at < now() - interval '180 days'")
  return r.rowCount ?? 0
}

export async function getSession(pool: pg.Pool, userId: number, id: string): Promise<Session | null> {
  const r = await pool.query<Row>('SELECT * FROM sessions WHERE user_id = $1 AND id = $2', [userId, id])
  return r.rows[0] ? toSession(r.rows[0]) : null
}

// ---------- 远程控制：runs / messages / approvals ----------

export const RUN_STATUSES = ['queued', 'running', 'done', 'failed', 'stopped'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]
export const MESSAGE_ROLES = ['user', 'assistant', 'tool', 'approval', 'system'] as const
export type MessageRole = (typeof MESSAGE_ROLES)[number]
export const KEEP_MESSAGES = 200

export type Run = { id: string; sessionId: string | null; taskId: number | null; title: string; machine: string; status: RunStatus; error: string; createdAt: string; updatedAt: string }
export type MessageMeta = { sourceId?: string; branchPoint?: string }
export type Message = MessageMeta & { rating?: 'up'|'down'|null; id: number; sessionId: string; runId: string | null; role: MessageRole; text: string; createdAt: string }
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

type RunRow = { id: string; session_id: string | null; task_id?: string | number | null; title?: string | null; machine: string; status: RunStatus; error: string; created_at: Date; updated_at: Date }
type MessageRow = { source_id?: string | null; branch_point?: string | null; rating?: 'up'|'down'|null; id: string | number; session_id: string; run_id: string | null; role: MessageRole; text: string; created_at: Date }
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
  sessionId: r.session_id ?? null,
  taskId: r.task_id === null || r.task_id === undefined ? null : Number(r.task_id),
  title: r.title ?? '',
  machine: r.machine,
  status: r.status,
  error: r.error,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
})
const toMessage = (r: MessageRow): Message => ({
  ...(r.source_id ? {sourceId:r.source_id,rating:r.rating ?? null} : {}),
  ...(r.branch_point ? {branchPoint:r.branch_point} : {}),
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

export async function createRun(pool: Pick<pg.Pool, 'query'>, userId: number, id: string, sessionId: string, machine: string, taskId: number | null = null): Promise<Run> {
  const r = await pool.query<RunRow>("INSERT INTO runs (id, user_id, session_id, machine, status, task_id, title) SELECT $1,$4,$2,$3,'queued',$5,COALESCE((SELECT title FROM tasks WHERE user_id=$4 AND id=$5),'') RETURNING *", [id, sessionId, machine, userId, taskId])
  return toRun(r.rows[0])
}

// 任务手动计时：不依赖任何会话的执行记录；标题做快照，任务删掉也还能看懂
export async function createTaskRun(pool: Pick<pg.Pool, 'query'>, userId: number, id: string, taskId: number): Promise<Run> {
  const r = await pool.query<RunRow>(
    "INSERT INTO runs (id, user_id, session_id, task_id, machine, status, title) SELECT $1,$3,NULL,t.id,'','running',t.title FROM tasks t WHERE t.user_id=$3 AND t.id=$2 RETURNING *",
    [id, taskId, userId],
  )
  if (!r.rows[0]) throw new Error('任务不存在')
  return toRun(r.rows[0])
}

export async function activeTaskRun(pool: pg.Pool, userId: number, taskId: number): Promise<Run | null> {
  const r = await pool.query<RunRow>("SELECT * FROM runs WHERE user_id = $1 AND task_id = $2 AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1", [userId, taskId])
  return r.rows[0] ? toRun(r.rows[0]) : null
}

export async function stopTaskRun(pool: pg.Pool, userId: number, runId: string, status: RunStatus = 'stopped'): Promise<Run | null> {
  const r = await pool.query<RunRow>("UPDATE runs SET status = $2, updated_at = now() WHERE user_id = $3 AND id = $1 AND status IN ('queued','running') RETURNING *", [runId, status, userId])
  return r.rows[0] ? toRun(r.rows[0]) : null
}

/** 任务标记完成时，收尾它名下所有还在跑的计时记录 */
export async function closeTaskRuns(pool: pg.Pool, userId: number, taskId: number, status: RunStatus = 'done'): Promise<Run[]> {
  const r = await pool.query<RunRow>("UPDATE runs SET status = $3, updated_at = now() WHERE user_id = $1 AND task_id = $2 AND status IN ('queued','running') RETURNING *", [userId, taskId, status])
  return r.rows.map(toRun)
}

export async function getRun(pool: pg.Pool, userId: number, id: string): Promise<Run | null> {
  const r = await pool.query<RunRow>('SELECT * FROM runs WHERE user_id = $1 AND id = $2', [userId, id])
  return r.rows[0] ? toRun(r.rows[0]) : null
}

export async function activeRun(pool: pg.Pool, userId: number, sessionId: string): Promise<Run | null> {
  const r = await pool.query<RunRow>("SELECT * FROM runs WHERE user_id = $1 AND session_id = $2 AND status IN ('queued','running') LIMIT 1", [userId, sessionId])
  return r.rows[0] ? toRun(r.rows[0]) : null
}

export async function latestRun(pool: pg.Pool, userId: number, sessionId: string): Promise<Run | null> {
  const r = await pool.query<RunRow>('SELECT * FROM runs WHERE user_id = $1 AND session_id = $2 ORDER BY created_at DESC LIMIT 1', [userId, sessionId])
  return r.rows[0] ? toRun(r.rows[0]) : null
}

export async function setRunStatus(pool: pg.Pool, userId: number, id: string, status: RunStatus, error = ''): Promise<Run | null> {
  const r = await pool.query<RunRow>('UPDATE runs SET status = $2, error = $3, updated_at = now() WHERE user_id = $4 AND id = $1 RETURNING *', [id, status, cleanText(error, 1000), userId])
  return r.rows[0] ? toRun(r.rows[0]) : null
}

// 执行器断线：它名下 queued/running 的 run 全部标 failed
export async function failActiveRuns(pool: pg.Pool, userId: number, machine: string, error: string): Promise<Run[]> {
  const r = await pool.query<RunRow>(
    "UPDATE runs SET status = 'failed', error = $2, updated_at = now() WHERE user_id = $3 AND machine = $1 AND status IN ('queued','running') RETURNING *",
    [machine, error, userId],
  )
  return r.rows.map(toRun)
}

// 日历用：一段时间内的执行记录，联出会话信息、任务名和关联任务列表（都可能是空：任务计时没有会话，会话也可能已被清理）
export type Execution = Run & { agent: Agent | null; project: string; state: State | null; taskTitle: string | null; tasks: string[] }
export async function listExecutions(pool: pg.Pool, userId: number, from: Date, to: Date): Promise<Execution[]> {
  const r = await pool.query(
    `SELECT ru.*, s.agent AS agent, s.project AS project, s.state AS state, t.title AS task_title,
       ARRAY(SELECT tt.title FROM task_sessions ts JOIN tasks tt ON tt.user_id = ts.user_id AND tt.id = ts.task_id
             WHERE ts.user_id = ru.user_id AND ts.session_id = ru.session_id) AS task_titles
     FROM runs ru
     LEFT JOIN sessions s ON s.user_id = ru.user_id AND s.id = ru.session_id
     LEFT JOIN tasks t ON t.user_id = ru.user_id AND t.id = ru.task_id
     WHERE ru.user_id = $1 AND ru.created_at <= $3 AND (ru.updated_at >= $2 OR ru.status IN ('queued','running'))
     ORDER BY ru.created_at DESC, ru.id DESC`,
    [userId, from, to],
  )
  return r.rows.map((row: RunRow & { agent: Agent | null; project: string | null; state: State | null; task_title: string | null; task_titles: string[] }) => ({
    ...toRun(row), agent: row.agent, project: row.project ?? '', state: row.state, taskTitle: row.task_title, tasks: row.task_titles ?? [],
  }))
}

// 会话的真实活动分布：按 5 分钟时间桶统计消息数（只返回有消息的桶）
// 会话表只有单个 event_at，画不出真实工作时长；消息时间戳才能反映"干干停停"的节奏
export type ActivityBucket = { sessionId: string; at: string; count: number }
export async function listActivity(pool: pg.Pool, userId: number, from: Date, to: Date): Promise<ActivityBucket[]> {
  const r = await pool.query<{ session_id: string; bucket: Date; n: number }>(
    `SELECT session_id, to_timestamp(floor(extract(epoch FROM created_at) / 300) * 300) AS bucket, count(*)::int AS n
     FROM messages
     WHERE user_id = $1 AND created_at >= $2 AND created_at < $3
     GROUP BY session_id, bucket
     ORDER BY bucket`,
    [userId, from, to],
  )
  return r.rows.map(row => ({ sessionId: row.session_id, at: row.bucket.toISOString(), count: row.n }))
}

// 排序按 created_at、id；每个会话只留最近 KEEP_MESSAGES 条
async function trimMessages(pool: Pick<pg.Pool, 'query'>, userId: number, sessionId: string) {
  await pool.query(
    `DELETE FROM messages WHERE user_id = $3 AND session_id = $1 AND id NOT IN (
       SELECT id FROM messages WHERE user_id = $3 AND session_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2)`,
    [sessionId, KEEP_MESSAGES, userId],
  )
}

export async function insertMessage(pool: Pick<pg.Pool, 'query'>, userId: number, sessionId: string, runId: string | null, role: MessageRole, text: string, meta: MessageMeta = {}): Promise<Message> {
  // 数据库主机校时时可能回拨；新消息不能排到已有消息之前（同时间用 id 排序）。
  const r = await pool.query<MessageRow>(`INSERT INTO messages (user_id, session_id, run_id, role, text, source_id, branch_point, created_at)
    VALUES ($5,$1,$2,$3,$4,$6,$7,GREATEST(now(), (SELECT max(created_at) FROM messages WHERE user_id = $5 AND session_id = $1))) RETURNING *`, [
    sessionId,
    runId,
    role,
    cleanText(text, 4000),
    userId,
    nativeKey(meta.sourceId),
    nativeKey(meta.branchPoint),
  ])
  await trimMessages(pool, userId, sessionId)
  return toMessage(r.rows[0])
}

// 历史记录：电脑上的会话记录才是准的（AgentHub 发起的对话也写在里面），
// 所以用快照整体替换这个会话已存的消息，只保留进行中的 run 的消息（快照里可能还没有）。
// 快照按原顺序插入，时间排在保留消息之前。
const MINUTE = 60_000
/**
 * 给一次历史快照排时间。三层兜底：
 * 1. 原生日志自带的时间（Claude/Codex transcript 的 timestamp）最准；
 * 2. 老电脑端不带时间，就沿用库里同一条消息（按 source_id 认）上次存的时间；
 * 3. 两边都没有的，按前后已知点等距插值，两端各按 1 分钟顺延。
 * 早先统一写成 base - i 毫秒，整段历史会挤进同一个 5 分钟桶，
 * 结果日历里每个会话的"持续时间"都一模一样。
 */
export function historyTimes(items: { at: number | null; sourceId: string | null }[], prev: Map<string, number>, fallback: number): number[] {
  const n = items.length
  const times: (number | null)[] = items.map(it => it.at ?? (it.sourceId ? prev.get(it.sourceId) ?? null : null))
  const marks: number[] = []
  times.forEach((t, i) => { if (t !== null) marks.push(i) })
  if (!marks.length) {
    return times.map((_, i) => fallback - (n - i))
  }
  const first = marks[0], last = marks[marks.length - 1]
  for (let i = first - 1; i >= 0; i--) times[i] = times[i + 1]! - MINUTE
  for (let i = last + 1; i < n; i++) times[i] = times[i - 1]! + MINUTE
  for (let m = 1; m < marks.length; m++) {
    const a = marks[m - 1], b = marks[m]
    // 时间倒挂（时钟回拨或同一秒）时至少保证每条相差 1 毫秒，顺序不乱
    if (times[b]! <= times[a]!) times[b] = times[a]! + (b - a)
    for (let i = a + 1; i < b; i++) times[i] = Math.round(times[a]! + (times[b]! - times[a]!) * ((i - a) / (b - a)))
  }
  const now = Date.now()
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    let t = Math.min(times[i]!, now)
    if (i && t <= out[i - 1]) t = out[i - 1] + 1
    out.push(t)
  }
  return out
}

export async function replaceHistory(pool: pg.Pool, userId: number, sessionId: string, items: ({ role: string; text: string; at?: string } & MessageMeta)[]): Promise<Message[]> {
  const snapshot = items
    .map(it => ({ role: it.role, text: cleanText(it.text, 4000), sourceId: nativeKey(it.sourceId), branchPoint: nativeKey(it.branchPoint), at: it.at && !Number.isNaN(Date.parse(it.at)) ? Date.parse(it.at) : null }))
    .filter(it => it.text)
    .slice(-KEEP_MESSAGES)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // 必须先查再删：老电脑端不发时间戳，全靠这里把原来的时间捡回来
    const prev = await client.query<{ source_id: string; t: Date }>(
      `SELECT source_id, max(created_at) AS t FROM messages
       WHERE user_id = $1 AND session_id = $2 AND source_id IS NOT NULL GROUP BY source_id`,
      [userId, sessionId],
    )
    const prevTimes = new Map(prev.rows.map(r => [r.source_id, r.t.getTime()]))
    const active = await client.query<{ id: string }>(
      "SELECT id FROM runs WHERE user_id = $1 AND session_id = $2 AND status IN ('queued', 'running') LIMIT 1",
      [userId, sessionId],
    )
    const keepRun = active.rows[0]?.id ?? null
    // 注意不能写成 run_id IS DISTINCT FROM $3：keepRun 为 null 时 null 和 null 不算不同，历史消息就删不掉了
    if (keepRun) await client.query('DELETE FROM messages WHERE user_id = $1 AND session_id = $2 AND run_id IS DISTINCT FROM $3', [userId, sessionId, keepRun])
    else await client.query('DELETE FROM messages WHERE user_id = $1 AND session_id = $2', [userId, sessionId])
    const base = await client.query<{ t: Date }>(
      'SELECT COALESCE(min(created_at), now()) AS t FROM messages WHERE user_id = $1 AND session_id = $2',
      [userId, sessionId],
    )
    const times = historyTimes(snapshot, prevTimes, base.rows[0].t.getTime())
    for (let i = 0; i < snapshot.length; i++) {
      await client.query(
        `INSERT INTO messages (user_id, session_id, run_id, role, text, source_id, branch_point, created_at)
         VALUES ($1, $2, null, $3, $4, $6, $7, $5::timestamptz)`,
        [userId, sessionId, snapshot[i].role, snapshot[i].text, new Date(times[i]), snapshot[i].sourceId, snapshot[i].branchPoint],
      )
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
  await trimMessages(pool, userId, sessionId)
  return listMessages(pool, userId, sessionId, KEEP_MESSAGES)
}

export function nativeKey(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : null
}

export async function getMessage(pool: pg.Pool,userId:number,sessionId:string,id:number):Promise<Message|null> {
  const r=await pool.query<MessageRow>('SELECT m.*,f.rating FROM messages m LEFT JOIN message_feedback f ON f.user_id=m.user_id AND f.session_id=m.session_id AND f.source_id=m.source_id WHERE m.user_id=$1 AND m.session_id=$2 AND m.id=$3',[userId,sessionId,id])
  return r.rows[0] ? toMessage(r.rows[0]) : null
}

export async function rateMessage(pool:pg.Pool,userId:number,sessionId:string,sourceId:string,rating:'up'|'down'|null) {
  if(rating===null) await pool.query('DELETE FROM message_feedback WHERE user_id=$1 AND session_id=$2 AND source_id=$3',[userId,sessionId,sourceId])
  else await pool.query('INSERT INTO message_feedback(user_id,session_id,source_id,rating) VALUES ($1,$2,$3,$4) ON CONFLICT(user_id,session_id,source_id) DO UPDATE SET rating=excluded.rating',[userId,sessionId,sourceId,rating])
}

export async function listMessages(pool: pg.Pool, userId: number, sessionId: string, limit: number): Promise<Message[]> {
  const r = await pool.query<MessageRow>(
    `SELECT t.*, f.rating FROM (SELECT * FROM messages WHERE user_id = $3 AND session_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2) t LEFT JOIN message_feedback f ON f.user_id=t.user_id AND f.session_id=t.session_id AND f.source_id=t.source_id ORDER BY t.created_at ASC, t.id ASC`,
    [sessionId, limit, userId],
  )
  return r.rows.map(toMessage)
}

export async function createApproval(pool: pg.Pool, userId: number, id: string, runId: string, sessionId: string, tool: string, detail: string): Promise<Approval> {
  const r = await pool.query<ApprovalRow>(
    "INSERT INTO approvals (id, user_id, run_id, session_id, tool, detail, status) VALUES ($1,$6,$2,$3,$4,$5,'pending') RETURNING *",
    [id, runId, sessionId, cleanText(tool, 100), cleanText(detail, 1000), userId],
  )
  return toApproval(r.rows[0])
}

export async function getApproval(pool: pg.Pool, userId: number, id: string): Promise<Approval | null> {
  const r = await pool.query<ApprovalRow>('SELECT * FROM approvals WHERE user_id = $1 AND id = $2', [userId, id])
  return r.rows[0] ? toApproval(r.rows[0]) : null
}

// 只有 pending 才能被决定；返回 null 表示已经不是 pending
export async function decideApproval(pool: pg.Pool, userId: number, id: string, status: 'allowed' | 'denied'): Promise<Approval | null> {
  const r = await pool.query<ApprovalRow>("UPDATE approvals SET status = $2, decided_at = now() WHERE user_id = $3 AND id = $1 AND status = 'pending' RETURNING *", [id, status, userId])
  return r.rows[0] ? toApproval(r.rows[0]) : null
}

export async function expireApprovalsOfRuns(pool: pg.Pool, userId: number, runIds: string[]): Promise<Approval[]> {
  if (!runIds.length) return []
  const r = await pool.query<ApprovalRow>("UPDATE approvals SET status = 'expired', decided_at = now() WHERE user_id = $2 AND run_id = ANY($1) AND status = 'pending' RETURNING *", [runIds, userId])
  return r.rows.map(toApproval)
}

export async function expireApproval(pool: pg.Pool, userId: number, id: string, runId: string): Promise<Approval | null> {
  const r = await pool.query<ApprovalRow>(
    "UPDATE approvals SET status = 'expired', decided_at = now() WHERE user_id = $3 AND id = $1 AND run_id = $2 AND status = 'pending' RETURNING *",
    [id, runId, userId],
  )
  return r.rows[0] ? toApproval(r.rows[0]) : null
}

export async function pendingApprovals(pool: pg.Pool, userId: number, sessionId?: string): Promise<Approval[]> {
  const r = sessionId
    ? await pool.query<ApprovalRow>("SELECT * FROM approvals WHERE user_id = $1 AND status = 'pending' AND session_id = $2 ORDER BY created_at", [userId, sessionId])
    : await pool.query<ApprovalRow>("SELECT * FROM approvals WHERE user_id = $1 AND status = 'pending' ORDER BY created_at", [userId])
  return r.rows.map(toApproval)
}
