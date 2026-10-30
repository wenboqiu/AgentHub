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

export async function migrate(pool: pg.Pool) {
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
  return (r.rowCount ?? 0) > 0
}

export async function purgeOld(pool: pg.Pool): Promise<number> {
  const r = await pool.query("DELETE FROM sessions WHERE updated_at < now() - interval '7 days'")
  return r.rowCount ?? 0
}
