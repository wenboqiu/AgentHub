import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import { listMessages, type Session } from './db.ts'
import { TaskError, type Task } from './tasks.ts'
import { readableNotes } from './attachments.ts'
import { harvestEvidence, type Evidence } from './review.ts'
import { NO_CONSTRAINTS, normalizeConstraints, hasConstraints, boundaryLine, type TaskConstraints } from './referee.ts'
import type { ProjectDir } from './projects.ts'
import { ASSISTANT_TITLE, CONTRACT_HEADS, PROPOSAL_TITLE } from './session-kind.ts'

// 处理意见（Proposal）：一个会话跑完后，先替人把「接下来该做什么」想好，放在会话上等人确认。
//
// 和角色助手（assistant.ts）的分工——助手是「从一句话造一个角色」，这里是「从一段刚结束的工作
// 攒出下一件事」。两者共用同一套范式：先出结构化草稿、人在界面上改、确认了才落库。
//
// 两段式，先建议后任务单（两档生成，缺一不可）：
//   ① 规则档（零成本、同步）：从最后一条助手回复、证据链、未完成清单里拼出底稿，几十毫秒；
//      会话跑完只落一条「建议」（stage=suggest）——一行「做什么 · 谁来做」，不叫模型。
//   ② 细化档（一次 run、要电脑在线）：人点「生成任务单」才展开全文（stage=draft），
//      同时把会话尾部交给项目经理角色用模型重写；写好了替换规则稿，电脑不在线就停在规则稿。
//
// 只有挂了未完成任务的会话才攒建议（没挂任务的闲聊不产单）。
//
// 一条会话可以有多次完成（多段任务），用 (session, event_at) 做唯一键：同一时刻只出一条，
// 新一轮完成（event_at 变了）才会再出一条。

type DB = Pick<pg.Pool, 'query'>

/** ticket = 人直接发的一张粗单：没有会话，先让人写一句话，项目经理细化后再由人确认派发 */
export type ProposalKind = 'continue' | 'followup' | 'fix' | 'ticket'
export type ProposalOrigin = 'heuristic' | 'agent'
/**
 * 开跑方式：
 * - fork = 接着原会话那条线（复制上下文，另起一个新会话）
 * - fresh = 新建会话，从这个任务开始
 * - resume = 接着上次派发出来的那个会话继续写（同一个对话，不新开）——
 *   只在派发侧按「同一任务重复派发」算出来，不接受人手工指定
 */
export type Delivery = 'fork' | 'fresh' | 'resume'
export type ProposalStatus = 'pending' | 'accepted' | 'discarded'
/**
 * 两段式：
 * - suggest = 建议：只有「做什么 · 谁来做」一行，会话跑完先给人看这个，零成本；
 * - draft = 任务单：完整草稿（说明 / 验收 / 边界 / 从哪开始），人点了「生成任务单」才进这一段。
 * 会话攒出来的意见从 suggest 起步；人直接发的单（ticket）和打回重做的单是现成的任务单，直接 draft。
 */
export type ProposalStage = 'suggest' | 'draft'
export type Priority = 'high' | 'medium' | 'low'

/** 项目经理安排好的执行人：角色是人、目录是地方（机器 + 目录来自项目的目录列表） */
export type Assignee = {
  roleId: number | null
  roleName: string
  roleTitle: string
  agent: string
  machine: string
  cwd: string
}

/**
 * 原会话本身能不能被续上：只描述会话这边的事实（工具支不支持、是不是还在跑）。
 * 「执行人是不是同一个工具/同一台电脑/同一个目录」属于派发那一刻才知道的事，
 * 由 planDelivery 拿这份事实和最终执行人去比。
 */
export type ForkInfo = {
  agent: string
  machine: string
  cwd: string
  /** 会话这一侧是否可续 */
  ok: boolean
  /** 不可续的原因；可续时为空 */
  reason: string
}

export type Proposal = {
  id: number
  sessionId: string
  sessionTitle: string
  sessionAgent: string
  sessionProject: string
  /** 生成时该会话挂着的未完成任务（可空） */
  taskId: number | null
  kind: ProposalKind
  /** 建议还是任务单：界面据此决定只给一行摘要，还是展开整张表单 */
  stage: ProposalStage
  title: string
  notes: string
  /** 只是文本；确认建任务时才补 id 和完成状态 */
  checklist: string[]
  /** 项目经理声明的执行边界：确认后原样落到任务上 */
  constraints: TaskConstraints
  /** 项目经理打算怎么开场；确认时可以改，派发时按条件裁一次 */
  delivery: Delivery
  /** 原会话能不能续（会话侧的事实，界面据此判断 fork 选项可不可点） */
  fork: ForkInfo
  priority: Priority
  roleId: number | null
  projectId: number | null
  /** 发单时人指定的地方（可空）：细化时项目经理在这上面做判断，确认后钉进任务 */
  machine: string
  cwd: string
  /** 读出来时按 role_id / project_id 展开成可展示的执行人（含机器与目录） */
  assignee: Assignee
  evidence: Evidence[]
  /** 生成方的补充说明（假设、缺口），不落进任务 */
  note: string
  origin: ProposalOrigin
  status: ProposalStatus
  /** 确认后生成的任务 */
  createdTaskId: number | null
  /** 正在跑细化的那次 run（回复到达时靠它认领） */
  refineRunId: string | null
  eventAt: string
  createdAt: string
  updatedAt: string
}

/** 待落库的一份草稿：规则档直接产出它，细化档从 JSON 解析出它 */
export type ProposalDraft = {
  kind: ProposalKind
  title: string
  notes: string
  checklist: string[]
  /** 执行边界；不声明就空着（没声明 = 不收窄，按全局策略代批） */
  constraints?: TaskConstraints
  /** 开跑方式；不声明就按 kind 给默认（接着做/先修 → 续上下文，新的一段 → 从零开始） */
  delivery?: Delivery
  priority: Priority
  roleId: number | null
  projectId: number | null
  note: string
}

const MAX_TITLE = 200
const MAX_NOTES = 4000
const MAX_ITEMS = 20
const MAX_ITEM = 200
const MAX_EVIDENCE = 6
/** 没声明去向时的默认：接着做 / 回去修沿用上下文，新的一段工作（含人直接发的单）从零开始 */
const defaultDelivery = (kind: ProposalKind): Delivery => (kind === 'followup' || kind === 'ticket' ? 'fresh' : 'fork')
/** 细化会话的标题前缀：这类会话不再生成新的处理意见（否则会无限套娃），也不弹通知 */
export { PROPOSAL_TITLE }

const EMPTY_ASSIGNEE: Assignee = {
  roleId: null, roleName: '', roleTitle: '', agent: '', machine: '', cwd: '',
}

/**
 * 能「接着原会话」的工具。豆包和 WorkBuddy 只听状态、根本没有可续的会话；
 * ZCode 能同目录新开，但没有按会话分叉的通道。这三家只能从零开始。
 */
const FORK_AGENTS = new Set(['claude', 'codex'])

const AGENT_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex', zcode: 'ZCode', doubao: '豆包', workbuddy: 'WorkBuddy', codebuddy: 'CodeBuddy' }
const agentName = (a: string): string => AGENT_NAME[a] ?? (a || '未知工具')

export const NO_FORK: ForkInfo = { agent: '', machine: '', cwd: '', ok: false, reason: '找不到原会话' }

/** 会话这一侧能不能续：工具支持 + 现在不在跑（在跑 / 等授权的会话进程还活着，续过去就是双写） */
export function forkInfo(s: Pick<Session, 'agent' | 'machine' | 'cwd' | 'state'>): ForkInfo {
  const base = { agent: s.agent, machine: s.machine, cwd: s.cwd }
  if (!FORK_AGENTS.has(s.agent)) return { ...base, ok: false, reason: `${agentName(s.agent)} 不能接着原会话` }
  if (s.state === 'running' || s.state === 'waiting') return { ...base, ok: false, reason: '原会话还在跑或等授权，等它结束才能续' }
  if (s.state === 'unknown') return { ...base, ok: false, reason: '原会话状态不明，先确认再续' }
  return { ...base, ok: true, reason: '' }
}

/** 'claude:xxx' → 'xxx'（会话键是 agent 自己那半截 id）；拆不出来返回空 */
export function sessionKeyOf(sessionId: string): string {
  return sessionId.includes(':') ? sessionId.slice(sessionId.indexOf(':') + 1) : ''
}

/**
 * 上一轮是不是因为「原会话在本机找不到了」而失败：transcript 被清掉、目录变了、换机回来，
 * `--resume` 都会直接报这个。这种情况下次派发不能再续同一个会话，否则每次重派都撞同一堵墙。
 */
export function missingSessionError(msg: string): boolean {
  const low = (msg ?? '').toLowerCase()
  if (/no conversation found|session not found|could not find (session|conversation)/.test(low)) return true
  return low.includes('会话') && (low.includes('找不到') || low.includes('不存在'))
}

/** 目录比较前先归一化：反斜杠、末尾斜杠、Windows 盘符大小写，否则同一目录会被误判成两个 */
export function normalizeCwd(p: string): string {
  const p2 = (p ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-zA-Z]:/.test(p2) ? p2[0].toLowerCase() + p2.slice(1) : p2
}

/**
 * 真的开跑时用什么方式。想续但条件不满足就退回 fresh —— 不悄悄按自己的想法做，
 * 退回的理由要能说清楚，否则人只会觉得「我明明选了接着做」。
 *
 * resume 与 fork 共用同一套「工具 / 电脑 / 目录必须一致」的判定，区别只在落到哪个会话：
 * fork 复制一份新会话，resume 直接续写原来的那条（时间轴上还是同一个对话）。
 */
export function planDelivery(want: Delivery, fork: ForkInfo, target: { agent: string; machine: string; cwd: string }): { mode: Delivery; reason: string } {
  if (want === 'fresh') return { mode: 'fresh', reason: '新建会话，从这个任务开始' }
  if (!fork.ok) return { mode: 'fresh', reason: fork.reason }
  if (target.agent !== fork.agent) {
    return { mode: 'fresh', reason: `执行人是 ${agentName(target.agent)}，原会话是 ${agentName(fork.agent)}，续不上` }
  }
  if (target.machine && target.machine.toLowerCase() !== fork.machine.toLowerCase()) {
    return { mode: 'fresh', reason: `换了电脑，原会话在 ${fork.machine}` }
  }
  if (target.cwd && normalizeCwd(target.cwd) !== normalizeCwd(fork.cwd)) {
    return { mode: 'fresh', reason: '任务目录和原会话不同，续不上上下文' }
  }
  if (want === 'resume') {
    return { mode: 'resume', reason: `接着上次派发的会话继续（${agentName(fork.agent)} · ${fork.machine}）` }
  }
  return { mode: 'fork', reason: `接着原会话的上下文（${agentName(fork.agent)} · ${fork.machine}）` }
}

export async function migrateProposals(db: DB) {
  await db.query(`CREATE TABLE IF NOT EXISTS session_proposals (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id text NOT NULL,
    session_title text NOT NULL DEFAULT '',
    session_agent text NOT NULL DEFAULT '',
    session_project text NOT NULL DEFAULT '',
    task_id bigint,
    event_at timestamptz NOT NULL,
    kind text NOT NULL CHECK (kind IN ('continue','followup','fix','ticket')),
    stage text NOT NULL DEFAULT 'draft',
    title text NOT NULL,
    notes text NOT NULL DEFAULT '',
    checklist jsonb NOT NULL DEFAULT '[]'::jsonb,
    constraints jsonb NOT NULL DEFAULT '{}'::jsonb,
    delivery text NOT NULL DEFAULT 'fresh',
    priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
    role_id bigint,
    project_id bigint,
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    note text NOT NULL DEFAULT '',
    origin text NOT NULL DEFAULT 'heuristic' CHECK (origin IN ('heuristic','agent')),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','discarded')),
    created_task_id bigint,
    refine_run_id text,
    machine text,
    cwd text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, session_id, event_at))`)
  await db.query('ALTER TABLE session_proposals ADD COLUMN IF NOT EXISTS refine_run_id text')
  // 老库清理：执行人挂的配置已废弃（目录收进项目），列直接删掉
  await db.query('ALTER TABLE session_proposals DROP COLUMN IF EXISTS profile_id')
  // 发单场景：人指定的电脑与目录跟着草稿走，确认时原样落到任务上
  await db.query('ALTER TABLE session_proposals ADD COLUMN IF NOT EXISTS machine text')
  await db.query('ALTER TABLE session_proposals ADD COLUMN IF NOT EXISTS cwd text')
  // kind 多出 ticket（人直接发的粗单）：老库的列级 CHECK 要换掉，否则插不进去
  await db.query('ALTER TABLE session_proposals DROP CONSTRAINT IF EXISTS session_proposals_kind_check')
  await db.query(`ALTER TABLE session_proposals ADD CONSTRAINT session_proposals_kind_check
    CHECK (kind IN ('continue','followup','fix','ticket'))`)
  await db.query(`ALTER TABLE session_proposals ADD COLUMN IF NOT EXISTS constraints jsonb NOT NULL DEFAULT '{}'::jsonb`)
  await db.query(`ALTER TABLE session_proposals ADD COLUMN IF NOT EXISTS delivery text NOT NULL DEFAULT 'fresh'`)
  // 两段式：老库里的单子都当成已经展开的任务单（默认 draft），不改动它们的行为
  await db.query(`ALTER TABLE session_proposals ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'draft'`)
  await db.query('ALTER TABLE session_proposals DROP CONSTRAINT IF EXISTS session_proposals_stage_check')
  await db.query(`ALTER TABLE session_proposals ADD CONSTRAINT session_proposals_stage_check
    CHECK (stage IN ('suggest','draft'))`)
  // 老库清理：历史上给没挂任务的会话也攒过意见，按新规矩它们不该存在——
  // 待确认的一律作废（人发的单 kind=ticket 例外，它本来就没有会话可挂）
  await db.query(`UPDATE session_proposals SET status='discarded', updated_at=now()
    WHERE status='pending' AND task_id IS NULL AND kind <> 'ticket'`)
  await db.query('CREATE INDEX IF NOT EXISTS idx_proposals_pending ON session_proposals(user_id,status,created_at DESC)')
  await db.query('CREATE INDEX IF NOT EXISTS idx_proposals_session ON session_proposals(user_id,session_id)')
  // 历史数据修复：内部会话的标题曾被本机 transcript 的契约提示词顶掉，会话列表里就露出一大段提示词原文。
  // 细化会话能按 refine_run_id 找回当时的任务单标题；助手会话没有可还原的名字，统一收成「角色助手」。
  // 只改标题仍是契约原文的那批（人自己改过的不动），改完不再命中，重复启动无副作用。
  await db.query(`UPDATE sessions s SET title = $2 || left(p.title, 40)
    FROM session_proposals p JOIN runs r ON r.id = p.refine_run_id AND r.user_id = p.user_id
   WHERE s.user_id = p.user_id AND s.id = r.session_id AND s.title LIKE $1 || '%'`,
    [CONTRACT_HEADS[0], PROPOSAL_TITLE])
  await db.query("UPDATE sessions SET title = $2 WHERE title LIKE $1 || '%'",
    [CONTRACT_HEADS[1], ASSISTANT_TITLE.replace(/：$/, '')])
}

const row = (r: any): Proposal => ({
  id: Number(r.id),
  sessionId: r.session_id,
  sessionTitle: r.session_title ?? '',
  sessionAgent: r.session_agent ?? '',
  sessionProject: r.session_project ?? '',
  taskId: r.task_id === null || r.task_id === undefined ? null : Number(r.task_id),
  kind: r.kind,
  stage: r.stage === 'suggest' ? 'suggest' : 'draft',
  title: r.title,
  notes: r.notes ?? '',
  checklist: Array.isArray(r.checklist) ? r.checklist.filter((t: unknown): t is string => typeof t === 'string') : [],
  constraints: normalizeConstraints(r.constraints),
  delivery: r.delivery === 'fork' ? 'fork' : 'fresh',
  // 会话侧的能力由 fillAssignees 补（这里没有会话信息）
  fork: NO_FORK,
  priority: r.priority ?? 'medium',
  roleId: r.role_id === null || r.role_id === undefined ? null : Number(r.role_id),
  projectId: r.project_id === null || r.project_id === undefined ? null : Number(r.project_id),
  machine: r.machine ?? '',
  cwd: r.cwd ?? '',
  assignee: EMPTY_ASSIGNEE,
  evidence: Array.isArray(r.evidence) ? r.evidence : [],
  note: r.note ?? '',
  origin: r.origin ?? 'heuristic',
  status: r.status,
  createdTaskId: r.created_task_id === null || r.created_task_id === undefined ? null : Number(r.created_task_id),
  refineRunId: r.refine_run_id ?? null,
  eventAt: new Date(r.event_at).toISOString(),
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
})

// ---------- 定执行人：项目经理要给出一张能直接开工的任务单 ----------

export type RoleLite = { id: number; name: string; title: string; agent: string }

export type AssigneeCtx = {
  roles: Map<number, RoleLite>
  /** 项目 → 它在各台电脑上的目录列表 */
  projectDirs: Map<number, ProjectDir[]>
}

/** 一次把角色、项目的目录读齐，批量展开时不做 N+1 */
async function assigneeCtx(db: DB, user: number): Promise<AssigneeCtx> {
  const [roles, projects] = await Promise.all([
    db.query('SELECT id,name,title,agent FROM roles WHERE user_id=$1', [user]),
    db.query('SELECT id,dirs FROM projects WHERE user_id=$1', [user]),
  ])
  return {
    roles: new Map(roles.rows.map((r: any) => [Number(r.id), {
      id: Number(r.id), name: r.name ?? '', title: r.title ?? '', agent: r.agent ?? '',
    }])),
    projectDirs: new Map(projects.rows.map((r: any) => [Number(r.id), Array.isArray(r.dirs) ? r.dirs as ProjectDir[] : []])),
  }
}

/** 角色 + 项目目录（按来源会话的机器挑），合成一份能显示、也能直接建任务的人选。
 *  override 是人自己指定过的机器/目录：他写了就按他的来——他比目录列表更清楚这单在哪台机器上做。 */
export function assigneeOf(
  ctx: AssigneeCtx, roleId: number | null, projectId: number | null, machineHint = '',
  override: { machine?: string; cwd?: string } = {},
): Assignee {
  const role = roleId === null ? null : ctx.roles.get(roleId) ?? null
  const dirs = projectId === null ? [] : ctx.projectDirs.get(projectId) ?? []
  const dir = pickDir(dirs, override.machine || machineHint)
  return {
    roleId: role?.id ?? null,
    roleName: role?.name ?? '',
    roleTitle: role?.title ?? '',
    agent: role?.agent || '',
    machine: override.machine || dir?.machine || '',
    cwd: override.cwd || dir?.cwd || '',
  }
}

/** 挑目录：来源会话那台电脑的 → 不绑机器的 → 第一条 */
function pickDir(dirs: ProjectDir[], machine: string): ProjectDir | null {
  if (!dirs.length) return null
  if (machine) {
    const hit = dirs.find(d => d.machine === machine)
    if (hit) return hit
  }
  return dirs.find(d => !d.machine) ?? dirs[0]
}

/**
 * 规则档挑人：不为「该谁做」打扰人，只用现成的事实。
 *   ① 这件事本来就有执行人（原任务的角色）→ 还找他，上下文最连续；
 *   ② 这个项目上做过活最多的角色 → 熟。
 *   ③ 只有一个人可选 → 就是他。
 * 项目经理自己不当执行人：它负责安排，不负责实现。
 */
export async function pickAssignee(db: DB, user: number, input: {
  taskRoleId: number | null
  projectId: number | null
  managerRoleId: number | null
}): Promise<{ roleId: number | null; reason: string }> {
  const keep = (roleId: number, reason: string) => ({ roleId, reason })
  if (input.taskRoleId !== null && input.taskRoleId !== input.managerRoleId) return keep(input.taskRoleId, '沿用原任务的执行人')
  if (input.projectId !== null) {
    const r = await db.query(
      `SELECT role_id FROM tasks
       WHERE user_id=$1 AND project_id=$2 AND role_id IS NOT NULL AND role_id <> COALESCE($3,0)
       GROUP BY role_id ORDER BY count(*) DESC, max(updated_at) DESC LIMIT 1`,
      [user, input.projectId, input.managerRoleId],
    )
    if (r.rows[0]) return keep(Number(r.rows[0].role_id), '这个项目上做过最多的是他')
  }
  const roles = await db.query('SELECT id FROM roles WHERE user_id=$1 AND id <> COALESCE($2,0) ORDER BY id LIMIT 2', [user, input.managerRoleId])
  if (roles.rowCount === 1) return keep(Number(roles.rows[0].id), '只有一个执行角色，先派给他')
  return { roleId: input.taskRoleId, reason: '没有可判断的依据，执行人留空由你选' }
}

/**
 * 批量展开执行人与「原会话能不能续」（列表与单条都走这里，保证界面看到的东西一致）。
 * 会话按一条 IN 查询捞回来，不做 N+1。
 */
export async function fillAssignees(db: DB, user: number, list: Proposal[]): Promise<Proposal[]> {
  if (!list.length) return list
  const ctx = await assigneeCtx(db, user)
  const ids = [...new Set(list.map(p => p.sessionId))]
  const sessions = new Map(
    (await db.query('SELECT id,agent,machine,cwd,state FROM sessions WHERE user_id=$1 AND id = ANY($2::text[])', [user, ids]))
      .rows.map((r: any) => [r.id as string, forkInfo({ agent: r.agent, machine: r.machine ?? '', cwd: r.cwd ?? '', state: r.state })]),
  )
  return list.map(p => ({
    ...p,
    assignee: assigneeOf(ctx, p.roleId, p.projectId, sessions.get(p.sessionId)?.machine ?? '',
      { machine: p.machine, cwd: p.cwd }),
    fork: sessions.get(p.sessionId) ?? NO_FORK,
  }))
}

// ---------- 规则档：从已有材料里拼一份草稿 ----------

/** 收尾语里常见的「下一步」信号。只认这些词，宁可漏也不乱抓。 */
const NEXT_RE = /(?:下一步|接下来|后续|建议|还需要|需要你|请你|待办|TODO|未完成|可以再|然后再|下一轮)/
/** 测试失败、报错的信号 */
const FAIL_RE = /(?:\bfailed\b|\bfailing\b|✗|✘|\bFAIL\b|\bError\b|Traceback|Exception|panic:)/

const stripMd = (s: string): string =>
  s.replace(/^[\s>#\-*+]+/, '')
    .replace(/^\d+[.、)]\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim()

/** 从最后回复里倒着找一句像「下一步」的话 */
export function nextStepLine(text: string): string {
  const lines = text.split(/\n+/).map(stripMd).filter(Boolean)
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 15; i--) {
    const line = lines[i]
    if (line.length < 6 || line.length > 180) continue
    if (NEXT_RE.test(line)) return line.slice(0, 120)
  }
  return ''
}

const evidenceGroups = (ev: Evidence[]): string => {
  const byKind = new Map<string, string[]>()
  for (const e of ev) {
    const list = byKind.get(e.kind) ?? []
    if (list.length < 3) list.push(e.value.slice(0, 120))
    byKind.set(e.kind, list)
  }
  const label: Record<string, string> = { file: '改动文件', command: '执行命令', test: '测试结果', shot: '截图', log: '错误日志' }
  return [...byKind].map(([k, v]) => `- ${label[k] ?? k}：${v.join('；')}`).join('\n')
}

/**
 * 规则档生成：不调模型，只做「看得见的事实 + 一句收尾语」的拼装。
 * 返回 null 表示这段会话没有值得跟进的东西（空回复、纯问答、被打断）——宁可不打扰。
 */
export function heuristicDraft(input: {
  session: Pick<Session, 'title' | 'agent' | 'project'>
  task: Task | null
  lastReply: string
  evidence: Evidence[]
}): ProposalDraft | null {
  const { session, task, lastReply, evidence } = input
  const todo = task ? task.checklist.filter(i => !i.done).map(i => i.text) : []
  const failedTest = evidence.find(e => e.kind === 'test' && FAIL_RE.test(e.value))
  const errorLog = evidence.find(e => e.kind === 'log' && FAIL_RE.test(e.value))
  const step = nextStepLine(lastReply)

  // ① 原任务没做完：接着做，清单直接沿用未完成项
  if (task && todo.length) {
    return {
      kind: 'continue',
      title: `继续：${todo[0]}`.slice(0, MAX_TITLE),
      notes: [
        `来源会话：${session.title || '未命名会话'}（${session.agent}${session.project ? ` · ${session.project}` : ''}）`,
        task.notes ? `原任务：${readableNotes(task.notes).slice(0, 800)}` : '',
        lastReply ? `本次进展：\n${lastReply.slice(-800)}` : '',
        evidence.length ? `证据：\n${evidenceGroups(evidence)}` : '',
      ].filter(Boolean).join('\n\n'),
      checklist: todo.slice(0, MAX_ITEMS).map(t => t.slice(0, MAX_ITEM)),
      // 接着做同一件事：边界沿用原任务，不要因为换了会话就悄悄放开
      constraints: task.constraints,
      // 上下文就在刚才那个会话里：接着做、回去修，都该续上；续不上派发时会自动退回新会话
      delivery: 'fork',
      priority: task.priority === 'high' ? 'high' : 'medium',
      roleId: task.roleId,
      projectId: task.projectId,
      note: '原任务的清单还没走完，标题取的是第一项未完成项，可以改。',
    }
  }

  // ② 有测试失败或报错：先修
  const broken = failedTest ?? errorLog
  if (broken) {
    const head = stripMd(broken.value.split('\n')[0] ?? '').slice(0, 100)
    return {
      kind: 'fix',
      title: `修复：${head}`.slice(0, MAX_TITLE),
      notes: [
        `来源会话：${session.title || '未命名会话'}（${session.agent}${session.project ? ` · ${session.project}` : ''}）`,
        `失败现场：\n${broken.value.slice(0, 800)}`,
        lastReply ? `会话结论：\n${lastReply.slice(-600)}` : '',
        evidence.length ? `证据：\n${evidenceGroups(evidence)}` : '',
      ].filter(Boolean).join('\n\n'),
      checklist: [],
      priority: 'high',
      delivery: 'fork',
      roleId: task?.roleId ?? null,
      projectId: task?.projectId ?? null,
      note: '会话里留下了失败信号，按高优先级处理；确认后建议直接派回同一个角色。',
    }
  }

  // ③ 收尾语里明说了下一步
  if (step) {
    return {
      kind: 'followup',
      title: step.slice(0, MAX_TITLE),
      notes: [
        `来源会话：${session.title || '未命名会话'}（${session.agent}${session.project ? ` · ${session.project}` : ''}）`,
        lastReply ? `会话结尾：\n${lastReply.slice(-1000)}` : '',
        evidence.length ? `证据：\n${evidenceGroups(evidence)}` : '',
      ].filter(Boolean).join('\n\n'),
      checklist: [],
      priority: 'medium',
      // 新的一段工作：另起会话，只带任务单里的说明
      delivery: 'fresh',
      roleId: task?.roleId ?? null,
      projectId: task?.projectId ?? null,
      note: '标题是从会话收尾的那句话里摘的，确认前改成可执行的写法更好。',
    }
  }

  // ④ 兜底：回复有实质内容但没明说下一步
  if (lastReply.trim().length >= 40) {
    return {
      kind: 'followup',
      title: `跟进：${(session.title || '本次会话').slice(0, 60)}`,
      notes: [
        `来源会话：${session.title || '未命名会话'}（${session.agent}${session.project ? ` · ${session.project}` : ''}）`,
        `会话结尾：\n${lastReply.slice(-1000)}`,
        evidence.length ? `证据：\n${evidenceGroups(evidence)}` : '',
      ].filter(Boolean).join('\n\n'),
      checklist: [],
      priority: 'medium',
      // 新的一段工作：另起会话，只带任务单里的说明
      delivery: 'fresh',
      roleId: task?.roleId ?? null,
      projectId: task?.projectId ?? null,
      note: '没从回复里找到明确的下一步，标题只是占位；点「让项目经理细化」会更准。',
    }
  }

  return null
}

/**
 * 会话完成时调用：取最后回复、证据、未完成任务，攒一条待确认的意见。
 * 只对挂了未完成任务的会话生成（没挂任务的会话不产单）；同一 (会话, 完成时刻) 只留一条，已有则返回 null。
 */
export async function generateProposal(pool: pg.Pool, userId: number, session: Session, eventAt: string): Promise<Proposal | null> {
  const task = (
    await pool.query<Task>(
      `SELECT t.* FROM task_sessions ts JOIN tasks t ON t.user_id=ts.user_id AND t.id=ts.task_id
       WHERE ts.user_id=$1 AND ts.session_id=$2 AND t.status <> 'done'
       ORDER BY t.updated_at DESC, t.id DESC LIMIT 1`,
      [userId, session.id],
    )
  ).rows[0] ?? null
  // 没挂任务（或挂着的任务已完结）就不攒意见：任务单只跟着派过的事走，闲聊不产单
  if (!task) return null
  const msgs = await listMessages(pool, userId, session.id, 40)
  let lastReply = ''
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'assistant' && msgs[i].text.trim()) { lastReply = msgs[i].text; break }
  const evidence = harvestEvidence(msgs.map(m => ({ role: m.role, text: m.text, createdAt: m.createdAt }))).slice(0, MAX_EVIDENCE)
  const draft = heuristicDraft({ session, task, lastReply, evidence })
  if (!draft) return null
  // 会话只记了项目名：能对上号就归到那个项目，执行人才能按「这个项目上谁做过」来挑
  if (draft.projectId === null && session.project) {
    const p = await pool.query('SELECT id FROM projects WHERE user_id=$1 AND name=$2', [userId, session.project])
    if (p.rows[0]) draft.projectId = Number(p.rows[0].id)
  }
  // 项目经理定执行人：这一步是「意见」变成「任务单」的关键，人手不够时也得给个可解释的默认
  const manager = (await pool.query('SELECT role_id FROM dispatch_manager WHERE user_id=$1', [userId])).rows[0]
  const pick = await pickAssignee(pool, userId, {
    taskRoleId: draft.roleId,
    projectId: draft.projectId,
    managerRoleId: manager?.role_id === null || manager?.role_id === undefined ? null : Number(manager.role_id),
  })
  draft.roleId = pick.roleId
  draft.note = [draft.note, `执行人：${pick.reason}。`].filter(Boolean).join(' ')
  const saved = await saveProposal(pool, userId, {
    sessionId: session.id,
    sessionTitle: session.title,
    sessionAgent: session.agent,
    sessionProject: session.project,
    taskId: task ? Number(task.id) : null,
    eventAt,
    evidence,
    origin: 'heuristic',
    // 只先给一条建议：标题 + 执行人一行，人点了「生成任务单」才展开全文并让项目经理细化
    stage: 'suggest',
    draft,
  })
  return saved ? (await fillAssignees(pool, userId, [saved]))[0] : null
}

async function saveProposal(pool: DB, userId: number, input: {
  sessionId: string
  sessionTitle: string
  sessionAgent: string
  sessionProject: string
  taskId: number | null
  eventAt: string
  evidence: Evidence[]
  origin: ProposalOrigin
  /** 不传 = draft（发单、打回重做这类一上来就是任务单的） */
  stage?: ProposalStage
  draft: ProposalDraft
}): Promise<Proposal | null> {
  const r = await pool.query(
    `INSERT INTO session_proposals(
       user_id,session_id,session_title,session_agent,session_project,task_id,event_at,
       kind,title,notes,checklist,constraints,delivery,priority,role_id,project_id,evidence,note,origin,stage)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT (user_id,session_id,event_at) DO NOTHING RETURNING *`,
    [userId, input.sessionId, input.sessionTitle.slice(0, 200), input.sessionAgent, input.sessionProject.slice(0, 200),
      input.taskId, input.eventAt, input.draft.kind, input.draft.title.slice(0, MAX_TITLE),
      input.draft.notes.slice(0, MAX_NOTES), JSON.stringify(input.draft.checklist),
      JSON.stringify(normalizeConstraints(input.draft.constraints)),
      input.draft.delivery ?? defaultDelivery(input.draft.kind),
      input.draft.priority, input.draft.roleId, input.draft.projectId,
      JSON.stringify(input.evidence), input.draft.note.slice(0, 500), input.origin, input.stage ?? 'draft'],
  )
  const inserted = r.rows[0]
  if (!inserted) return null
  // 同一件事反复跑完（做完 → 被打回 → 又跑完）会攒出好几张几乎一样的任务单，
  // 新的进来就把旧的待处理意见作废，只留一张等人确认。
  // 挂了任务按任务收；没挂任务按会话收——否则同一会话里的两件不同的事会互相顶掉。
  // 放在插入之后：命中 (session, event_at) 去重时说明这一条已经存在，不作废任何人。
  await pool.query(
    `UPDATE session_proposals SET status='discarded'
      WHERE user_id=$1 AND status='pending' AND id<>$3
        AND ${input.taskId === null ? 'task_id IS NULL AND session_id=$2' : 'task_id=$2'}`,
    [userId, input.taskId === null ? input.sessionId : input.taskId, inserted.id],
  )
  return row(inserted)
}

// ---------- 细化档：让项目经理角色重写 ----------

export const REFINE_CONTRACT = `你在 AgentHub 里当项目经理，读完一段刚结束的会话，写一张能直接开工的任务单。

只回一个 JSON 对象（可以用 \`\`\`json 包起来），不要写解释、寒暄或额外段落。字段：
{"kind":"continue | followup | fix","title":"任务标题","notes":"背景与验证方式","checklist":["验收要点"],"priority":"high | medium | low","roleId":null,"projectId":null,"delivery":"fork | fresh","constraints":{"paths":["允许改的相对目录"],"net":false,"push":false,"scripts":false,"note":"一句话边界"},"note":"你的判断依据或缺口"}

规矩：
- title 动词开头，说清「接下来做什么」，不超过 80 字；不要复述会话内容。
- kind：continue = 原任务没做完接着做；followup = 已交付但还有下一步；fix = 有报错或测试失败要先修。
- notes 写给接手的人看：已经做到哪、已知结论、怎么验证，不超过 2000 字，别抄原文。
- checklist 是验收要点，最多 8 条、每条不超过 100 字；想不出来就给空数组。
- priority：卡住别人、线上问题、有失败测试的给 high；普通改进给 medium。
- roleId 是执行人：从【可用角色】里挑最合适的编号，优先已经在这个项目/这段会话里做过活的角色；
  没有把握就沿用原任务的执行人；实在没有合适的给 null，让人来定。你自己不做实现。
- projectId 只能取【可用项目】里的编号，判断不了就给 null。
- delivery 是执行者怎么开场：fork = 接着这段会话的上下文继续（同一套判断、同一个思路），
  fresh = 另起一个会话从这个任务本身开始。continue 和 fix 一般给 fork；followup 是新的一段工作，
  给 fresh 更省上下文。只有执行人和原会话是同一个工具、同一台电脑、同一个目录时才续得上，
  续不上会自动退回 fresh，所以你按「哪种更合适」写就行，不用替它判断可行性。
- constraints 是这个任务的执行边界，执行中超出边界的动作会停下来问人，所以按「这个任务真的需要什么」写：
  · paths：这个任务预计要改哪些目录（相对项目根的路径前缀，如 "server/src"、"docs"）。空数组 = 不限目录，能少写就少写。
  · net：需要装依赖或调用外部接口才 true；push：任务明确要求提交推送才 true；scripts：需要跑项目自定义脚本（npm run xxx 之类）才 true。
  · 拿不准就一律 false —— 判不准的动作会停下来问人，比放开安全，也不会打断太久。
  · note：一句话说明边界理由（如「只动服务端，前端这次不碰」），会拼进执行者的系统提示。
- 如果这段会话没有值得继续做的事（闲聊、被打断、没有产出），只回 {"skip":true}。
- 不要读写文件、不要执行命令；你只负责出任务单，人确认后才会建任务并派发。`

/** 首条消息：契约 + 会话尾部 + 已有材料 + 可选的角色/项目清单 */
export function refineMessage(input: {
  sessionTitle: string
  agent: string
  project: string
  task: { title: string; notes: string; todo: string[] } | null
  tail: { role: string; text: string }[]
  evidence: Evidence[]
  draft: { title: string; notes: string; checklist: string[]; assignee?: string; constraints?: TaskConstraints; delivery?: Delivery } | null
  roles: { id: number; name: string; title: string; agent?: string }[]
  projects: { id: number; name: string }[]
}): string {
  const parts = [REFINE_CONTRACT]
  parts.push(`【会话】${input.sessionTitle || '未命名会话'}（${input.agent}${input.project ? ` · ${input.project}` : ''}）`)
  if (input.task) {
    const todo = input.task.todo.length ? `\n未完成清单：${input.task.todo.join('；')}` : ''
    parts.push(`【当时挂着的任务】${input.task.title}${input.task.notes ? `\n说明：${readableNotes(input.task.notes).slice(0, 600)}` : ''}${todo}`)
  }
  if (input.tail.length) {
    parts.push(`【会话最后几条】\n${input.tail.map(m => `${m.role === 'user' ? '用户' : '助手'}：${m.text.slice(0, 700)}`).join('\n\n')}`)
  }
  if (input.evidence.length) {
    parts.push(`【已有证据】\n${input.evidence.slice(0, 8).map(e => `- ${e.label}：${e.value.slice(0, 160)}`).join('\n')}`)
  }
  if (input.draft) {
    parts.push(`【规则档草稿，供参考，可以推翻】\n标题：${input.draft.title}\n说明：${input.draft.notes.slice(0, 600)}`
      + (input.draft.checklist.length ? `\n清单：${input.draft.checklist.join('；')}` : '')
      + (input.draft.assignee ? `\n现在的执行人：${input.draft.assignee}` : '')
      + `\n现在的去向：${input.draft.delivery === 'fork' ? '接着原会话' : '从零开始'}`
      + (input.draft.constraints && hasConstraints(input.draft.constraints) ? `\n现在声明的边界：${boundaryLine(input.draft.constraints)}` : ''))
  }
  if (input.roles.length) parts.push(`【可用角色（名字/职责/执行工具）】${input.roles.map(r => `${r.id}=${r.name}${r.title ? ` / ${r.title}` : ''}${r.agent ? ` / ${r.agent}` : ''}`).join('；')}`)
  if (input.projects.length) parts.push(`【可用项目】${input.projects.map(p => `${p.id}=${p.name}`).join('；')}`)
  return parts.join('\n\n')
}

// ---------- 发单档：人写一句话，项目经理补成任务单 ----------
//
// 和「会话跑完攒意见」是同一套范式，只是材料不同：那边有会话尾部与证据，这边只有人写的一句话
// 和项目背景。所以契约得更克制——不许编业务细节，缺什么就写成「先确认」。

export const TICKET_CONTRACT = `你在 AgentHub 里当项目经理，收到人发来的一句话工单，把它补成一张能直接开工的任务单。

只回一个 JSON 对象（可以用 \`\`\`json 包起来），不要写解释、寒暄或额外段落。字段：
{"title":"任务标题","notes":"目标、背景、约束、怎么验证","checklist":["验收要点"],"priority":"high | medium | low","roleId":null,"projectId":null,"delivery":"fresh","constraints":{"paths":[],"net":false,"push":false,"scripts":false,"note":""},"note":"你的判断依据或缺口"}

规矩：
- 人给的标题和说明是唯一的需求来源。不要编业务细节：缺什么就写进 notes 或 checklist 当「先确认 X 再动手」，不要自己编一个。
- title 动词开头，说清要做什么，不超过 80 字；不要把人那句话原样抄回来。
- notes 写给接手的人看：要达成什么、项目里对得上的背景、不能碰什么、怎么算做完。不超过 2000 字。
- checklist 是验收要点，最多 8 条、每条不超过 100 字；想不出来就给空数组。
- priority：卡住别人或线上问题给 high；普通改进给 medium；锦上添花给 low。
- roleId 从【可用角色】里挑最合适的编号，没把握给 null 让人来定；你自己不做实现。
- projectId 用【本次发单的项目】，不要换成别的。
- delivery 一律 fresh：这单没有可以续的会话。
- constraints 按这个任务真的需要什么写，拿不准一律 false。
- 发单人指定了电脑或目录就照抄，别改。
- note 写你补了哪些人没说的假设，让人一眼看到哪里需要他确认。`

export function ticketMessage(input: {
  title: string
  notes: string
  project: string
  projectBrief: string
  recent: string[]
  role: { name: string; title: string; agent: string } | null
  machine: string
  cwd: string
  roles: { id: number; name: string; title: string; agent?: string }[]
  projects: { id: number; name: string }[]
}): string {
  const parts = [TICKET_CONTRACT]
  parts.push(`【人发来的工单】${input.title}${input.notes ? `\n说明：${input.notes.slice(0, 1500)}` : '\n说明：（没写正文，按标题理解；缺的信息写进待确认）'}`)
  const place = [input.machine && `电脑 ${input.machine}`, input.cwd && `目录 ${input.cwd}`].filter(Boolean).join(' · ')
  if (input.project) parts.push(`【本次发单的项目】${input.project}${place ? `（${place}）` : ''}`)
  if (input.projectBrief) parts.push(`【项目说明】${input.projectBrief.slice(0, 1200)}`)
  if (input.recent.length) parts.push(`【项目最近进展】\n${input.recent.slice(-3).map(r => `- ${r}`).join('\n')}`)
  if (input.role) parts.push(`【发单人指定的执行角色】${input.role.name}${input.role.title ? ` / ${input.role.title}` : ''}${input.role.agent ? ` / ${input.role.agent}` : ''}`)
  if (input.roles.length) parts.push(`【可用角色（名字/职责/执行工具）】${input.roles.map(r => `${r.id}=${r.name}${r.title ? ` / ${r.title}` : ''}${r.agent ? ` / ${r.agent}` : ''}`).join('；')}`)
  if (input.projects.length) parts.push(`【可用项目】${input.projects.map(p => `${p.id}=${p.name}`).join('；')}`)
  return parts.join('\n\n')
}

/**
 * 人发的一张粗单：先落成一份待确认的任务单草稿（kind=ticket，没有会话），
 * 项目经理细化后由人确认才建任务。不直接建任务——建了再改，等于让人对着半成品做验收。
 */
export async function createTicket(pool: pg.Pool, userId: number, input: {
  title: string
  notes: string
  projectId: number | null
  projectName: string
  roleId: number | null
  machine: string
  cwd: string
}): Promise<Proposal> {
  const r = await pool.query(
    `INSERT INTO session_proposals(
       user_id,session_id,session_title,session_agent,session_project,event_at,
       kind,title,notes,checklist,constraints,delivery,priority,role_id,project_id,machine,cwd,origin)
     VALUES($1,$2,'','',$3,now(),'ticket',$4,$5,'[]'::jsonb,'{}'::jsonb,'fresh','medium',$6,$7,$8,$9,'heuristic')
     RETURNING *`,
    [userId, `ticket:${randomUUID()}`, input.projectName, input.title.slice(0, MAX_TITLE), input.notes.slice(0, MAX_NOTES),
      input.roleId, input.projectId, input.machine || null, input.cwd || null],
  )
  return (await fillAssignees(pool, userId, [row(r.rows[0])]))[0]
}


const clamp = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replaceAll('\0', '').trim().slice(0, max) : ''

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^[1-9]\d*$/.test(v.trim()) ? Number(v) : NaN
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function candidates(raw: string): string[] {
  const out: string[] = []
  for (const m of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) out.push(m[1])
  const first = raw.indexOf('{'), last = raw.lastIndexOf('}')
  if (first >= 0 && last > first) out.push(raw.slice(first, last + 1))
  return out
}

export type ParsedRefine = { skip: true } | { skip: false; draft: ProposalDraft }

/** 解析细化回复。明确说 skip 才算 skip；解析不出来返回 null，由调用方提示重试——绝不猜。 */
export function parseRefine(raw: string): ParsedRefine | null {
  for (const chunk of candidates(raw)) {
    let obj: Record<string, unknown>
    try {
      const parsed = JSON.parse(chunk)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      obj = parsed as Record<string, unknown>
    } catch { continue }
    if (obj.skip === true) return { skip: true }
    const title = clamp(obj.title, MAX_TITLE)
    if (!title) continue
    const kind = obj.kind === 'continue' || obj.kind === 'fix' ? obj.kind : 'followup'
    const priority = obj.priority === 'high' || obj.priority === 'low' ? obj.priority : 'medium'
    const checklist = Array.isArray(obj.checklist)
      ? obj.checklist.map(v => clamp(v, MAX_ITEM)).filter(Boolean).slice(0, 8)
      : []
    return {
      skip: false,
      draft: {
        kind,
        title,
        notes: clamp(obj.notes, MAX_NOTES),
        checklist,
        // 边界解析不出来就当没声明：宁可多问一句，也不替人放开
        constraints: normalizeConstraints(obj.constraints ?? NO_CONSTRAINTS),
        delivery: obj.delivery === 'fork' || obj.delivery === 'fresh' ? obj.delivery : defaultDelivery(kind),
        priority,
        roleId: num(obj.roleId),
        projectId: num(obj.projectId),
        note: clamp(obj.note, 500),
      },
    }
  }
  return null
}

/** 细化结果覆盖原草稿：只认草稿里出现过的字段由界面改，其余整份替换 */
export async function replaceDraft(pool: DB, userId: number, id: number, draft: ProposalDraft): Promise<Proposal> {
  const r = await pool.query(
    `UPDATE session_proposals SET kind=$3,title=$4,notes=$5,checklist=$6,priority=$7,
       role_id=$8,project_id=$9,note=$10,origin='agent',updated_at=now(),delivery=$11,
       constraints=$12,stage='draft'
     WHERE user_id=$1 AND id=$2 AND status='pending' RETURNING *`,
    [userId, id, draft.kind, draft.title.slice(0, MAX_TITLE), draft.notes.slice(0, MAX_NOTES),
      JSON.stringify(draft.checklist), draft.priority, draft.roleId, draft.projectId, draft.note.slice(0, 500),
      draft.delivery ?? defaultDelivery(draft.kind),
      JSON.stringify(draft.constraints ?? NO_CONSTRAINTS)],
  )
  if (!r.rows[0]) throw new TaskError('这条意见已经处理过了', 409)
  return (await fillAssignees(pool, userId, [row(r.rows[0])]))[0]
}

/** 细化派发时记下这一轮的 run：回复到达时靠它认领是哪条意见 */
export async function markRefineRun(db: DB, userId: number, id: number, runId: string): Promise<void> {
  await db.query("UPDATE session_proposals SET refine_run_id=$3, updated_at=now() WHERE user_id=$1 AND id=$2 AND status='pending'", [userId, id, runId])
}

export type RefineResult = { action: 'replaced' | 'skipped'; proposal: Proposal }

/**
 * agent 回了一条：属于某条待细化意见的就地更新。
 * 解析不出来返回 null（界面保留原文，可以重试）；明确 skip 就把这条意见关掉，不留空卡片。
 */
export async function recordRefine(db: DB, userId: number, runId: string, raw: string): Promise<RefineResult | null> {
  const r = await db.query("SELECT * FROM session_proposals WHERE user_id=$1 AND refine_run_id=$2 AND status='pending'", [userId, runId])
  if (!r.rows[0]) return null
  const proposal = row(r.rows[0])
  const parsed = parseRefine(raw)
  if (!parsed) return null
  // 人自己发的单不会被模型判「没价值」丢掉：skip 只对从会话攒出来的意见成立。
  // 解析不出来就当这一轮没成，草稿原样留着等人再点一次重写。
  if (parsed.skip) {
    if (proposal.kind === 'ticket') return null
    return { action: 'skipped', proposal: await markProposal(db, userId, proposal.id, 'discarded') }
  }
  // 发单的 kind 是它的身份（卡片上要标「发单」），模型回什么都不能改掉；
  // 项目也锁成人选的那个——单子不能自己跑去别的项目上做
  if (proposal.kind === 'ticket') {
    parsed.draft.kind = 'ticket'
    parsed.draft.projectId = proposal.projectId
  }
  return { action: 'replaced', proposal: await replaceDraft(db, userId, proposal.id, parsed.draft) }
}

// ---------- 读与状态 ----------

export async function listProposals(db: DB, userId: number, opts: { sessionId?: string; limit?: number } = {}): Promise<Proposal[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const r = opts.sessionId
    ? await db.query('SELECT * FROM session_proposals WHERE user_id=$1 AND session_id=$2 ORDER BY created_at DESC, id DESC LIMIT $3', [userId, opts.sessionId, limit])
    : await db.query("SELECT * FROM session_proposals WHERE user_id=$1 AND status='pending' ORDER BY created_at DESC, id DESC LIMIT $2", [userId, limit])
  return fillAssignees(db, userId, r.rows.map(row))
}

export async function getProposal(db: DB, userId: number, id: number): Promise<Proposal> {
  const r = await db.query('SELECT * FROM session_proposals WHERE user_id=$1 AND id=$2', [userId, id])
  if (!r.rows[0]) throw new TaskError('处理意见不存在', 404)
  return (await fillAssignees(db, userId, [row(r.rows[0])]))[0]
}

/** 建议 → 任务单：人点了「生成任务单」才把 stage 推过去。
 *  重复点不报错（已经是 draft 就原样返回），避免双击或两个窗口同时点时弹出假错误。 */
export async function promoteToDraft(db: DB, userId: number, id: number): Promise<Proposal> {
  const r = await db.query(
    `UPDATE session_proposals SET stage='draft', updated_at=now()
     WHERE user_id=$1 AND id=$2 AND status='pending' AND stage='suggest' RETURNING *`,
    [userId, id],
  )
  if (r.rows[0]) return (await fillAssignees(db, userId, [row(r.rows[0])]))[0]
  const cur = await db.query('SELECT status,stage FROM session_proposals WHERE user_id=$1 AND id=$2', [userId, id])
  if (!cur.rows[0]) throw new TaskError('处理意见不存在', 404)
  if (cur.rows[0].status !== 'pending') throw new TaskError('这条意见已经处理过了', 409)
  return getProposal(db, userId, id)
}

/** 确认/忽略只对 pending 生效，避免同一份意见生成两个任务 */
export async function markProposal(db: DB, userId: number, id: number, status: 'accepted' | 'discarded', taskId: number | null = null): Promise<Proposal> {
  const r = await db.query(
    `UPDATE session_proposals SET status=$3, created_task_id=$4, updated_at=now()
     WHERE user_id=$1 AND id=$2 AND status='pending' RETURNING *`,
    [userId, id, status, taskId],
  )
  if (!r.rows[0]) {
    const exists = await db.query('SELECT status FROM session_proposals WHERE user_id=$1 AND id=$2', [userId, id])
    if (!exists.rows[0]) throw new TaskError('处理意见不存在', 404)
    throw new TaskError('这条意见已经处理过了', 409)
  }
  return row(r.rows[0])
}

/** 撤回忽略：把当初丢掉的那张单放回待确认（卡片上的「撤回」走这条）。
 *  只对 discarded 生效——已确认的那张已经建出任务了，撤回来只会和任务重复。
 *  放回去也守「只留一张」：同一任务（没挂任务时同一会话）上别的待处理意见照样作废，
 *  否则同一个活攒出两张待确认，人可能连点两次建出两个任务。 */
export async function restoreProposal(db: DB, userId: number, id: number): Promise<Proposal> {
  const r = await db.query(
    `UPDATE session_proposals SET status='pending', created_task_id=NULL, updated_at=now()
     WHERE user_id=$1 AND id=$2 AND status='discarded' RETURNING *`,
    [userId, id],
  )
  const back = r.rows[0]
  if (!back) {
    const exists = await db.query('SELECT status FROM session_proposals WHERE user_id=$1 AND id=$2', [userId, id])
    if (!exists.rows[0]) throw new TaskError('处理意见不存在', 404)
    throw new TaskError('这张单已经确认过了，撤回不了（任务已经建好）', 409)
  }
  const scope = back.task_id === null ? 'task_id IS NULL AND session_id=$2' : 'task_id=$2'
  await db.query(
    `UPDATE session_proposals SET status='discarded', updated_at=now()
      WHERE user_id=$1 AND status='pending' AND id<>$3 AND ${scope}`,
    [userId, back.task_id === null ? back.session_id : back.task_id, back.id],
  )
  return getProposal(db, userId, id)
}

/** 确认时允许人改字段：只接受草稿里出现过的键 */
export function proposalPatch(raw: unknown): Record<string, unknown> {
  const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const out: Record<string, unknown> = {}
  for (const key of ['title', 'notes', 'checklist', 'priority', 'roleId', 'projectId'] as const) {
    if (key in b) out[key] = b[key]
  }
  return out
}

/** 把意见里的文本清单转成任务清单结构（确认建任务时用） */
export function toChecklist(items: string[]): { id: string; text: string; done: boolean }[] {
  return items.slice(0, MAX_ITEMS).map((text, i) => ({ id: `p${i + 1}`, text: text.slice(0, MAX_ITEM), done: false }))
}
