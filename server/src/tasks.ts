import type pg from 'pg'
import type { State } from './db.ts'

type DB = Pick<pg.Pool, 'query'>
export type Goal = { id: number; title: string; notes: string; status: 'active' | 'done' | 'archived'; createdAt: string; updatedAt: string }
export type Task = { id: number; goalId: number | null; title: string; notes: string; status: 'todo' | 'doing' | 'review' | 'done'; agent: 'claude' | 'codex' | null; machine: string | null; cwd: string | null; sessionIds: string[]; createdAt: string; updatedAt: string; doneAt: string | null }
export class TaskError extends Error {
  statusCode: number
  constructor(message: string, statusCode = 400) { super(message); this.statusCode = statusCode }
}
export const missing = () => new TaskError('目标、任务或会话不存在', 404)
export function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TaskError('请填写有效的参数')
  return raw as Record<string, unknown>
}
export function text(raw: unknown, label: string, max: number, empty = false): string {
  if (typeof raw !== 'string') throw new TaskError(`${label}必须是文本`)
  const value = raw.replaceAll('\0', '').trim()
  if ((!empty && !value) || value.length > max) throw new TaskError(`${label}须为${empty ? '0' : '1'}–${max}字符`)
  return value
}
export function id(raw: unknown): number {
  const n = typeof raw === 'number' || typeof raw === 'string' && /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN
  if (!Number.isSafeInteger(n) || n < 1) throw missing()
  return n
}
const iso = (v: Date) => v.toISOString()
const goal = (r: any): Goal => ({ id: Number(r.id), title: r.title, notes: r.notes, status: r.status, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) })
const task = (r: any): Task => ({ ...goal(r), goalId: r.goal_id === null ? null : Number(r.goal_id), status: r.status, agent: r.agent, machine: r.machine, cwd: r.cwd, sessionIds: r.session_ids ?? [], doneAt: r.done_at ? iso(r.done_at) : null })

export async function migrateTasks(db: DB) {
  await db.query(`CREATE TABLE IF NOT EXISTS goals (
    id bigserial PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title text NOT NULL, notes text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','archived')),
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,id))`)
  await db.query(`CREATE TABLE IF NOT EXISTS tasks (
    id bigserial PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    goal_id bigint REFERENCES goals(id) ON DELETE SET NULL, title text NOT NULL, notes text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','review','done')),
    agent text CHECK (agent IN ('claude','codex')), machine text, cwd text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), done_at timestamptz,
    UNIQUE(user_id,id))`)
  await db.query(`CREATE TABLE IF NOT EXISTS task_sessions (
    task_id bigint NOT NULL, user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(task_id,session_id),
    FOREIGN KEY(user_id,task_id) REFERENCES tasks(user_id,id) ON DELETE CASCADE)`)
  await db.query('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(user_id,status)')
  await db.query('CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(user_id,goal_id)')
  await db.query('CREATE INDEX IF NOT EXISTS idx_task_sessions_session ON task_sessions(user_id,session_id)')
}
export async function listGoals(db: DB, user: number): Promise<Goal[]> {
  return (await db.query('SELECT * FROM goals WHERE user_id=$1 ORDER BY updated_at DESC,id DESC', [user])).rows.map(goal)
}
export async function listTasks(db: DB, user: number): Promise<Task[]> {
  return (await db.query(`SELECT t.*, ARRAY(SELECT session_id FROM task_sessions s WHERE s.user_id=t.user_id AND s.task_id=t.id ORDER BY s.created_at,s.session_id) session_ids
    FROM tasks t WHERE user_id=$1 ORDER BY updated_at DESC,id DESC`, [user])).rows.map(task)
}
export async function getTask(db: DB, user: number, taskId: number): Promise<Task> {
  const r = await db.query(`SELECT t.*, ARRAY(SELECT session_id FROM task_sessions s WHERE s.user_id=t.user_id AND s.task_id=t.id ORDER BY s.created_at,s.session_id) session_ids
    FROM tasks t WHERE user_id=$1 AND id=$2`, [user, taskId])
  if (!r.rows[0]) throw missing()
  return task(r.rows[0])
}
async function fields(db: DB, user: number, raw: unknown, isTask: boolean, create: boolean) {
  const b = object(raw), out: Record<string, unknown> = {}
  if (create || 'title' in b) out.title = text(b.title, '标题', 200)
  if ('notes' in b) out.notes = text(b.notes, '备注', 4000, true)
  if (!create && 'status' in b) {
    const valid = isTask ? ['todo','doing','review','done'] : ['active','done','archived']
    if (!valid.includes(b.status as string)) throw new TaskError('状态不合法')
    out.status = b.status
  }
  if (isTask) {
    if ('goalId' in b) {
      const g = b.goalId === null ? null : id(b.goalId)
      if (g !== null && !(await db.query('SELECT id FROM goals WHERE user_id=$1 AND id=$2', [user,g])).rowCount) throw missing()
      out.goal_id = g
    }
    if ('agent' in b) {
      if (![null,'','claude','codex'].includes(b.agent as any)) throw new TaskError('请选择 Claude 或 Codex')
      out.agent = b.agent || null
    }
    for (const key of ['machine','cwd']) if (key in b) out[key] = b[key] === null ? null : text(b[key], key === 'cwd' ? '项目目录' : '电脑名', 4000, true) || null
  }
  return out
}
export async function saveGoal(db: DB, user: number, raw: unknown, goalId?: number): Promise<Goal> {
  if (goalId !== undefined && !(await db.query('SELECT id FROM goals WHERE user_id=$1 AND id=$2', [user,goalId])).rowCount) throw missing()
  const f = await fields(db,user,raw,false,goalId === undefined)
  const keys = Object.keys(f), values = Object.values(f)
  const r = goalId === undefined
    ? await db.query(`INSERT INTO goals(user_id,${keys.join(',')}) VALUES($1,${keys.map((_,i) => `$${i+2}`).join(',')}) RETURNING *`, [user,...values])
    : await db.query(`UPDATE goals SET updated_at=now()${keys.map((k,i) => `,${k}=$${i+3}`).join('')} WHERE user_id=$1 AND id=$2 RETURNING *`, [user,goalId,...values])
  if (!r.rows[0]) throw missing()
  return goal(r.rows[0])
}
export async function saveTask(db: DB, user: number, raw: unknown, taskId?: number): Promise<Task> {
  if (taskId !== undefined) await getTask(db,user,taskId)
  const f = await fields(db,user,raw,true,taskId === undefined)
  const keys = Object.keys(f), values = Object.values(f)
  const done = 'status' in f ? ",done_at=CASE WHEN $" + (keys.indexOf('status')+3) + "='done' THEN COALESCE(done_at,now()) ELSE NULL END" : ''
  const r = taskId === undefined
    ? await db.query(`INSERT INTO tasks(user_id,${keys.join(',')}) VALUES($1,${keys.map((_,i) => `$${i+2}`).join(',')}) RETURNING id`, [user,...values])
    : await db.query(`UPDATE tasks SET updated_at=now()${keys.map((k,i) => `,${k}=$${i+3}`).join('')}${done} WHERE user_id=$1 AND id=$2 RETURNING id`, [user,taskId,...values])
  if (!r.rows[0]) throw missing()
  return getTask(db,user,Number(r.rows[0].id))
}
export async function deleteGoal(db: DB, user: number, goalId: number) {
  if (!(await db.query('DELETE FROM goals WHERE user_id=$1 AND id=$2 RETURNING id', [user,goalId])).rowCount) throw missing()
}
export async function deleteTask(db: DB, user: number, taskId: number) {
  if (!(await db.query('DELETE FROM tasks WHERE user_id=$1 AND id=$2 RETURNING id', [user,taskId])).rowCount) throw missing()
}
export async function linkSession(db: DB, user: number, taskId: number, sessionId: string, unlink = false) {
  await getTask(db,user,taskId)
  if (unlink) await db.query('DELETE FROM task_sessions WHERE user_id=$1 AND task_id=$2 AND session_id=$3', [user,taskId,sessionId])
  else {
    if (!(await db.query('SELECT id FROM sessions WHERE user_id=$1 AND id=$2', [user,sessionId])).rowCount) throw missing()
    await db.query('INSERT INTO task_sessions(user_id,task_id,session_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [user,taskId,sessionId])
  }
  await db.query('UPDATE tasks SET updated_at=now() WHERE user_id=$1 AND id=$2', [user,taskId])
  return getTask(db,user,taskId)
}
export async function tasksForSession(db: DB, user: number, sessionId: string) {
  const ids = (await db.query('SELECT task_id FROM task_sessions WHERE user_id=$1 AND session_id=$2', [user,sessionId])).rows
  return Promise.all(ids.map(r => getTask(db,user,Number(r.task_id))))
}
export async function syncTaskForSession(db: DB, user: number, sessionId: string, state: State): Promise<Task[]> {
  if (state !== 'done' && state !== 'running') return []
  const from = state === 'done' ? 'doing' : 'review', to = state === 'done' ? 'review' : 'doing'
  const r = await db.query(`UPDATE tasks SET status=$4,done_at=NULL,updated_at=now() WHERE user_id=$1 AND status=$3
    AND id IN (SELECT task_id FROM task_sessions WHERE user_id=$1 AND session_id=$2) RETURNING id`, [user,sessionId,from,to])
  return Promise.all(r.rows.map(r => getTask(db,user,Number(r.id))))
}
