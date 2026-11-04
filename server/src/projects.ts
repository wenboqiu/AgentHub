import type pg from 'pg'
import { TaskError, object, text } from './tasks.ts'

// 项目：一个代码库（或一条业务线）的身份与背景知识。
// 和「项目配置(profile)」的分工——项目说的是「这是什么、有什么约定」，
// 配置说的是「在哪台电脑、哪个目录、按什么验收模板做」。项目可以指一套默认配置，
// 派活时任务没指定配置就用它；但项目本身不存机器和路径，避免两处各写一份。
//
// 角色 × 项目 = 员工在某项目上的经验分区（见 memories.ts）。

type DB = Pick<pg.Pool, 'query'>
export type Project = {
  id: number; name: string; brief: string; profileId: number | null
  tasks: number; createdAt: string; updatedAt: string
}

const MAX_NAME = 60
const MAX_BRIEF = 4000
const MAX_PROJECTS = 50

export async function migrateProjects(db: DB) {
  await db.query(`CREATE TABLE IF NOT EXISTS projects (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    brief text NOT NULL DEFAULT '',
    profile_id bigint REFERENCES profiles(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(user_id, name),
    UNIQUE(user_id, id))`)
  // 任务只记「属于哪个项目」；项目删掉后任务回到未归属，已派活字段不动
  await db.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_id bigint')
  await db.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_project_id_fkey') THEN
      ALTER TABLE tasks ADD CONSTRAINT tasks_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
    END IF;
  END $$`)
  await db.query('CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(user_id,project_id)')
}

const row = (r: any): Project => ({
  id: Number(r.id), name: r.name, brief: r.brief ?? '',
  profileId: r.profile_id === null || r.profile_id === undefined ? null : Number(r.profile_id),
  tasks: Number(r.tasks ?? 0),
  createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
})

const COLUMNS = `p.*, (SELECT count(*) FROM tasks t WHERE t.user_id=p.user_id AND t.project_id=p.id) tasks`

export async function listProjects(db: DB, user: number): Promise<Project[]> {
  return (await db.query(`SELECT ${COLUMNS} FROM projects p WHERE p.user_id=$1 ORDER BY p.updated_at DESC,p.id DESC`, [user])).rows.map(row)
}

export async function getProject(db: DB, user: number, projectId: number): Promise<Project> {
  const r = await db.query(`SELECT ${COLUMNS} FROM projects p WHERE p.user_id=$1 AND p.id=$2`, [user, projectId])
  if (!r.rows[0]) throw new TaskError('项目不存在', 404)
  return row(r.rows[0])
}

export async function findProject(db: DB, user: number, projectId: number | null): Promise<Project | null> {
  if (projectId === null) return null
  const r = await db.query(`SELECT ${COLUMNS} FROM projects p WHERE p.user_id=$1 AND p.id=$2`, [user, projectId])
  return r.rows[0] ? row(r.rows[0]) : null
}

export async function saveProject(db: DB, user: number, raw: unknown, projectId?: number): Promise<Project> {
  const b = object(raw), out: Record<string, unknown> = {}
  if (projectId === undefined || 'name' in b) out.name = text(b.name, '项目名', MAX_NAME)
  if ('brief' in b) out.brief = text(b.brief ?? '', '项目说明', MAX_BRIEF, true)
  if ('profileId' in b) {
    const p = b.profileId === null ? null : Number(b.profileId)
    if (p !== null && !(await db.query('SELECT id FROM profiles WHERE user_id=$1 AND id=$2', [user, p])).rowCount) throw new TaskError('配置不存在', 404)
    out.profile_id = p
  }
  if (projectId === undefined) {
    const n = Number((await db.query('SELECT count(*) c FROM projects WHERE user_id=$1', [user])).rows[0]?.c ?? 0)
    if (n >= MAX_PROJECTS) throw new TaskError(`项目最多 ${MAX_PROJECTS} 个`)
  }
  const keys = Object.keys(out), values = Object.values(out)
  let r
  try {
    r = projectId === undefined
      ? await db.query(`INSERT INTO projects(user_id,${keys.join(',')}) VALUES($1,${keys.map((_, i) => `$${i + 2}`).join(',')}) RETURNING id`, [user, ...values])
      : await db.query(`UPDATE projects SET updated_at=now()${keys.map((k, i) => `,${k}=$${i + 3}`).join('')} WHERE user_id=$1 AND id=$2 RETURNING id`, [user, projectId, ...values])
  } catch (e: any) {
    if (e?.code === '23505') throw new TaskError('已有同名项目', 409)
    throw e
  }
  if (!r.rows[0]) throw new TaskError('项目不存在', 404)
  return getProject(db, user, Number(r.rows[0].id))
}

export async function deleteProject(db: DB, user: number, projectId: number): Promise<number[]> {
  // 先记下挂在这个项目上的任务，删完要把它们推给客户端（project_id 会被 FK 置空）
  const affected = (await db.query('SELECT id FROM tasks WHERE user_id=$1 AND project_id=$2', [user, projectId])).rows.map(r => Number(r.id))
  if (!(await db.query('DELETE FROM projects WHERE user_id=$1 AND id=$2 RETURNING id', [user, projectId])).rowCount) throw new TaskError('项目不存在', 404)
  return affected
}
