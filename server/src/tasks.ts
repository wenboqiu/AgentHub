import type pg from 'pg'
import type { State } from './db.ts'
// 边界形状由 referee 定义（纯函数、无运行时依赖），代批和存库共用同一份定义
import { normalizeConstraints, type TaskConstraints } from './referee.ts'

type DB = Pick<pg.Pool, 'query'>
export type Schedule = { startAt: string | null; dueAt: string | null; remindStart: boolean; remindDue: boolean }
export type ChecklistItem = { id: string; text: string; done: boolean }
export type Goal = Schedule & { id: number; title: string; notes: string; priority: 'high' | 'medium' | 'low'; status: 'active' | 'done' | 'archived'; createdAt: string; updatedAt: string; doneAt: string | null }
export type Task = Schedule & { checklist: ChecklistItem[]; constraints: TaskConstraints; id: number; goalId: number | null; projectId: number | null; profileId: number | null; roleId: number | null; priority: 'high' | 'medium' | 'low'; title: string; notes: string; status: 'todo' | 'doing' | 'review' | 'done'; agent: 'claude' | 'codex' | 'doubao' | 'workbuddy' | 'zcode' | null; machine: string | null; cwd: string | null; sessionIds: string[]; createdAt: string; updatedAt: string; doneAt: string | null; timerStartedAt: string | null; queuedAt: string | null }
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
const entity = (r: any) => ({ id: Number(r.id), title: r.title, notes: r.notes, status: r.status, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), startAt: r.start_at ? iso(r.start_at) : null, dueAt: r.due_at ? iso(r.due_at) : null, remindStart: r.remind_start, remindDue: r.remind_due })
const goal = (r: any): Goal => ({ ...entity(r), priority: r.priority, doneAt: r.done_at ? iso(r.done_at) : null })
const task = (r: any): Task => ({ ...entity(r), checklist: r.checklist ?? [], constraints: normalizeConstraints(r.constraints), goalId: r.goal_id === null ? null : Number(r.goal_id), projectId: r.project_id === null || r.project_id === undefined ? null : Number(r.project_id), profileId: r.profile_id === null || r.profile_id === undefined ? null : Number(r.profile_id), roleId: r.role_id === null || r.role_id === undefined ? null : Number(r.role_id), priority: r.priority ?? 'medium', status: r.status, agent: r.agent, machine: r.machine, cwd: r.cwd, sessionIds: r.session_ids ?? [], doneAt: r.done_at ? iso(r.done_at) : null, timerStartedAt: r.timer_since ? iso(r.timer_since) : null, queuedAt: r.queued_at ? iso(r.queued_at) : null })
// 排队态由 task_dispatch_queue 推导（任务被删时队列行随 FK 一起走）
const TASK_COLUMNS = `t.*, ARRAY(SELECT session_id FROM task_sessions s WHERE s.user_id=t.user_id AND s.task_id=t.id ORDER BY s.created_at,s.session_id) session_ids,
      (SELECT min(r.created_at) FROM runs r WHERE r.user_id=t.user_id AND r.task_id=t.id AND r.status IN ('queued','running')) timer_since,
      (SELECT q.created_at FROM task_dispatch_queue q WHERE q.user_id=t.user_id AND q.task_id=t.id) queued_at`

export async function migrateTasks(db: DB) {
  await db.query(`CREATE TABLE IF NOT EXISTS goals (
    id bigserial PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title text NOT NULL, notes text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','archived')),
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,id))`)
  await db.query(`ALTER TABLE goals ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('high','medium','low'))`)
  await db.query(`ALTER TABLE goals ADD COLUMN IF NOT EXISTS done_at timestamptz`)
  await db.query(`CREATE TABLE IF NOT EXISTS tasks (
    id bigserial PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    goal_id bigint REFERENCES goals(id) ON DELETE SET NULL, title text NOT NULL, notes text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','review','done')),
    agent text CHECK (agent IN ('claude','codex','doubao','workbuddy','zcode')), machine text, cwd text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), done_at timestamptz,
    UNIQUE(user_id,id))`)
  await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('high','medium','low'))`)
  // 执行工具从 claude/codex 扩到 doubao/workbuddy/zcode（后三者只做状态监听）：老库里的列级 CHECK 要换掉
  await db.query(`DO $$
  DECLARE def text;
  BEGIN
    SELECT pg_get_constraintdef(c.oid) INTO def FROM pg_constraint c
      WHERE c.conrelid = 'tasks'::regclass AND c.contype = 'c' AND c.conname = 'tasks_agent_check';
    IF def IS NOT NULL AND def NOT LIKE '%zcode%' THEN
      ALTER TABLE tasks DROP CONSTRAINT tasks_agent_check;
      def := NULL;
    END IF;
    IF def IS NULL THEN
      ALTER TABLE tasks ADD CONSTRAINT tasks_agent_check CHECK (agent IN ('claude','codex','doubao','workbuddy','zcode'));
    END IF;
  END $$`)
  for (const table of ['goals','tasks']) {
    await db.query(`ALTER TABLE ${table}
      ADD COLUMN IF NOT EXISTS start_at timestamptz,
      ADD COLUMN IF NOT EXISTS due_at timestamptz,
      ADD COLUMN IF NOT EXISTS remind_start boolean NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS remind_due boolean NOT NULL DEFAULT true`)
  }
  await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS checklist jsonb NOT NULL DEFAULT '[]'::jsonb`)
  // 执行边界：派活时定下来，代批先按它判，也拼进执行端的系统提示
  await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS constraints jsonb NOT NULL DEFAULT '{}'::jsonb`)
  // runs.task_id 指向任务；任务删除后执行记录保留，只解除关联
  await db.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runs_task_id_fkey') THEN
      ALTER TABLE runs ADD CONSTRAINT runs_task_id_fkey FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL;
    END IF;
  END $$`)
  await db.query(`CREATE TABLE IF NOT EXISTS entity_reminders (
    id bigserial PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id bigint REFERENCES tasks(id) ON DELETE CASCADE, goal_id bigint REFERENCES goals(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('start','due')), scheduled_at timestamptz NOT NULL, acked boolean NOT NULL DEFAULT false,
    CHECK ((task_id IS NULL) <> (goal_id IS NULL)),
    UNIQUE(task_id,kind,scheduled_at), UNIQUE(goal_id,kind,scheduled_at))`)
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
  return (await db.query(`SELECT ${TASK_COLUMNS}
    FROM tasks t WHERE user_id=$1 ORDER BY updated_at DESC,id DESC`, [user])).rows.map(task)
}
export async function getTask(db: DB, user: number, taskId: number): Promise<Task> {
  const r = await db.query(`SELECT ${TASK_COLUMNS}
    FROM tasks t WHERE user_id=$1 AND id=$2`, [user, taskId])
  if (!r.rows[0]) throw missing()
  return task(r.rows[0])
}
async function fields(db: DB, user: number, raw: unknown, isTask: boolean, create: boolean) {
  const b = object(raw), out: Record<string, unknown> = {}
  if (create || 'title' in b) out.title = text(b.title, '标题', 200)
  if ('notes' in b) out.notes = text(b.notes, '备注', 4000, true)
  for (const [key,column] of [['startAt','start_at'],['dueAt','due_at']] as const) if (key in b) {
    const value = b[key]
    if (value !== null && (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value)))) throw new TaskError('时间格式不合法，请提供含时区的日期时间')
    out[column] = value === null ? null : new Date(value as string).toISOString()
  }
  for (const [key,column] of [['remindStart','remind_start'],['remindDue','remind_due']] as const) if (key in b) {
    if (typeof b[key] !== 'boolean') throw new TaskError('提醒开关必须是布尔值')
    out[column] = b[key]
  }
  if (isTask && 'checklist' in b) {
    if (!Array.isArray(b.checklist) || b.checklist.length > 100) throw new TaskError('Checklist 最多支持 100 项')
    const seen = new Set<string>()
    out.checklist = JSON.stringify(b.checklist.map(raw => {
      const item = object(raw), key = text(item.id, '清单项 ID', 100)
      if (seen.has(key) || typeof item.done !== 'boolean') throw new TaskError('清单项 ID 须唯一，完成状态须为布尔值')
      seen.add(key)
      return { id: key, text: text(item.text, '清单项', 500), done: item.done }
    }))
  }
  if ('priority' in b) {
    if (!['high','medium','low'].includes(b.priority as string)) throw new TaskError('优先级不合法')
    out.priority = b.priority
  }
  // 执行边界只做声明：看不懂的目录会被丢掉，四项能力没声明就是不许
  if (isTask && 'constraints' in b) {
    if (b.constraints !== null && (typeof b.constraints !== 'object' || Array.isArray(b.constraints))) {
      throw new TaskError('执行边界格式不正确')
    }
    out.constraints = JSON.stringify(normalizeConstraints(b.constraints))
  }
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
      if (![null,'','claude','codex','doubao','workbuddy','zcode'].includes(b.agent as any)) throw new TaskError('请选择有效的执行工具')
      out.agent = b.agent || null
    }
    for (const key of ['machine','cwd']) if (key in b) out[key] = b[key] === null ? null : text(b[key], key === 'cwd' ? '项目目录' : '电脑名', 4000, true) || null
    if ('profileId' in b) {
      const p = b.profileId === null ? null : id(b.profileId)
      // 直接查表而不是引入 profiles.ts：两个模块互相依赖会成环
      if (p !== null && !(await db.query('SELECT id FROM profiles WHERE user_id=$1 AND id=$2', [user,p])).rowCount) throw new TaskError('配置不存在', 404)
      out.profile_id = p
    }
    if ('roleId' in b) {
      const r = b.roleId === null ? null : id(b.roleId)
      if (r !== null && !(await db.query('SELECT id FROM roles WHERE user_id=$1 AND id=$2', [user,r])).rowCount) throw new TaskError('角色不存在', 404)
      out.role_id = r
    }
    if ('projectId' in b) {
      const p = b.projectId === null ? null : id(b.projectId)
      if (p !== null && !(await db.query('SELECT id FROM projects WHERE user_id=$1 AND id=$2', [user,p])).rowCount) throw new TaskError('项目不存在', 404)
      out.project_id = p
    }
  }
  return out
}
async function validateSchedule(db: DB, user: number, table: 'goals'|'tasks', entityId: number | undefined, f: Record<string,unknown>) {
  const prev = entityId === undefined ? {} : (await db.query(`SELECT start_at,due_at FROM ${table} WHERE user_id=$1 AND id=$2`, [user,entityId])).rows[0] ?? {}
  const start = 'start_at' in f ? f.start_at : prev.start_at, due = 'due_at' in f ? f.due_at : prev.due_at
  if (start && due && new Date(start as string) > new Date(due as string)) throw new TaskError('截止时间不能早于开始时间')
}
export async function saveGoal(db: DB, user: number, raw: unknown, goalId?: number): Promise<Goal> {
  if (goalId !== undefined && !(await db.query('SELECT id FROM goals WHERE user_id=$1 AND id=$2', [user,goalId])).rowCount) throw missing()
  const f = await fields(db,user,raw,false,goalId === undefined)
  await validateSchedule(db,user,'goals',goalId,f)
  const keys = Object.keys(f), values = Object.values(f)
  const done = 'status' in f ? ",done_at=CASE WHEN $" + (keys.indexOf('status')+3) + "='done' THEN COALESCE(done_at,now()) ELSE NULL END" : ''
  const r = goalId === undefined
    ? await db.query(`INSERT INTO goals(user_id,${keys.join(',')}) VALUES($1,${keys.map((_,i) => `$${i+2}`).join(',')}) RETURNING *`, [user,...values])
    : await db.query(`UPDATE goals SET updated_at=now()${keys.map((k,i) => `,${k}=$${i+3}`).join('')}${done} WHERE user_id=$1 AND id=$2 RETURNING *`, [user,goalId,...values])
  if (!r.rows[0]) throw missing()
  return goal(r.rows[0])
}
export async function saveTask(db: DB, user: number, raw: unknown, taskId?: number): Promise<Task> {
  if (taskId !== undefined) await getTask(db,user,taskId)
  const f = await fields(db,user,raw,true,taskId === undefined)
  await validateSchedule(db,user,'tasks',taskId,f)
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
