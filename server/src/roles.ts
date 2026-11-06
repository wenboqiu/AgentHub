import type pg from 'pg'
import { TaskError, object, text, type Task } from './tasks.ts'
import type { Agent } from './db.ts'

// 角色：把一个「谁来做、用什么模型、按什么准则做」存成名字。
// 执行目录不归角色管——那是项目的事（项目上按电脑存目录，派活时按机器挑）。
// 注意上下文是「执行端真正收到的系统提示」，不是提醒文案：Claude 走 append-system-prompt，
// Codex 没有等价钩子，由执行器把上下文放在首条消息前面。

type DB = Pick<pg.Pool, 'query'>
export type Role = {
  id: number; name: string; title: string; agent: Agent | null; model: string | null; context: string
  tools: string[]; tasks: number; createdAt: string; updatedAt: string
}

const AGENTS: Agent[] = ['claude', 'codex', 'doubao', 'workbuddy', 'zcode']
const MAX_MODEL = 120
const MAX_CONTEXT = 4000
const MAX_TITLE = 120
const MAX_TOOLS = 30
const MAX_ROLES = 50

export async function migrateRoles(db: DB) {
  await db.query(`CREATE TABLE IF NOT EXISTS roles (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    title text NOT NULL DEFAULT '',
    agent text CHECK (agent IN ('claude','codex','doubao','workbuddy','zcode')),
    model text,
    context text NOT NULL DEFAULT '',
    tools jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(user_id, name),
    UNIQUE(user_id, id))`)
  // profiles 实体已废弃：角色的「默认配置」随之取消，列连带外键一起清掉（必须在建表之后）
  await db.query('ALTER TABLE roles DROP COLUMN IF EXISTS profile_id CASCADE')
  // 执行工具扩到 zcode：老库里的列级 CHECK 要换掉
  await db.query(`DO $$
  DECLARE def text;
  BEGIN
    SELECT pg_get_constraintdef(c.oid) INTO def FROM pg_constraint c
      WHERE c.conrelid = 'roles'::regclass AND c.contype = 'c' AND c.conname = 'roles_agent_check';
    IF def IS NOT NULL AND def NOT LIKE '%zcode%' THEN
      ALTER TABLE roles DROP CONSTRAINT roles_agent_check;
      def := NULL;
    END IF;
    IF def IS NULL THEN
      ALTER TABLE roles ADD CONSTRAINT roles_agent_check CHECK (agent IN ('claude','codex','doubao','workbuddy','zcode'));
    END IF;
  END $$`)
  // 老库补列：职责一句话、可用工具清单（只做声明，不改变执行端实际权限）
  await db.query("ALTER TABLE roles ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT ''")
  await db.query("ALTER TABLE roles ADD COLUMN IF NOT EXISTS tools jsonb NOT NULL DEFAULT '[]'::jsonb")
  // 任务只记「用哪个角色」；角色删掉后任务回到未指定，已派活字段不动
  await db.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS role_id bigint')
  await db.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_role_id_fkey') THEN
      ALTER TABLE tasks ADD CONSTRAINT tasks_role_id_fkey FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE SET NULL;
    END IF;
  END $$`)
  await db.query('CREATE INDEX IF NOT EXISTS idx_tasks_role ON tasks(user_id,role_id)')
}

const row = (r: any): Role => ({
  id: Number(r.id), name: r.name, title: r.title ?? '',
  agent: r.agent, model: r.model, context: r.context ?? '',
  tools: Array.isArray(r.tools) ? r.tools.filter((t: unknown): t is string => typeof t === 'string') : [],
  tasks: Number(r.tasks ?? 0),
  createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
})

const COLUMNS = `r.*, (SELECT count(*) FROM tasks t WHERE t.user_id=r.user_id AND t.role_id=r.id) tasks`

export async function listRoles(db: DB, user: number): Promise<Role[]> {
  return (await db.query(`SELECT ${COLUMNS} FROM roles r WHERE r.user_id=$1 ORDER BY r.updated_at DESC,r.id DESC`, [user])).rows.map(row)
}

export async function getRole(db: DB, user: number, roleId: number): Promise<Role> {
  const r = await db.query(`SELECT ${COLUMNS} FROM roles r WHERE r.user_id=$1 AND r.id=$2`, [user, roleId])
  if (!r.rows[0]) throw new TaskError('角色不存在', 404)
  return row(r.rows[0])
}

export async function findRole(db: DB, user: number, roleId: number | null): Promise<Role | null> {
  if (roleId === null) return null
  const r = await db.query(`SELECT ${COLUMNS} FROM roles r WHERE r.user_id=$1 AND r.id=$2`, [user, roleId])
  return r.rows[0] ? row(r.rows[0]) : null
}

export async function saveRole(db: DB, user: number, raw: unknown, roleId?: number): Promise<Role> {
  const b = object(raw), out: Record<string, unknown> = {}
  if (roleId === undefined || 'name' in b) out.name = text(b.name, '角色名', 60)
  if ('title' in b) out.title = text(b.title ?? '', '职责', MAX_TITLE, true)
  if ('agent' in b) {
    if (![null, '', ...AGENTS].includes(b.agent as any)) throw new TaskError('请选择有效的执行工具')
    out.agent = b.agent || null
  }
  if ('model' in b) out.model = b.model === null ? null : text(b.model, '模型', MAX_MODEL, true) || null
  if ('context' in b) out.context = text(b.context ?? '', '上下文', MAX_CONTEXT, true)
  if ('tools' in b) {
    if (!Array.isArray(b.tools) || b.tools.length > MAX_TOOLS) throw new TaskError(`可用工具最多 ${MAX_TOOLS} 项`)
    const seen = new Set<string>()
    out.tools = JSON.stringify(b.tools.map(raw => {
      const name = text(raw, '工具名', 60)
      if (seen.has(name)) throw new TaskError('工具名不能重复')
      seen.add(name)
      return name
    }))
  }
  if (roleId === undefined) {
    const n = Number((await db.query('SELECT count(*) c FROM roles WHERE user_id=$1', [user])).rows[0]?.c ?? 0)
    if (n >= MAX_ROLES) throw new TaskError(`角色最多 ${MAX_ROLES} 个`)
  }
  const keys = Object.keys(out), values = Object.values(out)
  let r
  try {
    r = roleId === undefined
      ? await db.query(`INSERT INTO roles(user_id,${keys.join(',')}) VALUES($1,${keys.map((_,i) => `$${i+2}`).join(',')}) RETURNING id`, [user, ...values])
      : await db.query(`UPDATE roles SET updated_at=now()${keys.map((k,i) => `,${k}=$${i+3}`).join('')} WHERE user_id=$1 AND id=$2 RETURNING id`, [user, roleId, ...values])
  } catch (e: any) {
    if (e?.code === '23505') throw new TaskError('已有同名角色', 409)
    throw e
  }
  if (!r.rows[0]) throw new TaskError('角色不存在', 404)
  return getRole(db, user, Number(r.rows[0].id))
}

export async function deleteRole(db: DB, user: number, roleId: number): Promise<number[]> {
  // 先记下挂在它上面的任务，删完要把这些任务推给客户端（role_id 会被 FK 置空）
  const affected = (await db.query('SELECT id FROM tasks WHERE user_id=$1 AND role_id=$2', [user, roleId])).rows.map(r => Number(r.id))
  if (!(await db.query('DELETE FROM roles WHERE user_id=$1 AND id=$2 RETURNING id', [user, roleId])).rowCount) throw new TaskError('角色不存在', 404)
  return affected
}

/**
 * 选角色后套到任务上：只补空着的执行工具，已选的不覆盖。
 * 目录不在这里补——那是派发时按项目目录按机器挑的事。
 */
export async function applyRole(db: DB, user: number, task: Task, role: Role): Promise<Partial<Task> & Record<string, unknown>> {
  const patch: Record<string, unknown> = { roleId: role.id }
  if (!task.agent && role.agent) patch.agent = role.agent
  return patch
}

/** 派活时角色的实际落点：模型为空就是「不覆盖执行端默认」；上下文与记忆另行拼装 */
export const roleModel = (role: Role | null) => role?.model ?? null
