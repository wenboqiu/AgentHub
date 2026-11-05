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
  id: number; name: string; brief: string
  /** 兜底配置：任务没指定配置、也没有更匹配的机器时用它；等于 profileIds 的第一个 */
  profileId: number | null
  /** 项目挂的所有执行配置（每台电脑一套）；派活时按当前机器挑 */
  profileIds: number[]
  tasks: number; createdAt: string; updatedAt: string
}

/** 派活只看这几个字段，不必把配置整套读出来 */
export type ProjectProfile = { id: number; name: string; agent: string | null; machine: string | null; cwd: string | null }

const MAX_NAME = 60
const MAX_BRIEF = 4000
const MAX_PROJECTS = 50
const MAX_PROFILES = 10

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
  // 一个项目可以挂多套执行配置（家里台式机的目录、Mac 上的目录各自一套），
  // 派活时按当前那台电脑挑，项目本身仍然不存路径。
  await db.query(`CREATE TABLE IF NOT EXISTS project_profiles (
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    profile_id bigint NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    PRIMARY KEY (project_id, profile_id))`)
  await db.query('CREATE INDEX IF NOT EXISTS idx_project_profiles_profile ON project_profiles(user_id, profile_id)')
  // 老数据：原来那个单一 profile_id 就是第一套
  await db.query(`INSERT INTO project_profiles(user_id, project_id, profile_id)
    SELECT user_id, id, profile_id FROM projects WHERE profile_id IS NOT NULL
    ON CONFLICT DO NOTHING`)
  // 任务只记「属于哪个项目」；项目删掉后任务回到未归属，已派活字段不动
  await db.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_id bigint')
  await db.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_project_id_fkey') THEN
      ALTER TABLE tasks ADD CONSTRAINT tasks_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
    END IF;
  END $$`)
  await db.query('CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(user_id,project_id)')
  // 项目近况：任务完成时往里追加一句结论，派活时取最近几条注入。
  // 和 projects.brief 的分工——brief 是「这个项目是什么」（人手写、不常改），
  // 这里是「最近发生了什么」（机器追加、滚动淘汰），后者才能让项目经理知道眼下的状态。
  await db.query(`CREATE TABLE IF NOT EXISTS project_brief_entries (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    text text NOT NULL,
    task_id bigint,
    created_at timestamptz NOT NULL DEFAULT now())`)
  // 同一任务只留一条近况：任务重进待验收时不会再添一遍
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_brief_task
    ON project_brief_entries(user_id, project_id, task_id) WHERE task_id IS NOT NULL`)
  await db.query('CREATE INDEX IF NOT EXISTS idx_brief_recent ON project_brief_entries(project_id, created_at DESC)')
}

const row = (r: any): Project => ({
  id: Number(r.id), name: r.name, brief: r.brief ?? '',
  profileId: r.profile_id === null || r.profile_id === undefined ? null : Number(r.profile_id),
  profileIds: (r.profile_ids ?? []).map((x: unknown) => Number(x)),
  tasks: Number(r.tasks ?? 0),
  createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
})

/** 配置编号数组：去重、丢掉非正整数，顺序保留（第一项当兜底） */
const numList = (v: unknown): number[] => {
  if (!Array.isArray(v)) return []
  const out: number[] = []
  for (const x of v) {
    const n = Number(x)
    if (Number.isSafeInteger(n) && n > 0 && !out.includes(n)) out.push(n)
  }
  return out
}

const COLUMNS = `p.*, (SELECT count(*) FROM tasks t WHERE t.user_id=p.user_id AND t.project_id=p.id) tasks,
  (SELECT coalesce(array_agg(pp.profile_id ORDER BY pp.profile_id), '{}') FROM project_profiles pp WHERE pp.project_id=p.id) profile_ids`

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
  // 新调用方传 profileIds（可多套）；只传 profileId 的老调用方按一套处理
  let profileIds: number[] | null = null
  if ('profileIds' in b) profileIds = numList(b.profileIds)
  else if ('profileId' in b) {
    const p = b.profileId === null ? null : Number(b.profileId)
    profileIds = p !== null && Number.isSafeInteger(p) && p > 0 ? [p] : []
  }
  if (profileIds !== null) {
    if (profileIds.length > MAX_PROFILES) throw new TaskError(`一个项目最多挂 ${MAX_PROFILES} 套配置`)
    if (profileIds.length) {
      const found = await db.query('SELECT id FROM profiles WHERE user_id=$1 AND id = ANY($2::bigint[])', [user, profileIds])
      if (found.rowCount !== profileIds.length) throw new TaskError('配置不存在', 404)
    }
    // 第一套当兜底：任务没指定配置、也没有机器能匹配时用它
    out.profile_id = profileIds[0] ?? null
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
  const id = Number(r.rows[0].id)
  if (profileIds !== null) {
    // 先插后删：中途失败最多多一条，不会先把现有配置删光
    if (profileIds.length) {
      await db.query(`INSERT INTO project_profiles(user_id, project_id, profile_id)
        SELECT $1, $2, unnest($3::bigint[]) ON CONFLICT DO NOTHING`, [user, id, profileIds])
    }
    await db.query('DELETE FROM project_profiles WHERE project_id=$1 AND NOT (profile_id = ANY($2::bigint[]))', [id, profileIds])
  }
  return getProject(db, user, id)
}

export async function deleteProject(db: DB, user: number, projectId: number): Promise<number[]> {
  // 先记下挂在这个项目上的任务，删完要把它们推给客户端（project_id 会被 FK 置空）
  const affected = (await db.query('SELECT id FROM tasks WHERE user_id=$1 AND project_id=$2', [user, projectId])).rows.map(r => Number(r.id))
  if (!(await db.query('DELETE FROM projects WHERE user_id=$1 AND id=$2 RETURNING id', [user, projectId])).rowCount) throw new TaskError('项目不存在', 404)
  return affected
}

/** 项目挂的所有执行配置，按编号排序（UI 另从 /profiles 拿全量，这里服务派活） */
export async function projectProfiles(db: DB, user: number, projectId: number): Promise<ProjectProfile[]> {
  const r = await db.query(
    `SELECT p.id, p.name, p.agent, p.machine, p.cwd FROM project_profiles pp
     JOIN profiles p ON p.user_id = pp.user_id AND p.id = pp.profile_id
     WHERE pp.user_id = $1 AND pp.project_id = $2 ORDER BY p.id`,
    [user, projectId],
  )
  return r.rows.map(x => ({ id: Number(x.id), name: x.name, agent: x.agent, machine: x.machine, cwd: x.cwd }))
}

/**
 * 派活时给项目挑一套配置：
 * ① 和这次要去的那台电脑同名 → 目录肯定对；② 没绑电脑的配置（哪台都能用）；
 * ③ 任意一套「电脑在线」的；④ 都没有就用第一套，让后面的报错去说明原因。
 */
export async function pickProjectProfile(
  db: DB, user: number, projectId: number | null, machine: string, online: string[],
): Promise<ProjectProfile | null> {
  if (projectId === null) return null
  const list = await projectProfiles(db, user, projectId)
  if (!list.length) return null
  if (machine) {
    const hit = list.find(p => p.machine === machine)
    if (hit) return hit
  }
  return list.find(p => !p.machine)
    ?? list.find(p => p.machine !== null && online.includes(p.machine))
    ?? list[0]
}

// ---------- 项目近况（滚动简报） ----------

export type BriefEntry = { id: number; text: string; taskId: number | null; at: string }

/** 每个项目留多少条：够说清「最近在做什么」，又不至于把注入预算挤满 */
const MAX_BRIEF_ENTRIES = 60
const MAX_BRIEF_TEXT = 240

const briefRow = (r: any): BriefEntry => ({
  id: Number(r.id),
  text: r.text,
  taskId: r.task_id === null || r.task_id === undefined ? null : Number(r.task_id),
  at: r.created_at.toISOString(),
})

/** 追加一条近况；同一个任务重复追加时忽略（唯一索引兜住），返回是否是新的 */
export async function appendBrief(
  db: DB, user: number, projectId: number, raw: string, taskId: number | null = null,
): Promise<boolean> {
  const body = raw.replaceAll('\0', '').replace(/\s+/g, ' ').trim().slice(0, MAX_BRIEF_TEXT)
  if (!body) return false
  const r = await db.query(
    `INSERT INTO project_brief_entries(user_id, project_id, text, task_id) VALUES($1,$2,$3,$4)
     ON CONFLICT DO NOTHING RETURNING id`,
    [user, projectId, body, taskId],
  )
  if (!r.rowCount) return false
  // 只留最近 N 条：简报是滚动窗口，不是流水账
  await db.query(
    `DELETE FROM project_brief_entries WHERE project_id=$1 AND id NOT IN (
       SELECT id FROM project_brief_entries WHERE project_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2)`,
    [projectId, MAX_BRIEF_ENTRIES],
  )
  return true
}

/** 派活时注入的几行（时间正序，读起来像一段进展记录） */
export async function recentBrief(db: DB, user: number, projectId: number | null, limit = 8): Promise<string[]> {
  if (projectId === null) return []
  const r = await db.query(
    `SELECT text FROM project_brief_entries WHERE user_id=$1 AND project_id=$2
      ORDER BY created_at DESC, id DESC LIMIT $3`,
    [user, projectId, limit],
  )
  return r.rows.map(x => x.text).reverse()
}

export async function listBrief(db: DB, user: number, projectId: number): Promise<BriefEntry[]> {
  const r = await db.query(
    `SELECT * FROM project_brief_entries WHERE user_id=$1 AND project_id=$2
      ORDER BY created_at DESC, id DESC LIMIT $3`,
    [user, projectId, MAX_BRIEF_ENTRIES],
  )
  return r.rows.map(briefRow)
}

/** 追加/删除都能用：传 text 是加一条，不传是删指定条目 */
export async function deleteBrief(db: DB, user: number, projectId: number, entryId: number): Promise<void> {
  const r = await db.query('DELETE FROM project_brief_entries WHERE user_id=$1 AND project_id=$2 AND id=$3 RETURNING id', [user, projectId, entryId])
  if (!r.rowCount) throw new TaskError('这条近况不存在', 404)
}
