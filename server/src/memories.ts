import type pg from 'pg'
import { TaskError, object, text } from './tasks.ts'
import type { Project } from './projects.ts'

// 角色记忆：员工「干过什么、被指出过什么」留下的经验条目。
// 作用域是「角色 × 项目」——project_id 为空表示跨项目的通用经验，
// 有值表示只在这个项目里生效。派活时按项目优先、权重次之挑一批注入。
//
// 为什么不用角色专属会话当记忆：一条 CLI 会话同时干多个活会串台，
// 而且内容不可编辑、不可审计。结构化条目才能让人删掉错的经验。

type DB = Pick<pg.Pool, 'query'>
export type MemorySource = 'manual' | 'review'
export type Memory = {
  id: number; roleId: number; projectId: number | null; content: string
  source: MemorySource; weight: number; uses: number
  lastUsedAt: string | null; createdAt: string; updatedAt: string
}

const MAX_CONTENT = 500
const MAX_MEMORIES_PER_SCOPE = 200
// 注入预算：角色准则 + 项目背景 + 经验三段合计不超过这个字数
export const MAX_INSTRUCTIONS = 5000

export async function migrateMemories(db: DB) {
  await db.query(`CREATE TABLE IF NOT EXISTS role_memories (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id bigint NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    project_id bigint REFERENCES projects(id) ON DELETE CASCADE,
    content text NOT NULL,
    source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','review')),
    weight integer NOT NULL DEFAULT 1,
    uses integer NOT NULL DEFAULT 0,
    last_used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now())`)
  await db.query('CREATE INDEX IF NOT EXISTS idx_role_memories_scope ON role_memories(user_id,role_id,project_id)')
}

const row = (r: any): Memory => ({
  id: Number(r.id), roleId: Number(r.role_id),
  projectId: r.project_id === null || r.project_id === undefined ? null : Number(r.project_id),
  content: r.content, source: r.source, weight: Number(r.weight), uses: Number(r.uses),
  lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
  createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
})

/** projectId 传 undefined 表示不筛项目（列出全部） */
export async function listMemories(db: DB, user: number, roleId: number, projectId?: number | null): Promise<Memory[]> {
  const where = projectId === undefined
    ? 'user_id=$1 AND role_id=$2'
    : projectId === null
      ? 'user_id=$1 AND role_id=$2 AND project_id IS NULL'
      : 'user_id=$1 AND role_id=$2 AND project_id=$3'
  const params = projectId === undefined || projectId === null ? [user, roleId] : [user, roleId, projectId]
  return (await db.query(`SELECT * FROM role_memories WHERE ${where} ORDER BY weight DESC, updated_at DESC, id DESC`, params)).rows.map(row)
}

/** 同一条经验重复出现时只加权重，不重复堆条目（打回原因尤其容易重复） */
export async function addMemory(db: DB, user: number, roleId: number, projectId: number | null, content: string, source: MemorySource = 'manual'): Promise<Memory> {
  const body = text(content, '记忆内容', MAX_CONTENT)
  const existing = await db.query(
    projectId === null
      ? 'SELECT id FROM role_memories WHERE user_id=$1 AND role_id=$2 AND project_id IS NULL AND content=$3'
      : 'SELECT id FROM role_memories WHERE user_id=$1 AND role_id=$2 AND project_id=$3 AND content=$4',
    projectId === null ? [user, roleId, body] : [user, roleId, projectId, body],
  )
  if (existing.rows[0]) {
    const r = await db.query(
      'UPDATE role_memories SET weight=weight+1, source=CASE WHEN $2=\'review\' THEN \'review\' ELSE source END, updated_at=now() WHERE id=$1 RETURNING *',
      [Number(existing.rows[0].id), source],
    )
    return row(r.rows[0])
  }
  const n = Number((await db.query(
    projectId === null
      ? 'SELECT count(*) c FROM role_memories WHERE user_id=$1 AND role_id=$2 AND project_id IS NULL'
      : 'SELECT count(*) c FROM role_memories WHERE user_id=$1 AND role_id=$2 AND project_id=$3',
    projectId === null ? [user, roleId] : [user, roleId, projectId],
  )).rows[0]?.c ?? 0)
  if (n >= MAX_MEMORIES_PER_SCOPE) throw new TaskError(`这个范围的记忆已有 ${MAX_MEMORIES_PER_SCOPE} 条，先删掉一些`)
  const r = await db.query(
    'INSERT INTO role_memories(user_id,role_id,project_id,content,source) VALUES($1,$2,$3,$4,$5) RETURNING *',
    [user, roleId, projectId, body, source],
  )
  return row(r.rows[0])
}

/** 记忆内容可以改（写错了就改，不要删了重加丢掉权重） */
export async function updateMemory(db: DB, user: number, roleId: number, memoryId: number, raw: unknown): Promise<Memory> {
  const b = object(raw)
  const content = text(b.content, '记忆内容', MAX_CONTENT)
  const r = await db.query(
    'UPDATE role_memories SET content=$4, updated_at=now() WHERE user_id=$1 AND role_id=$2 AND id=$3 RETURNING *',
    [user, roleId, memoryId, content],
  )
  if (!r.rows[0]) throw new TaskError('记忆不存在', 404)
  return row(r.rows[0])
}

export async function deleteMemory(db: DB, user: number, roleId: number, memoryId: number): Promise<void> {
  const r = await db.query('DELETE FROM role_memories WHERE user_id=$1 AND role_id=$2 AND id=$3 RETURNING id', [user, roleId, memoryId])
  if (!r.rowCount) throw new TaskError('记忆不存在', 404)
}

/** 项目内的经验排在通用经验前面；权重高的优先，用得少的优先（避免每次都只带同样几条） */
export async function pickMemories(db: DB, user: number, roleId: number, projectId: number | null, limit = 20): Promise<Memory[]> {
  const r = await db.query(
    `SELECT * FROM role_memories
      WHERE user_id=$1 AND role_id=$2 AND (project_id IS NULL OR project_id=$3)
      ORDER BY (project_id IS NULL) ASC, weight DESC, uses ASC, updated_at DESC
      LIMIT $4`,
    [user, roleId, projectId, limit],
  )
  return r.rows.map(row)
}

export async function markMemoriesUsed(db: DB, ids: number[]) {
  if (!ids.length) return
  await db.query('UPDATE role_memories SET uses=uses+1, last_used_at=now() WHERE id = ANY($1)', [ids])
}

export type InstructionInput = {
  /** 员工 */
  role: { name: string; title: string; context: string }
  /** 这次派活选中的项目，没选就是纯通用准则 */
  project: Pick<Project, 'name' | 'brief'> | null
  memories: string[]
}

/**
 * 把「员工是谁 + 在哪个项目 + 记得什么」拼成交给执行端的系统提示。
 * 分段而不是一大坨，是为了让模型能区分「长期准则」和「这个项目的经验」。
 * 超出预算时从最低优先级开始砍：通用经验 → 项目经验 → 项目背景 → 准则。
 */
export function composeInstructions({ role, project, memories }: InstructionInput): string {
  const head: string[] = []
  const who = role.name.trim()
  if (who || role.title.trim()) head.push(`【角色】${[who, role.title.trim()].filter(Boolean).join(' · ')}`)
  // 准则和项目背景各自先封顶，免得一条超长说明把经验全挤掉
  if (role.context.trim()) head.push(`【准则】${clamp(role.context.trim(), 2000)}`)

  const body: string[] = []
  if (project) {
    body.push(`【项目】${project.name}`)
    if (project.brief.trim()) body.push(`【项目背景】${clamp(project.brief.trim(), 1500)}`)
  }

  const base = assemble(head, body, []).length
  const room = MAX_INSTRUCTIONS - base - 20
  const picked: string[] = []
  let used = 0
  for (const m of memories) {
    const line = m.trim()
    if (!line || used + line.length > room) continue
    picked.push(`- ${line}`)
    used += line.length + 1
  }
  return assemble(head, body, picked)
}

const clamp = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`)

function assemble(head: string[], body: string[], picked: string[]): string {
  const parts = [...head, ...body]
  if (picked.length) parts.push(`【已知经验】\n${picked.join('\n')}`)
  return parts.join('\n\n')
}
