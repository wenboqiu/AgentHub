import pg from 'pg'
import { migrateTasks } from './tasks.ts'
import { migrateNotify } from './notify.ts'
import { migrateDigests } from './digest.ts'
import { migrateWatchdog } from './watchdog.ts'
import { migrateReview } from './review.ts'
import { migrateQueue } from './queue.ts'
import { migrateRoles } from './roles.ts'
import { migrateProjects } from './projects.ts'
import { migrateMemories } from './memories.ts'
import { migrateAssistant } from './assistant.ts'
import { migrateProposals } from './proposals.ts'
import { migrateArtifacts } from './artifacts.ts'
import { migrateAttachments } from './attachments.ts'
import { migrateReferee } from './referee.ts'
import { migrateMandate, pruneMandateDecisions } from './mandate.ts'
import { migrateDispatchManager } from './dispatch-manager.ts'
import { EVENT_DEDUPE_MS, mergeEventMessages, sameKey } from './message-merge.ts'
import { isInternalTitle } from './session-kind.ts'

export const STATES = ['idle', 'running', 'waiting', 'done', 'aborted', 'ended', 'unknown'] as const
export type State = (typeof STATES)[number]
export const AGENTS = ['claude', 'codex', 'doubao', 'workbuddy', 'zcode', 'codebuddy'] as const
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
  /** 只听不聊的 agent（WorkBuddy）从 transcript 报过来的活动桶，落 session_activity 供日历画跨度 */
  buckets?: { at: string; count: number }[]
  /**
   * 只读监听类（WorkBuddy）随事件顺路上报的正文。
   * 正文只存在那台电脑的 transcript 里，而拉历史要走执行器通道——没开「允许手机远程执行」
   * 的电脑永远拉不到；跟着状态事件上来就与通道无关。
   */
  messages?: { role: 'user' | 'assistant'; text: string; at?: string }[]
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

// 能在本机读到「已读」证据的 agent：Codex Desktop 的已读存储、WorkBuddy 的 sessions.unread
const READ_RECEIPT_AGENTS: Agent[] = ['codex', 'workbuddy']

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
  // 一次运行的 token 用量（执行器上报）：{input,output,cached,reasoning,total,costUsd}
  await pool.query('ALTER TABLE runs ADD COLUMN IF NOT EXISTS usage jsonb')
  // 这一轮用的模型：角色写死的、还是项目经理按复杂度挑的，连理由一起记下来——
  // 模型是花多少钱的关键变量，事后要能回答「这轮为什么用 opus」
  await pool.query('ALTER TABLE runs ADD COLUMN IF NOT EXISTS model text')
  await pool.query("ALTER TABLE runs ADD COLUMN IF NOT EXISTS model_note text NOT NULL DEFAULT ''")
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
  // Codex 生成/展示的图片：执行器读成本地文件后转 data URL 随消息存储（小图才存，防止表膨胀）
  await pool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS images jsonb')
  await pool.query(`CREATE TABLE IF NOT EXISTS message_feedback (
    user_id bigint not null references users(id) on delete cascade,
    session_id text not null, source_id text not null, rating text not null,
    primary key (user_id,session_id,source_id)
  )`)
  await pool.query('CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(user_id, session_id, id)')
  await pool.query('CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(user_id, created_at)')
  // 会话活动计数：按 5 分钟桶累计消息数。独立于 messages 存活——消息表每个会话只保留
  // 最近 KEEP_MESSAGES 条，还会被快照整体替换，直接从消息表算活动时长会越算越短。
  await pool.query(`CREATE TABLE IF NOT EXISTS session_activity (
    user_id bigint not null references users(id) on delete cascade,
    session_id text not null,
    bucket timestamptz not null,
    count integer not null default 0,
    primary key (user_id, session_id, bucket)
  )`)
  await pool.query('CREATE INDEX IF NOT EXISTS idx_session_activity_time ON session_activity(user_id, bucket)')
  // 一次性回填：消息表里现存的消息先入账（已入账的桶不重复累计；早已被裁剪掉的历史无法找回）
  // messages 与 users 都是 on delete cascade，但并发删账号时回填可能读到刚被删掉的那一行，
  // 触发 FK 报错把整个启动打挂——回填是尽力而为，FK 冲突直接跳过。
  try {
    await pool.query(`INSERT INTO session_activity (user_id, session_id, bucket, count)
      SELECT user_id, session_id, to_timestamp(floor(extract(epoch FROM created_at) / 300) * 300), count(*)::int
      FROM messages GROUP BY 1, 2, 3
      ON CONFLICT DO NOTHING`)
  } catch (e) {
    if ((e as { code?: string })?.code !== '23503') throw e
  }
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
    await migrateNotify(client)
    await migrateDigests(client)
    await migrateWatchdog(client)
    await migrateReview(client)
    await migrateQueue(client)
    // 项目引用 profiles 的老数据在 migrateProjects 里搬迁（目录收进项目），必须排在任务迁移后
    await migrateProjects(client)
    // 角色引用 roles
    await migrateRoles(client)
    // 记忆引用 roles 与 projects，必须排在两者后面
    await migrateMemories(client)
    // 角色助手的草稿引用 roles，排在最后
    await migrateAssistant(client)
    // 处理意见挂在会话上（不设外键：会话被清理后意见仍可追溯），自动派发配置引用 roles
    await migrateProposals(client)
    await migrateDispatchManager(client)
    // 任务产物引用 tasks；项目近况的表在 migrateProjects 里一起建（同属项目上下文）
    await migrateArtifacts(client)
    // 任务附件引用 tasks（备注里只存 attachment:ID 引用，本体在这张表）
    await migrateAttachments(client)
    // 审批来源（人 / 项目经理代批）加在 approvals 上，表在建库时就存在了
    await migrateReferee(client)
    // Mandate 快照 / 决策留痕 / 交付物 / 授权模式；给 tasks 与 approvals 加列，必须排在两者建表之后
    await migrateMandate(client)
    // profiles 实体已废弃（执行目录收进项目）：各处引用清完后删表兜底（CASCADE 清残留约束）
    await client.query('DROP TABLE IF EXISTS profiles CASCADE')
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
  // 只有能读到本机已读存储的 agent（Codex Desktop / WorkBuddy）才有资格发回执。
  if (ev.readAt !== undefined) {
    if (!cur || !READ_RECEIPT_AGENTS.some(a => a === ev.agent) || !ev.quiet || ev.expectedAt === undefined ||
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
  // 内部会话（角色助手 / 意见细化）的标题是 startSession 起的名字，钉住不放：本机 transcript 里的
  // 标题是「首条用户消息截 40 字」，而这轮的首条消息正是 AgentHub 写的契约提示词，顶上去就成了提示词原文。
  const pinned = isInternalTitle(cur?.title ?? '')
  const title = pinned
    ? cur!.title
    : (['codex', 'doubao', 'workbuddy', 'zcode', 'codebuddy'].includes(ev.agent) ? ev.title : undefined) || cur?.title || ev.title || ''
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
  // 活动桶随事件顺路上报（WorkBuddy 只读 transcript，没有消息同步）：已有真实消息的桶以更大者为准，不被覆盖
  if (ev.buckets?.length) {
    await pool.query(
      `INSERT INTO session_activity (user_id, session_id, bucket, count)
       SELECT $1, $2, to_timestamp(floor(extract(epoch FROM b.at) / 300) * 300), b.count
       FROM unnest($3::timestamptz[], $4::int[]) AS b(at, count)
       ON CONFLICT (user_id, session_id, bucket) DO UPDATE SET count = GREATEST(session_activity.count, excluded.count)`,
      [userId, id, ev.buckets.map(b => b.at), ev.buckets.map(b => b.count)],
    )
  }
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

/**
 * 完成态自动过期：done/aborted 挂太久没人确认就自动记为已处理。
 * 「完成」只是通知，不该永久占用待处理区；waiting（授权）要人拍板，不在此列。
 * 返回被改的会话（带 userId），调用方逐条广播让各端列表即时收敛。
 */
export async function expirePending(pool: pg.Pool, olderThanMs: number): Promise<{ userId: number; session: Session }[]> {
  const r = await pool.query<Row & { user_id: number }>(
    `UPDATE sessions SET acked = true, updated_at = now()
     WHERE acked = false AND state IN ('done', 'aborted') AND state_since < now() - ($1::bigint * interval '1 millisecond')
     RETURNING *`,
    [olderThanMs],
  )
  return r.rows.map(row => ({ userId: row.user_id, session: toSession(row) }))
}

export async function removeSession(pool: pg.Pool, userId: number, id: string): Promise<boolean> {
  const r = await pool.query('DELETE FROM sessions WHERE user_id = $1 AND id = $2', [userId, id])
  await pool.query('DELETE FROM messages WHERE user_id = $1 AND session_id = $2', [userId, id])
  await pool.query('DELETE FROM session_activity WHERE user_id = $1 AND session_id = $2', [userId, id])
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
      // 真实行多半是 hook / 轮询抢先上报的，标题来自 transcript 首条消息（内部会话就是契约提示词原文）。
      // 临时行上的标题才是服务端特意起的名字，这种情况下让它赢；真实行本来没标题时也照旧沿用。
      const keepPending = !!pending.title && (isInternalTitle(pending.title) || !real.title)
      if (keepPending && real.title !== pending.title) {
        out = (await client.query<Row>('UPDATE sessions SET title = $3 WHERE user_id = $1 AND id = $2 RETURNING *', [userId, to, pending.title])).rows[0]
      }
      await client.query('DELETE FROM sessions WHERE user_id = $1 AND id = $2', [userId, from])
    }
    for (const t of ['runs', 'messages', 'approvals']) {
      await client.query(`UPDATE ${t} SET session_id = $3 WHERE user_id = $1 AND session_id = $2`, [userId, from, to])
    }
    // 活动计数按桶合并过去（同桶相加），临时行的计数不丢
    await client.query(`INSERT INTO session_activity(user_id, session_id, bucket, count)
      SELECT user_id, $3, bucket, count FROM session_activity WHERE user_id = $1 AND session_id = $2
      ON CONFLICT (user_id, session_id, bucket) DO UPDATE SET count = session_activity.count + excluded.count`, [userId, from, to])
    await client.query('DELETE FROM session_activity WHERE user_id = $1 AND session_id = $2', [userId, from])
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
  // 活动计数跟着会话走：先删掉将过期会话的计数，再顺手清掉会话已不存在的孤儿计数
  await pool.query("DELETE FROM session_activity WHERE (user_id, session_id) IN (SELECT user_id, id FROM sessions WHERE updated_at < now() - interval '30 days')")
  await pool.query('DELETE FROM session_activity AS s WHERE NOT EXISTS (SELECT 1 FROM sessions se WHERE se.user_id = s.user_id AND se.id = s.session_id)')
  const r = await pool.query("DELETE FROM sessions WHERE updated_at < now() - interval '30 days'")
  await pool.query("DELETE FROM runs WHERE updated_at < now() - interval '90 days'")
  await pool.query("DELETE FROM approvals WHERE created_at < now() - interval '7 days'")
  await pruneMandateDecisions(pool)
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
/** 消息正文入库上限：执行器侧 TEXT_MAX 同步（16000），两边不一致会导致历史同步时再截一次 */
export const MESSAGE_TEXT_MAX = 16000

export type RunUsage = { input: number; output: number; cached?: number; reasoning?: number; total: number; costUsd?: number; credits?: number }
export type Run = { id: string; sessionId: string | null; taskId: number | null; title: string; machine: string; status: RunStatus; error: string; usage: RunUsage | null; /** 这一轮用的模型；空 = 执行端默认 */ model: string | null; /** 谁定的、为什么，给界面和事后复盘看 */ modelNote: string; createdAt: string; updatedAt: string }
export type MessageMeta = { sourceId?: string; branchPoint?: string }
export type Message = MessageMeta & { rating?: 'up'|'down'|null; id: number; sessionId: string; runId: string | null; role: MessageRole; text: string; images?: string[]; createdAt: string }
export type ApprovalStatus = 'pending' | 'allowed' | 'denied' | 'expired'
export type Approval = {
  id: string
  runId: string
  sessionId: string
  tool: string
  detail: string
  status: ApprovalStatus
  /** 谁做的决定：user = 人点的，manager = 项目经理按规则代批 */
  decidedBy: 'user' | 'manager'
  /** 代批命中的规则 id 与一句话理由，界面要显示「为什么它敢批」 */
  decisionRule: string
  decisionReason: string
  /** 裁决层级：pending 时是「为什么轮不到规则定」，decided 时是「凭什么放的」 */
  decisionTier: string
  createdAt: string
  decidedAt: string | null
}

type RunRow = { id: string; session_id: string | null; task_id?: string | number | null; title?: string | null; machine: string; status: RunStatus; error: string; usage?: RunUsage | null; model?: string | null; model_note?: string | null; created_at: Date; updated_at: Date }
type MessageRow = { source_id?: string | null; branch_point?: string | null; rating?: 'up'|'down'|null; images?: string[] | null; id: string | number; session_id: string; run_id: string | null; role: MessageRole; text: string; created_at: Date }
type ApprovalRow = {
  id: string
  run_id: string
  session_id: string
  tool: string
  detail: string
  status: ApprovalStatus
  decided_by?: string | null
  decision_rule?: string | null
  decision_reason?: string | null
  decision_tier?: string | null
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
  usage: r.usage ?? null,
  model: r.model ?? null,
  modelNote: r.model_note ?? '',
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
})
const toMessage = (r: MessageRow): Message => ({
  ...(r.source_id ? {sourceId:r.source_id,rating:r.rating ?? null} : {}),
  ...(r.branch_point ? {branchPoint:r.branch_point} : {}),
  ...(Array.isArray(r.images) && r.images.length ? {images:r.images} : {}),
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
  decidedBy: r.decided_by === 'manager' ? 'manager' : 'user',
  decisionRule: r.decision_rule ?? '',
  decisionReason: r.decision_reason ?? '',
  decisionTier: r.decision_tier ?? '',
  createdAt: r.created_at.toISOString(),
  decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
})

// Postgres 的 text 不能含 NUL；并按长度截断
export function cleanText(v: string, max: number) {
  return v.replaceAll('\0', '').slice(0, max)
}

/** 这一轮用的模型由调用方算好后一起落库：模型和「谁定的」是事后复盘的关键，不能只发不记 */
export type RunModel = { model?: string | null; note?: string }

export async function createRun(pool: Pick<pg.Pool, 'query'>, userId: number, id: string, sessionId: string, machine: string, taskId: number | null = null, model: RunModel = {}): Promise<Run> {
  const r = await pool.query<RunRow>(
    "INSERT INTO runs (id, user_id, session_id, machine, status, task_id, title, model, model_note) SELECT $1,$4,$2,$3,'queued',$5,COALESCE((SELECT title FROM tasks WHERE user_id=$4 AND id=$5),''),$6,$7 RETURNING *",
    [id, sessionId, machine, userId, taskId, model.model ?? null, (model.note ?? '').slice(0, 500)],
  )
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

/** 执行器上报的 token 用量：运行结束后迟到也照样收（只是记账，不回写状态） */
export async function setRunUsage(pool: pg.Pool, userId: number, id: string, usage: RunUsage): Promise<Run | null> {
  const r = await pool.query<RunRow>('UPDATE runs SET "usage" = $2, updated_at = now() WHERE user_id = $3 AND id = $1 RETURNING *', [id, usage, userId])
  return r.rows[0] ? toRun(r.rows[0]) : null
}

/** 执行端报上来的实测模型：只在 run 还没记过模型时填（角色配的不覆盖） */
export async function setRunModelIfEmpty(pool: pg.Pool, userId: number, id: string, model: string): Promise<Run | null> {
  const r = await pool.query<RunRow>(
    "UPDATE runs SET model = $2, updated_at = now() WHERE user_id = $3 AND id = $1 AND (model IS NULL OR model = '') RETURNING *",
    [id, model.slice(0, 200), userId],
  )
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

// 会话的真实活动分布：按 5 分钟时间桶返回消息数（只返回有消息的桶）。
// 数据来自 session_activity 计数表：随消息插入累计、随快照重算，不受消息裁剪影响。
// 会话表只有单个 event_at，画不出真实工作时长；消息时间戳才能反映"干干停停"的节奏
export type ActivityBucket = { sessionId: string; at: string; count: number }
export async function listActivity(pool: pg.Pool, userId: number, from: Date, to: Date): Promise<ActivityBucket[]> {
  const r = await pool.query<{ session_id: string; bucket: Date; count: number }>(
    `SELECT session_id, bucket, count FROM session_activity
     WHERE user_id = $1 AND bucket >= $2 AND bucket < $3
     ORDER BY bucket`,
    [userId, from, to],
  )
  return r.rows.map(row => ({ sessionId: row.session_id, at: row.bucket.toISOString(), count: row.count }))
}

// 排序按 created_at、id；每个会话只留最近 KEEP_MESSAGES 条
async function trimMessages(pool: Pick<pg.Pool, 'query'>, userId: number, sessionId: string) {
  await pool.query(
    `DELETE FROM messages WHERE user_id = $3 AND session_id = $1 AND id NOT IN (
       SELECT id FROM messages WHERE user_id = $3 AND session_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2)`,
    [sessionId, KEEP_MESSAGES, userId],
  )
}

export async function insertMessage(pool: Pick<pg.Pool, 'query'>, userId: number, sessionId: string, runId: string | null, role: MessageRole, text: string, meta: MessageMeta = {}, images: string[] | null = null): Promise<Message> {
  // 数据库主机校时时可能回拨；新消息不能排到已有消息之前（同时间用 id 排序）。
  const r = await pool.query<MessageRow>(`INSERT INTO messages (user_id, session_id, run_id, role, text, source_id, branch_point, images, created_at)
    VALUES ($5,$1,$2,$3,$4,$6,$7,$8,GREATEST(now(), (SELECT max(created_at) FROM messages WHERE user_id = $5 AND session_id = $1))) RETURNING *`, [
    sessionId,
    runId,
    role,
    cleanText(text, MESSAGE_TEXT_MAX),
    userId,
    nativeKey(meta.sourceId),
    nativeKey(meta.branchPoint),
    images && images.length ? JSON.stringify(images) : null,
  ])
  await pool.query(`INSERT INTO session_activity (user_id, session_id, bucket, count)
    VALUES ($1,$2,to_timestamp(floor(extract(epoch FROM $3::timestamptz) / 300) * 300),1)
    ON CONFLICT (user_id, session_id, bucket) DO UPDATE SET count = session_activity.count + 1`,
    [userId, sessionId, r.rows[0].created_at])
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
    .map(it => ({ role: it.role, text: cleanText(it.text, MESSAGE_TEXT_MAX), sourceId: nativeKey(it.sourceId), branchPoint: nativeKey(it.branchPoint), at: it.at && !Number.isNaN(Date.parse(it.at)) ? Date.parse(it.at) : null }))
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
    // 正在跑的 run 关联的消息要保留（流式正文可能还没落进 transcript），但 transcript
    // 快照里同一条消息会再来一份——刚才发的那条 user 消息、已落盘的助手回复都算，
    // 不去重的话界面上就是「发送的消息等一会又出现一条」。按 (role, 归一化后正文前 400 字)
    // 多重集匹配（transcript 会把多行用户输入折成一行，得先归一化才认得出是同一句）：
    // 快照里与保留消息对得上的副本跳过，对不上的（真正新增的）照常插入。
    const key = (role: string, text: string) => `${role}|${sameKey(text)}`
    const keptCounts = new Map<string, number>()
    if (keepRun) {
      const kept = await client.query<{ role: string; text: string }>(
        'SELECT role, text FROM messages WHERE user_id = $1 AND session_id = $2 AND run_id = $3',
        [userId, sessionId, keepRun],
      )
      for (const r of kept.rows) {
        const k = key(r.role, r.text)
        keptCounts.set(k, (keptCounts.get(k) ?? 0) + 1)
      }
    }
    const deduped = snapshot.filter(it => {
      const k = key(it.role, it.text)
      const n = keptCounts.get(k) ?? 0
      if (n > 0) {
        keptCounts.set(k, n - 1)
        return false
      }
      return true
    })
    // 注意不能写成 run_id IS DISTINCT FROM $3：keepRun 为 null 时 null 和 null 不算不同，历史消息就删不掉了
    if (keepRun) await client.query('DELETE FROM messages WHERE user_id = $1 AND session_id = $2 AND run_id IS DISTINCT FROM $3', [userId, sessionId, keepRun])
    else await client.query('DELETE FROM messages WHERE user_id = $1 AND session_id = $2', [userId, sessionId])
    const base = await client.query<{ t: Date }>(
      'SELECT COALESCE(min(created_at), now()) AS t FROM messages WHERE user_id = $1 AND session_id = $2',
      [userId, sessionId],
    )
    const times = historyTimes(deduped, prevTimes, base.rows[0].t.getTime())
    for (let i = 0; i < deduped.length; i++) {
      await client.query(
        `INSERT INTO messages (user_id, session_id, run_id, role, text, source_id, branch_point, created_at)
         VALUES ($1, $2, null, $3, $4, $6, $7, $5::timestamptz)`,
        [userId, sessionId, deduped[i].role, deduped[i].text, new Date(times[i]), deduped[i].sourceId, deduped[i].branchPoint],
      )
    }
    // 活动计数按当前消息重算：历史是整体替换的，按增量累计会重复入账
    await client.query('DELETE FROM session_activity WHERE user_id = $1 AND session_id = $2', [userId, sessionId])
    await client.query(`INSERT INTO session_activity (user_id, session_id, bucket, count)
      SELECT user_id, session_id, to_timestamp(floor(extract(epoch FROM created_at) / 300) * 300), count(*)::int
      FROM messages WHERE user_id = $1 AND session_id = $2 GROUP BY 1, 2, 3`, [userId, sessionId])
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

/**
 * 随事件上来的原生正文（WorkBuddy / CodeBuddy 这类只读监听通道）：去重后插入。
 *
 * 去重口径见 `message-merge.ts`：正文按空白归一化（transcript 会把多行折成一行），
 * 时间只容忍毫秒级抖动；本次 run 自己发出去的用户消息按正文认回显——不这么做，
 * 用户从 AgentHub 发进 CodeBuddy 会话的那句话会在 transcript 回显后变成两条。
 * 返回新插入的条数，0 表示这条事件带的内容库里已经有了。
 */
export async function appendEventMessages(
  pool: pg.Pool,
  userId: number,
  sessionId: string,
  items: { role: string; text: string; at?: string }[],
  fallbackAt: Date,
): Promise<number> {
  const incoming = items
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role as MessageRole, text: cleanText(m.text ?? '', MESSAGE_TEXT_MAX), at: m.at && !Number.isNaN(Date.parse(m.at)) ? Date.parse(m.at) : null }))
    .filter(m => m.text.trim())
  if (!incoming.length) return 0

  const now = Date.now()
  // 原生日志的时间是准的；但不能排到未来（机器时钟跑快时会把日历画到明天）
  const rows = incoming.map(m => ({ role: m.role as string, text: m.text, at: Math.min(m.at ?? fallbackAt.getTime(), now) }))
  const from = new Date(Math.min(...rows.map(r => r.at)) - EVENT_DEDUPE_MS)
  const to = new Date(Math.max(...rows.map(r => r.at)) + EVENT_DEDUPE_MS)

  // 只取时间相近的那一段，不按「最近 N 条」：重发一条很旧的消息原本会落到窗口外，
  // 于是同一段正文被再插一次（界面上一段回复连着两遍）。
  const [known, active] = await Promise.all([
    pool.query<{ role: string; text: string; created_at: Date }>(
      `SELECT role, text, created_at FROM messages
       WHERE user_id = $1 AND session_id = $2 AND created_at BETWEEN $3 AND $4`,
      [userId, sessionId, from, to],
    ),
    // 这轮 run 自己发出去的用户消息：transcript 里那条回显要认出来，别当新消息再插一遍
    pool.query<{ text: string }>(
      `SELECT m.text FROM messages m JOIN runs r ON r.id = m.run_id
       WHERE m.user_id = $1 AND m.session_id = $2 AND m.role = 'user' AND r.status IN ('queued', 'running')`,
      [userId, sessionId],
    ),
  ])
  const fresh: { role: MessageRole; text: string; at: Date }[] = mergeEventMessages(
    rows,
    known.rows.map(r => ({ role: r.role, text: r.text, at: r.created_at.getTime() })),
    active.rows.map(r => r.text),
  ).map(m => ({ role: m.role as MessageRole, text: m.text, at: new Date(m.at) }))
  if (!fresh.length) return 0

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const m of fresh) {
      await client.query(
        `INSERT INTO messages (user_id, session_id, run_id, role, text, created_at)
         VALUES ($1, $2, null, $3, $4, $5::timestamptz)`,
        [userId, sessionId, m.role, m.text, m.at],
      )
    }
    // 活动计数按插入时间累加（日历的跨度靠它）；同一桶里合并成一行
    const buckets = new Map<number, number>()
    for (const m of fresh) {
      const b = Math.floor(m.at.getTime() / 300_000) * 300_000
      buckets.set(b, (buckets.get(b) ?? 0) + 1)
    }
    for (const [b, count] of buckets) {
      await client.query(
        `INSERT INTO session_activity (user_id, session_id, bucket, count)
         VALUES ($1, $2, to_timestamp($3::bigint / 1000.0), $4)
         ON CONFLICT (user_id, session_id, bucket) DO UPDATE SET count = session_activity.count + excluded.count`,
        [userId, sessionId, b, count],
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
  return fresh.length
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
  // userInput 的 detail 是 questions 的 JSON，放宽上限才能让 UI 渲染完整选项
  const r = await pool.query<ApprovalRow>(
    "INSERT INTO approvals (id, user_id, run_id, session_id, tool, detail, status) VALUES ($1,$6,$2,$3,$4,$5,'pending') RETURNING *",
    [id, runId, sessionId, cleanText(tool, 100), cleanText(detail, 6000), userId],
  )
  return toApproval(r.rows[0])
}

export async function getApproval(pool: pg.Pool, userId: number, id: string): Promise<Approval | null> {
  const r = await pool.query<ApprovalRow>('SELECT * FROM approvals WHERE user_id = $1 AND id = $2', [userId, id])
  return r.rows[0] ? toApproval(r.rows[0]) : null
}

// 只有 pending 才能被决定；返回 null 表示已经不是 pending
export async function decideApproval(
  pool: pg.Pool, userId: number, id: string, status: 'allowed' | 'denied',
  by: 'user' | 'manager' = 'user', rule = '', reason = '', tier = '',
): Promise<Approval | null> {
  // status='pending' 是并发闸门：人点和代批同时发生时只有一个能落地
  const r = await pool.query<ApprovalRow>(
    "UPDATE approvals SET status=$2, decided_at=now(), decided_by=$4, decision_rule=$5, decision_reason=$6, decision_tier=$7 WHERE user_id=$3 AND id=$1 AND status='pending' RETURNING *",
    [id, status, userId, by, rule.slice(0, 60), reason.slice(0, 300), tier.slice(0, 20)],
  )
  return r.rows[0] ? toApproval(r.rows[0]) : null
}

/** 代批看过了但不敢批：把规则和理由挂在待处理记录上，人点之前就能看到风险点 */
export async function annotateApproval(pool: pg.Pool, userId: number, id: string, rule: string, reason: string, tier = ''): Promise<Approval | null> {
  const r = await pool.query<ApprovalRow>(
    "UPDATE approvals SET decision_rule=$3, decision_reason=$4, decision_tier=$5 WHERE user_id=$2 AND id=$1 AND status='pending' RETURNING *",
    [id, userId, rule.slice(0, 60), reason.slice(0, 300), tier.slice(0, 20)],
  )
  return r.rows[0] ? toApproval(r.rows[0]) : null
}

/** 代批之后发现执行端没收到（断线）：把记录退回待处理，改由人来决定 */
export async function reopenApproval(pool: pg.Pool, userId: number, id: string): Promise<Approval | null> {
  const r = await pool.query<ApprovalRow>(
    "UPDATE approvals SET status='pending', decided_at=NULL, decided_by='user', decision_rule='', decision_reason='', decision_tier='' WHERE user_id=$2 AND id=$1 AND status='allowed' RETURNING *",
    [id, userId],
  )
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
