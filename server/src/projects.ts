import type pg from 'pg'
import { TaskError, object, text } from './tasks.ts'

// 项目：一个代码库（或一条业务线）的身份与背景知识，加上它在各台电脑上的目录。
// 目录列表（dirs）直接挂在项目上：一条 = 电脑（可空，空 = 哪台都能用）+ 目录路径。
// 派活时按这次要去的机器自动挑对应那条，路径不会串设备；agent 归角色管，这里不管。
//
// 角色 × 项目 = 员工在某项目上的经验分区（见 memories.ts）。

type DB = Pick<pg.Pool, 'query'>
/** 项目在某台电脑上的目录；machine 为空 = 不绑机器（任意电脑可用） */
export type ProjectDir = { machine: string | null; cwd: string }
export type Project = {
  id: number; name: string; brief: string
  /** 每台电脑一条目录；派活时按机器挑 */
  dirs: ProjectDir[]
  tasks: number; createdAt: string; updatedAt: string
}

const MAX_NAME = 60
const MAX_BRIEF = 4000
const MAX_PROJECTS = 50
const MAX_DIRS = 10

export async function migrateProjects(db: DB) {
  await db.query(`CREATE TABLE IF NOT EXISTS projects (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    brief text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(user_id, name),
    UNIQUE(user_id, id))`)
  // 目录列表内嵌在项目行里：一条 = 电脑 + 路径，整存整取（编辑时整列替换）
  await db.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS dirs jsonb NOT NULL DEFAULT '[]'::jsonb`)
  // 老数据迁移：目录原来外挂成 profiles（project_profiles 中转），现在收进项目行。
  // 只在旧表还在的时候搬一次；新库从来没有这两张表，直接跳过。
  const legacy = (await db.query(
    `SELECT to_regclass('project_profiles') IS NOT NULL AS pp, to_regclass('profiles') IS NOT NULL AS pr`,
  )).rows[0] as { pp: boolean; pr: boolean }
  if (legacy.pp && legacy.pr) {
    await db.query(`UPDATE projects p SET dirs = sub.js FROM (
      SELECT pp.project_id, jsonb_agg(jsonb_build_object('machine', pr.machine, 'cwd', pr.cwd) ORDER BY pr.id) js
      FROM project_profiles pp JOIN profiles pr ON pr.id = pp.profile_id
      WHERE pr.cwd IS NOT NULL AND pr.cwd <> ''
      GROUP BY pp.project_id
    ) sub WHERE p.id = sub.project_id AND p.dirs = '[]'::jsonb`)
  }
  await db.query('DROP TABLE IF EXISTS project_profiles CASCADE')
  await db.query('DROP TABLE IF EXISTS profiles CASCADE')
  await db.query('ALTER TABLE projects DROP COLUMN IF EXISTS profile_id CASCADE')
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
  dirs: dirsOf(r.dirs),
  tasks: Number(r.tasks ?? 0),
  createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
})

/** 目录列表 defensively 解析：坏数据当空列表，不让一条脏 jsonb 把项目页打挂 */
const dirsOf = (v: unknown): ProjectDir[] => {
  if (!Array.isArray(v)) return []
  const out: ProjectDir[] = []
  for (const x of v) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) continue
    const o = x as Record<string, unknown>
    if (typeof o.cwd !== 'string' || !o.cwd) continue
    out.push({ machine: typeof o.machine === 'string' && o.machine ? o.machine : null, cwd: o.cwd })
  }
  return out
}

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
  let dirs: ProjectDir[] | null = null
  if ('dirs' in b) {
    if (!Array.isArray(b.dirs) || b.dirs.length > MAX_DIRS) throw new TaskError(`目录最多 ${MAX_DIRS} 条`)
    const seen = new Set<string>()
    dirs = b.dirs.map(x => {
      const o = object(x)
      const machine = ('machine' in o ? o.machine : null) === null || o.machine === '' ? null : text(o.machine, '电脑名', 4000, true) || null
      const cwd = text(o.cwd, '项目目录', 4000)
      const key = machine ?? ''
      if (seen.has(key)) throw new TaskError(machine ? `${machine} 已经有一条目录了` : '不绑机器的目录只能有一条')
      seen.add(key)
      return { machine, cwd }
    })
    out.dirs = JSON.stringify(dirs)
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
  return getProject(db, user, id)
}

export async function deleteProject(db: DB, user: number, projectId: number): Promise<number[]> {
  // 先记下挂在这个项目上的任务，删完要把它们推给客户端（project_id 会被 FK 置空）
  const affected = (await db.query('SELECT id FROM tasks WHERE user_id=$1 AND project_id=$2', [user, projectId])).rows.map(r => Number(r.id))
  if (!(await db.query('DELETE FROM projects WHERE user_id=$1 AND id=$2 RETURNING id', [user, projectId])).rowCount) throw new TaskError('项目不存在', 404)
  return affected
}

/**
 * 派活时给项目挑一条目录：
 * ① 和这次要去的那台电脑同名 → 目录肯定对；② 不绑机器的（哪台都能用）；
 * ③ 任意一条「电脑在线」的；④ 都没有就用第一条，让后面的报错去说明原因。
 */
export async function pickProjectDir(
  db: DB, user: number, projectId: number | null, machine: string, online: string[],
): Promise<ProjectDir | null> {
  if (projectId === null) return null
  const list = (await getProject(db, user, projectId)).dirs
  if (!list.length) return null
  if (machine) {
    const hit = list.find(d => d.machine === machine)
    if (hit) return hit
  }
  return list.find(d => !d.machine)
    ?? list.find(d => d.machine !== null && online.includes(d.machine))
    ?? list[0]
}

// ---------- 可选电脑（项目配置里的下拉项） ----------

/**
 * 一台候选电脑：online = 此刻有执行器连着；at = 最近一次在这台上干活的时间；
 * agents = 这台电脑上报过能跑的工具（claude / codex / zcode）。空 = 不知道（老客户端从没上报过），
 * 界面按「不确定」处理，别把没上报的机器一律判成不支持。
 */
export type Machine = { name: string; online: boolean; at: string | null; agents: string[] }

/**
 * 一个账号下见过的电脑，给项目配置的下拉框用：
 * ① 正在连着的执行器（一定要有，那是现在真能用上的）；
 * ② 会话 / 运行记录里出现过的机器名（离线也留着——给另一台电脑配目录是常事）；
 * ③ 项目配置里手填过的机器名（可能是还没装过 AgentHub 的新机器）。
 * 排序按「在线优先，其次最近用过」，人一眼能挑到常用的那台。
 */
export async function listMachines(
  db: DB, user: number, online: string[], caps: Map<string, string[]> = new Map(),
): Promise<Machine[]> {
  const [sessions, runs, projectDirs] = await Promise.all([
    db.query(`SELECT machine, max(updated_at) AS at FROM sessions
               WHERE user_id=$1 AND machine <> '' GROUP BY machine`, [user]),
    db.query(`SELECT machine, max(updated_at) AS at FROM runs
               WHERE user_id=$1 AND machine <> '' GROUP BY machine`, [user]),
    db.query(`SELECT dirs FROM projects WHERE user_id=$1 AND dirs <> '[]'::jsonb`, [user]),
  ])
  const seen = new Map<string, Machine>()
  const touch = (name: string, at: Date | null) => {
    if (!name) return
    const iso = at ? at.toISOString() : null
    const cur = seen.get(name)
    // 同一台可能在会话和运行里都有记录：留更近的那个时间
    if (!cur || (iso && (!cur.at || iso > cur.at))) seen.set(name, { name, online: cur?.online ?? false, at: iso, agents: cur?.agents ?? [] })
  }
  for (const r of sessions.rows as { machine: string; at: Date | null }[]) touch(r.machine, r.at)
  for (const r of runs.rows as { machine: string; at: Date | null }[]) touch(r.machine, r.at)
  for (const r of projectDirs.rows as { dirs: unknown }[]) {
    if (!Array.isArray(r.dirs)) continue
    for (const d of r.dirs) {
      if (!d || typeof d !== 'object') continue
      const m = (d as Record<string, unknown>).machine
      if (typeof m === 'string' && m) touch(m, null)
    }
  }
  for (const name of online) touch(name, null)
  for (const m of seen.values()) {
    m.online = online.includes(m.name)
    // 能力由执行器连上来时上报；离线保留最近一次上报的结果（只能来自内存，重启后清空）
    m.agents = caps.get(m.name) ?? []
  }
  return [...seen.values()].sort((a, b) =>
    Number(b.online) - Number(a.online)
    || (b.at ?? '').localeCompare(a.at ?? '')
    || a.name.localeCompare(b.name))
}

/**
 * 本机改名：把旧机器名下的会话 / 运行记录 / 项目目录一起挪到新名下。
 * 服务端是拿机器名当电脑身份的，名字一改旧记录就成了「另一台不存在的电脑」，
 * 项目配置的下拉里会多出一条谁也对应不上的选项，所以客户端改名时顺手把库里的记录也改掉。
 * 新名下已经有记录时按合并处理：项目目录留原来那条，会话 / 运行照常挪过去。
 */
export async function renameMachine(
  db: DB, user: number, rawFrom: unknown, rawTo: unknown,
): Promise<{ from: string; to: string; sessions: number; runs: number; projects: number }> {
  const from = text(rawFrom, '原电脑名', 100)
  const to = text(rawTo, '新电脑名', 100)
  if (from === to) throw new TaskError('两个名字一样，不用改')
  const sessions = (await db.query(
    'UPDATE sessions SET machine=$3 WHERE user_id=$1 AND machine=$2 RETURNING id', [user, from, to],
  )).rowCount ?? 0
  const runs = (await db.query(
    'UPDATE runs SET machine=$3 WHERE user_id=$1 AND machine=$2 RETURNING id', [user, from, to],
  )).rowCount ?? 0
  let projects = 0
  const rows = (await db.query(
    `SELECT id, dirs FROM projects WHERE user_id=$1 AND dirs <> '[]'::jsonb`, [user],
  )).rows as { id: number; dirs: unknown }[]
  for (const row of rows) {
    const dirs = dirsOf(row.dirs)
    if (!dirs.some(d => d.machine === from)) continue
    // 按原顺序就地改名；新名下本来就有一条时留原来那条，把改名过来的丢掉（不重排用户的列表）
    const hasTo = dirs.some(d => d.machine === to)
    const next = dirs
      .map(d => (d.machine === from ? { ...d, machine: to } : d))
      .filter((d, i) => !(hasTo && dirs[i].machine === from))
    await db.query('UPDATE projects SET dirs=$2::jsonb WHERE user_id=$1 AND id=$3', [user, JSON.stringify(next), Number(row.id)])
    projects++
  }
  return { from, to, sessions, runs, projects }
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
