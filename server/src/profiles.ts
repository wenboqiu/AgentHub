import { createHash } from 'node:crypto'
import type pg from 'pg'
import { TaskError, object, text, type ChecklistItem, type Task } from './tasks.ts'

// 项目配置：把「用哪个 agent、哪台电脑、哪个目录、默认优先级、验收要看哪几项」
// 收成一个有名字的东西。它不是给 agent 一个人格（那是执行端的事，AgentHub 改不到），
// 而是把一组执行环境 + 验收标准命名复用：建任务时选个名字，派活和验收标准就都就位了。

type DB = Pick<pg.Pool, 'query'>
export type Agent = 'claude' | 'codex' | 'doubao' | 'workbuddy' | 'zcode'
export type Priority = 'high' | 'medium' | 'low'
export type Profile = {
  id: number; name: string; agent: Agent | null; machine: string | null; cwd: string | null
  priority: Priority; checklist: string[]; tasks: number; createdAt: string; updatedAt: string
}

const AGENTS: Agent[] = ['claude', 'codex', 'doubao', 'workbuddy', 'zcode']
const PRIORITIES: Priority[] = ['high', 'medium', 'low']
const MAX_ITEMS = 30

export async function migrateProfiles(db: DB) {
  await db.query(`CREATE TABLE IF NOT EXISTS profiles (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    agent text CHECK (agent IN ('claude','codex','doubao','workbuddy','zcode')),
    machine text,
    cwd text,
    priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
    checklist jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(user_id, name),
    UNIQUE(user_id, id))`)
  // 执行工具扩到 zcode：老库里的列级 CHECK 要换掉
  await db.query(`DO $$
  DECLARE def text;
  BEGIN
    SELECT pg_get_constraintdef(c.oid) INTO def FROM pg_constraint c
      WHERE c.conrelid = 'profiles'::regclass AND c.contype = 'c' AND c.conname = 'profiles_agent_check';
    IF def IS NOT NULL AND def NOT LIKE '%zcode%' THEN
      ALTER TABLE profiles DROP CONSTRAINT profiles_agent_check;
      def := NULL;
    END IF;
    IF def IS NULL THEN
      ALTER TABLE profiles ADD CONSTRAINT profiles_agent_check CHECK (agent IN ('claude','codex','doubao','workbuddy','zcode'));
    END IF;
  END $$`)
  // 任务只记「属于哪个配置」；配置删掉后任务回到未指定，已有字段不动
  await db.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS profile_id bigint')
  await db.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_profile_id_fkey') THEN
      ALTER TABLE tasks ADD CONSTRAINT tasks_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE SET NULL;
    END IF;
  END $$`)
  await db.query('CREATE INDEX IF NOT EXISTS idx_tasks_profile ON tasks(user_id,profile_id)')
}

const row = (r: any): Profile => ({
  id: Number(r.id), name: r.name, agent: r.agent, machine: r.machine, cwd: r.cwd,
  priority: r.priority, checklist: r.checklist ?? [], tasks: Number(r.tasks ?? 0),
  createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
})

// 模板项在任务清单里的固定 key：由文本决定，所以改别的项不会让这一项变成一条新检查项
export const templateKey = (label: string) => `tpl-${createHash('sha1').update(label).digest('hex').slice(0, 10)}`
export const templateItems = (labels: string[]): ChecklistItem[] => labels.map(label => ({ id: templateKey(label), text: label, done: false }))

const COLUMNS = `p.*, (SELECT count(*) FROM tasks t WHERE t.user_id=p.user_id AND t.profile_id=p.id) tasks`

export async function listProfiles(db: DB, user: number): Promise<Profile[]> {
  return (await db.query(`SELECT ${COLUMNS} FROM profiles p WHERE p.user_id=$1 ORDER BY p.updated_at DESC,p.id DESC`, [user])).rows.map(row)
}

export async function getProfile(db: DB, user: number, profileId: number): Promise<Profile> {
  const r = await db.query(`SELECT ${COLUMNS} FROM profiles p WHERE p.user_id=$1 AND p.id=$2`, [user, profileId])
  if (!r.rows[0]) throw new TaskError('配置不存在', 404)
  return row(r.rows[0])
}

export async function findProfile(db: DB, user: number, profileId: number | null): Promise<Profile | null> {
  if (profileId === null) return null
  const r = await db.query(`SELECT ${COLUMNS} FROM profiles p WHERE p.user_id=$1 AND p.id=$2`, [user, profileId])
  return r.rows[0] ? row(r.rows[0]) : null
}

function checklistIn(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > MAX_ITEMS) throw new TaskError(`检查项最多 ${MAX_ITEMS} 条`)
  const seen = new Set<string>()
  return raw.map(v => {
    const label = text(v, '检查项', 500)
    const key = label.toLowerCase()
    if (seen.has(key)) throw new TaskError('检查项不能重复')
    seen.add(key)
    return label
  })
}

export async function saveProfile(db: DB, user: number, raw: unknown, profileId?: number): Promise<Profile> {
  const b = object(raw), out: Record<string, unknown> = {}
  if (profileId === undefined || 'name' in b) out.name = text(b.name, '配置名', 60)
  for (const key of ['machine', 'cwd'] as const) if (key in b) out[key] = b[key] === null ? null : text(b[key], key === 'cwd' ? '项目目录' : '电脑名', 4000, true) || null
  if ('agent' in b) {
    if (![null, '', ...AGENTS].includes(b.agent as any)) throw new TaskError('请选择有效的执行工具')
    out.agent = b.agent || null
  }
  if ('priority' in b) {
    if (!PRIORITIES.includes(b.priority as Priority)) throw new TaskError('优先级不合法')
    out.priority = b.priority
  }
  if ('checklist' in b) out.checklist = JSON.stringify(checklistIn(b.checklist))
  const keys = Object.keys(out), values = Object.values(out)
  let r
  try {
    r = profileId === undefined
      ? await db.query(`INSERT INTO profiles(user_id,${keys.join(',')}) VALUES($1,${keys.map((_,i) => `$${i+2}`).join(',')}) RETURNING id`, [user, ...values])
      : await db.query(`UPDATE profiles SET updated_at=now()${keys.map((k,i) => `,${k}=$${i+3}`).join('')} WHERE user_id=$1 AND id=$2 RETURNING id`, [user, profileId, ...values])
  } catch (e: any) {
    if (e?.code === '23505') throw new TaskError('已有同名配置', 409)
    throw e
  }
  if (!r.rows[0]) throw new TaskError('配置不存在', 404)
  return getProfile(db, user, Number(r.rows[0].id))
}

export async function deleteProfile(db: DB, user: number, profileId: number) {
  if (!(await db.query('DELETE FROM profiles WHERE user_id=$1 AND id=$2 RETURNING id', [user, profileId])).rowCount) throw new TaskError('配置不存在', 404)
}

/**
 * 把配置套到任务上：只补空着的字段，已经填过的一律不覆盖。
 * 检查项模板并入任务清单——模板项跟着配置走（换配置时移除未勾选的旧模板项），
 * 已勾选的项和手工加的项都保留。任务清单会自动同步成验收检查项。
 */
export async function applyProfile(db: DB, user: number, task: Task, profile: Profile): Promise<Partial<Task> & Record<string, unknown>> {
  const patch: Record<string, unknown> = { profileId: profile.id }
  if (!task.agent && profile.agent) patch.agent = profile.agent
  if (!task.machine && profile.machine) patch.machine = profile.machine
  if (!task.cwd && profile.cwd) patch.cwd = profile.cwd
  const wanted = templateItems(profile.checklist)
  const keep = new Set(wanted.map(i => i.id))
  const trimmed = task.checklist.filter(i => !i.id.startsWith('tpl-') || i.done || keep.has(i.id))
  const have = new Set(trimmed.map(i => i.id))
  const added = wanted.filter(i => !have.has(i.id))
  if (added.length || trimmed.length !== task.checklist.length) patch.checklist = [...trimmed, ...added]
  return patch
}
