import type pg from 'pg'
import { TaskError, object, text } from './tasks.ts'
import type { Agent } from './db.ts'

// 角色助手：在角色页里用一句话描述「要一个什么样的人」，由电脑端的 agent（Claude / Codex / ZCode）
// 整理成一份角色草稿，用户确认后才真正落库。
//
// 为什么走派活通道而不是服务端调大模型：AgentHub 服务端本来就没有任何模型凭据，
// 而用户电脑上已经登录着 Claude / Codex。代价是电脑必须在线、一次十几秒；
// 换来的是密钥、计费、模型名都不用管，和派活完全同一条链路。
//
// 一次「问」= 一个临时会话 + 一次 run：
//   ① 首条消息里放「输出格式契约 + 已有角色清单 + 用户原话」；
//   ② agent 回一段 JSON，run.message 到达时解析成草稿存库（assistant_drafts）；
//   ③ 用户在界面上改完点「创建角色」，才调 saveRole 真正写库。
// 草稿只认 JSON：解析失败时保留原文，界面提示重说一遍，绝不猜字段。

type DB = Pick<pg.Pool, 'query'>

export type Draft = {
  name: string
  title: string
  agent: Agent | null
  model: string | null
  context: string
  tools: string[]
  // 项目经理是组织上的安排，agent 不猜，留给人在草稿卡上勾；确认时一起落库
  manager?: boolean
  managerProjects?: number[]
  /** agent 自己交代的缺口或假设，不落库，只给人看 */
  note: string
}

export type DraftStatus = 'pending' | 'created' | 'discarded'
export type AssistantDraft = {
  id: number
  messageId: number
  draft: Draft | null
  raw: string
  status: DraftStatus
  roleId: number | null
  createdAt: string
}
export type AssistantThread = {
  id: number
  agent: Agent
  machine: string
  cwd: string
  sessionId: string | null
  lastRunId: string | null
  createdAt: string
  updatedAt: string
}

// 一个账号只留一条助手对话：换工具/换电脑就重开，不留历史包袱
export const MAX_MESSAGE = 4000
export const MAX_DRAFT_CONTEXT = 1500
/** 助手会话的标题前缀：会话列表里能认出来，通知也按它静音 */
export const ASSISTANT_TITLE = '角色助手：'
const MAX_TOOLS = 10
const ASSISTANTS: Agent[] = ['claude', 'codex', 'zcode']

export async function migrateAssistant(db: DB) {
  await db.query(`CREATE TABLE IF NOT EXISTS assistant_threads (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    agent text NOT NULL CHECK (agent IN ('claude','codex','zcode')),
    machine text NOT NULL,
    cwd text NOT NULL,
    last_run_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now())`)
  // 草稿挂在「哪条回复」上：同一条回复重复解析不会堆出多张卡
  await db.query(`CREATE TABLE IF NOT EXISTS assistant_drafts (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id bigint NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
    message_id bigint NOT NULL,
    run_id text NOT NULL,
    draft jsonb,
    raw text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','created','discarded')),
    role_id bigint REFERENCES roles(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, message_id))`)
  await db.query('CREATE INDEX IF NOT EXISTS idx_assistant_drafts_thread ON assistant_drafts(user_id, thread_id)')
}

// ---------- 提示词 ----------

/** 输出格式契约：字段名与 saveRole 对齐，长度上限留出余量（消息落库只有 4000 字） */
export const CONTRACT = `你在 AgentHub 里当「角色顾问」，把用户一句需求整理成一份角色草稿。

只回一个 JSON 对象（可以用 \`\`\`json 包起来），不要写任何解释、寒暄或额外段落。字段：
{"name":"角色名，不超过 60 字，必填","title":"一句话职责，不超过 120 字","agent":"claude | codex | zcode | codebuddy | null","model":"模型 id，不确定就 null","context":"这个角色的做事准则，不超过 1500 字","tools":["Read","Edit"],"note":"你还缺什么信息、替用户做了哪些假设"}

规矩：
- 信息不全也别反问，先给最合理的草稿，缺口写进 note，用户会在界面上改。
- agent 只能从 claude / codex / zcode / codebuddy 里选；用户没指定就按职责挑一个最合适的。
- model 写成执行端的模型 id（例如 opus、sonnet、gpt-6.1-sol）；拿不准一律 null，别编。
- context 写成对这个角色下的命令式约定：做什么、不做什么、改完怎么验证；不要复述用户原话。
- 不要读写任何文件，不要执行任何命令。
- 用户确认后才会真正创建角色，你只负责出草稿。`

/** 首条消息：契约 + 已有角色（防重名）+ 用户原话 */
export function openingMessage(input: {
  request: string
  roles: { name: string; title?: string }[]
}): string {
  const head = [CONTRACT]
  if (input.roles.length) head.push(`【已有角色】${input.roles.map(r => (r.title ? `${r.name}（${r.title}）` : r.name)).join('、')}\n不要重名；新角色和它们职责重叠时，note 里提醒一句。`)
  head.push(`【用户需求】${input.request}`)
  return head.join('\n\n')
}

/** 后续追问：契约已经在会话上下文里，这里只补一句提醒 + 原话 */
export function followupMessage(request: string): string {
  return `【用户需求】${request}\n\n（照旧只回那个 JSON 对象，按上面的调整重出一版草稿。）`
}

// ---------- 解析 ----------

const clamp = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replaceAll('\0', '').trim().slice(0, max) : ''

/** 从回复里抠出 JSON：先代码块，再整段花括号，最后逐行找 */
function candidates(raw: string): string[] {
  const out: string[] = []
  for (const m of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) out.push(m[1])
  const first = raw.indexOf('{'), last = raw.lastIndexOf('}')
  if (first >= 0 && last > first) out.push(raw.slice(first, last + 1))
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (t.startsWith('{') && t.endsWith('}')) out.push(t)
  }
  return out
}

/**
 * 把 agent 的回复解析成草稿。没有可用的 JSON（或连 name 都没有）就返回 null，
 * 由界面提示重说一遍——宁可没有草稿，也不要一份猜出来的角色。
 */
export function parseDraft(raw: string): Draft | null {
  for (const chunk of candidates(raw)) {
    let obj: Record<string, unknown>
    try {
      const parsed = JSON.parse(chunk)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      obj = parsed as Record<string, unknown>
    } catch { continue }
    const name = clamp(obj.name, 60)
    if (!name) continue
    const agent = ASSISTANTS.includes(obj.agent as Agent) ? (obj.agent as Agent) : null
    const tools = Array.isArray(obj.tools)
      ? [...new Set(obj.tools.map(t => clamp(t, 60)).filter(Boolean))].slice(0, MAX_TOOLS)
      : []
    return {
      name,
      title: clamp(obj.title, 120),
      agent,
      model: clamp(obj.model, 120) || null,
      context: clamp(obj.context, MAX_DRAFT_CONTEXT),
      tools,
      note: clamp(obj.note, 500),
    }
  }
  return null
}

// ---------- 状态 ----------

const threadRow = (r: any, sessionId: string | null): AssistantThread => ({
  id: Number(r.id), agent: r.agent, machine: r.machine, cwd: r.cwd,
  sessionId, lastRunId: r.last_run_id ?? null,
  createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
})

const draftRow = (r: any): AssistantDraft => ({
  id: Number(r.id), messageId: Number(r.message_id),
  draft: (r.draft ?? null) as Draft | null,
  raw: r.raw ?? '', status: r.status,
  roleId: r.role_id === null || r.role_id === undefined ? null : Number(r.role_id),
  createdAt: new Date(r.created_at).toISOString(),
})

export async function getThread(db: DB, user: number): Promise<AssistantThread | null> {
  const r = await db.query(
    `SELECT t.*, (SELECT r.session_id FROM runs r WHERE r.user_id = t.user_id AND r.id = t.last_run_id) session_id
     FROM assistant_threads t WHERE t.user_id = $1`,
    [user],
  )
  if (!r.rows[0]) return null
  const sessionId = r.rows[0].session_id ? String(r.rows[0].session_id) : null
  return threadRow(r.rows[0], sessionId)
}

/** 开新对话（或换执行工具重开）：旧草稿随旧 thread_id 一起清掉 */
export async function startThread(db: DB, user: number, input: { agent: unknown; machine: unknown; cwd: unknown }): Promise<AssistantThread> {
  const agent = input.agent
  if (!ASSISTANTS.includes(agent as Agent)) throw new TaskError('请选择 Claude、Codex 或 ZCode')
  const machine = text(input.machine, '电脑名', 200)
  // 空目录是有意义的输入：表示用电脑端自己的默认工作目录（<文档>/AgentHub，重装也还在）
  const cwd = typeof input.cwd === 'string' ? input.cwd.replaceAll('\0', '').trim().slice(0, 4000) : ''
  await db.query('DELETE FROM assistant_threads WHERE user_id = $1', [user])
  const r = await db.query(
    'INSERT INTO assistant_threads(user_id, agent, machine, cwd) VALUES($1,$2,$3,$4) RETURNING *',
    [user, agent, machine, cwd],
  )
  return threadRow(r.rows[0], null)
}

/** 每次派发都记下这一轮的 run：回复到达时靠它认出「这是我们助手的 run」 */
export async function markDispatch(db: DB, user: number, runId: string): Promise<void> {
  await db.query('UPDATE assistant_threads SET last_run_id = $2, updated_at = now() WHERE user_id = $1', [user, runId])
}

export async function threadByRun(db: DB, user: number, runId: string): Promise<{ id: number } | null> {
  const r = await db.query('SELECT id FROM assistant_threads WHERE user_id = $1 AND last_run_id = $2', [user, runId])
  return r.rows[0] ? { id: Number(r.rows[0].id) } : null
}

/** 这个会话是不是角色助手在用的那条（历史同步要放过它，草稿按消息 id 挂着） */
export async function isAssistantSession(db: DB, user: number, sessionId: string): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM assistant_threads t
     JOIN runs r ON r.user_id = t.user_id AND r.id = t.last_run_id
     WHERE t.user_id = $1 AND r.session_id = $2 LIMIT 1`,
    [user, sessionId],
  )
  return !!r.rows[0]
}

export async function listDrafts(db: DB, user: number, threadId: number): Promise<AssistantDraft[]> {
  return (await db.query('SELECT * FROM assistant_drafts WHERE user_id = $1 AND thread_id = $2 ORDER BY created_at, id', [user, threadId])).rows.map(draftRow)
}

export async function getDraft(db: DB, user: number, id: number): Promise<AssistantDraft> {
  const r = await db.query('SELECT * FROM assistant_drafts WHERE user_id = $1 AND id = $2', [user, id])
  if (!r.rows[0]) throw new TaskError('草稿不存在', 404)
  return draftRow(r.rows[0])
}

/**
 * agent 回了一条助手消息：落在助手会话里的就试着解析成草稿。
 * 解析不出来也留一条记录（draft 为空），界面上能显示原文并提示重说。
 */
export async function recordReply(db: DB, user: number, runId: string, messageId: number, raw: string): Promise<AssistantDraft | null> {
  const thread = await threadByRun(db, user, runId)
  if (!thread) return null
  const draft = parseDraft(raw)
  const r = await db.query(
    `INSERT INTO assistant_drafts(user_id, thread_id, message_id, run_id, draft, raw)
     VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, message_id) DO NOTHING RETURNING *`,
    [user, thread.id, messageId, runId, draft ? JSON.stringify(draft) : null, raw.slice(0, MAX_MESSAGE)],
  )
  return r.rows[0] ? draftRow(r.rows[0]) : null
}

/** 确认/丢弃：只有 pending 能改，避免重复创建同一个角色 */
export async function markDraft(db: DB, user: number, id: number, status: 'created' | 'discarded', roleId: number | null = null): Promise<AssistantDraft> {
  const r = await db.query(
    `UPDATE assistant_drafts SET status = $3, role_id = $4
     WHERE user_id = $1 AND id = $2 AND status = 'pending' RETURNING *`,
    [user, id, status, roleId],
  )
  if (!r.rows[0]) {
    const exists = await db.query('SELECT status FROM assistant_drafts WHERE user_id = $1 AND id = $2', [user, id])
    if (!exists.rows[0]) throw new TaskError('草稿不存在', 404)
    throw new TaskError('这张草稿已经处理过了', 409)
  }
  return draftRow(r.rows[0])
}

/** 确认时用户可能改过字段：只接受草稿里出现过的键，其余交给 saveRole 校验 */
export function draftPatch(raw: unknown): Record<string, unknown> {
  const b = object(raw ?? {})
  const out: Record<string, unknown> = {}
  for (const key of ['name', 'title', 'agent', 'model', 'context', 'tools', 'manager', 'managerProjects'] as const) {
    if (key in b) out[key] = b[key]
  }
  return out
}

export async function resetThread(db: DB, user: number): Promise<void> {
  await db.query('DELETE FROM assistant_threads WHERE user_id = $1', [user])
}
