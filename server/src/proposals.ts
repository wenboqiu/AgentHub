import type pg from 'pg'
import { listMessages, type Session } from './db.ts'
import { TaskError, type Task } from './tasks.ts'
import { harvestEvidence, type Evidence } from './review.ts'

// 处理意见（Proposal）：一个会话跑完后，先替人把「接下来该做什么」想好，放在会话上等人确认。
//
// 和角色助手（assistant.ts）的分工——助手是「从一句话造一个角色」，这里是「从一段刚结束的工作
// 攒出下一件事」。两者共用同一套范式：先出结构化草稿、人在界面上改、确认了才落库。
//
// 两档生成，默认第一档：
//   ① 规则档（零成本、同步）：从最后一条助手回复、证据链、未完成清单里拼出草稿，几十毫秒；
//   ② 细化档（一次 run、要电脑在线）：把会话尾部交给项目经理角色重写，质量高但慢。
// 规则档先生成，人觉得不够好再点「让项目经理细化」——不让人为每次会话完成付一次模型的账。
//
// 一条会话可以有多次完成（多段任务），用 (session, event_at) 做唯一键：同一时刻只出一条，
// 新一轮完成（event_at 变了）才会再出一条。

type DB = Pick<pg.Pool, 'query'>

export type ProposalKind = 'continue' | 'followup' | 'fix'
export type ProposalOrigin = 'heuristic' | 'agent'
export type ProposalStatus = 'pending' | 'accepted' | 'discarded'
export type Priority = 'high' | 'medium' | 'low'

/** 项目经理安排好的执行人：角色是人、配置是地方（机器 + 目录 + 执行工具） */
export type Assignee = {
  roleId: number | null
  roleName: string
  roleTitle: string
  agent: string
  profileId: number | null
  profileName: string
  machine: string
  cwd: string
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
  title: string
  notes: string
  /** 只是文本；确认建任务时才补 id 和完成状态 */
  checklist: string[]
  priority: Priority
  roleId: number | null
  projectId: number | null
  profileId: number | null
  /** 读出来时按 role_id / profile_id 展开成可展示的执行人（含机器与目录） */
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
  priority: Priority
  roleId: number | null
  projectId: number | null
  /** 执行人挂的配置；没给就按角色/项目兜底 */
  profileId: number | null
  note: string
}

const MAX_TITLE = 200
const MAX_NOTES = 4000
const MAX_ITEMS = 20
const MAX_ITEM = 200
const MAX_EVIDENCE = 6
/** 细化会话的标题前缀：这类会话不再生成新的处理意见（否则会无限套娃），也不弹通知 */
export const PROPOSAL_TITLE = '意见细化：'

const EMPTY_ASSIGNEE: Assignee = {
  roleId: null, roleName: '', roleTitle: '', agent: '', profileId: null, profileName: '', machine: '', cwd: '',
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
    kind text NOT NULL CHECK (kind IN ('continue','followup','fix')),
    title text NOT NULL,
    notes text NOT NULL DEFAULT '',
    checklist jsonb NOT NULL DEFAULT '[]'::jsonb,
    priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
    role_id bigint,
    project_id bigint,
    profile_id bigint,
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    note text NOT NULL DEFAULT '',
    origin text NOT NULL DEFAULT 'heuristic' CHECK (origin IN ('heuristic','agent')),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','discarded')),
    created_task_id bigint,
    refine_run_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, session_id, event_at))`)
  await db.query('ALTER TABLE session_proposals ADD COLUMN IF NOT EXISTS refine_run_id text')
  // 老库补列：执行人挂的配置（新库建表时已有）
  await db.query('ALTER TABLE session_proposals ADD COLUMN IF NOT EXISTS profile_id bigint')
  await db.query('CREATE INDEX IF NOT EXISTS idx_proposals_pending ON session_proposals(user_id,status,created_at DESC)')
  await db.query('CREATE INDEX IF NOT EXISTS idx_proposals_session ON session_proposals(user_id,session_id)')
}

const row = (r: any): Proposal => ({
  id: Number(r.id),
  sessionId: r.session_id,
  sessionTitle: r.session_title ?? '',
  sessionAgent: r.session_agent ?? '',
  sessionProject: r.session_project ?? '',
  taskId: r.task_id === null || r.task_id === undefined ? null : Number(r.task_id),
  kind: r.kind,
  title: r.title,
  notes: r.notes ?? '',
  checklist: Array.isArray(r.checklist) ? r.checklist.filter((t: unknown): t is string => typeof t === 'string') : [],
  priority: r.priority ?? 'medium',
  roleId: r.role_id === null || r.role_id === undefined ? null : Number(r.role_id),
  projectId: r.project_id === null || r.project_id === undefined ? null : Number(r.project_id),
  profileId: r.profile_id === null || r.profile_id === undefined ? null : Number(r.profile_id),
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

export type RoleLite = { id: number; name: string; title: string; agent: string; profileId: number | null }
export type ProfileLite = { id: number; name: string; agent: string; machine: string; cwd: string }

export type AssigneeCtx = {
  roles: Map<number, RoleLite>
  profiles: Map<number, ProfileLite>
  /** 项目 → 兜底配置 */
  projectProfiles: Map<number, number>
}

/** 一次把角色、配置、项目的兜底配置读齐，批量展开时不做 N+1 */
async function assigneeCtx(db: DB, user: number): Promise<AssigneeCtx> {
  const [roles, profiles, projects] = await Promise.all([
    db.query('SELECT id,name,title,agent,profile_id FROM roles WHERE user_id=$1', [user]),
    db.query('SELECT id,name,agent,machine,cwd FROM profiles WHERE user_id=$1', [user]),
    db.query('SELECT id,profile_id FROM projects WHERE user_id=$1 AND profile_id IS NOT NULL', [user]),
  ])
  return {
    roles: new Map(roles.rows.map((r: any) => [Number(r.id), {
      id: Number(r.id), name: r.name ?? '', title: r.title ?? '', agent: r.agent ?? '',
      profileId: r.profile_id === null || r.profile_id === undefined ? null : Number(r.profile_id),
    }])),
    profiles: new Map(profiles.rows.map((r: any) => [Number(r.id), {
      id: Number(r.id), name: r.name ?? '', agent: r.agent ?? '', machine: r.machine ?? '', cwd: r.cwd ?? '',
    }])),
    projectProfiles: new Map(projects.rows.map((r: any) => [Number(r.id), Number(r.profile_id)])),
  }
}

/** 角色 + 配置 + 项目兜底，合成一份能显示、也能直接建任务的人选 */
export function assigneeOf(ctx: AssigneeCtx, roleId: number | null, profileId: number | null, projectId: number | null): Assignee {
  const role = roleId === null ? null : ctx.roles.get(roleId) ?? null
  const pid = profileId ?? role?.profileId ?? (projectId === null ? null : ctx.projectProfiles.get(projectId) ?? null)
  const profile = pid === null ? null : ctx.profiles.get(pid) ?? null
  return {
    roleId: role?.id ?? null,
    roleName: role?.name ?? '',
    roleTitle: role?.title ?? '',
    agent: role?.agent || profile?.agent || '',
    profileId: profile?.id ?? null,
    profileName: profile?.name ?? '',
    machine: profile?.machine ?? '',
    cwd: profile?.cwd ?? '',
  }
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
  taskProfileId: number | null
  projectId: number | null
  managerRoleId: number | null
}): Promise<{ roleId: number | null; profileId: number | null; reason: string }> {
  const keep = (roleId: number, reason: string) => ({ roleId, profileId: input.taskProfileId, reason })
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
  return { roleId: input.taskRoleId, profileId: input.taskProfileId, reason: '没有可判断的依据，执行人留空由你选' }
}

/** 批量展开执行人（列表与单条都走这里，保证界面看到的东西一致） */
export async function fillAssignees(db: DB, user: number, list: Proposal[]): Promise<Proposal[]> {
  if (!list.length) return list
  const ctx = await assigneeCtx(db, user)
  return list.map(p => ({ ...p, assignee: assigneeOf(ctx, p.roleId, p.profileId, p.projectId) }))
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
        task.notes ? `原任务：${task.notes.slice(0, 800)}` : '',
        lastReply ? `本次进展：\n${lastReply.slice(-800)}` : '',
        evidence.length ? `证据：\n${evidenceGroups(evidence)}` : '',
      ].filter(Boolean).join('\n\n'),
      checklist: todo.slice(0, MAX_ITEMS).map(t => t.slice(0, MAX_ITEM)),
      priority: task.priority === 'high' ? 'high' : 'medium',
      roleId: task.roleId,
      projectId: task.projectId,
      profileId: task.profileId,
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
      roleId: task?.roleId ?? null,
      projectId: task?.projectId ?? null,
      profileId: task?.profileId ?? null,
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
      roleId: task?.roleId ?? null,
      projectId: task?.projectId ?? null,
      profileId: task?.profileId ?? null,
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
      roleId: task?.roleId ?? null,
      projectId: task?.projectId ?? null,
      profileId: task?.profileId ?? null,
      note: '没从回复里找到明确的下一步，标题只是占位；点「让项目经理细化」会更准。',
    }
  }

  return null
}

/**
 * 会话完成时调用：取最后回复、证据、未完成任务，攒一条待确认的意见。
 * 同一 (会话, 完成时刻) 只留一条；已有则返回 null。
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
    taskProfileId: draft.profileId,
    projectId: draft.projectId,
    managerRoleId: manager?.role_id === null || manager?.role_id === undefined ? null : Number(manager.role_id),
  })
  draft.roleId = pick.roleId
  draft.profileId = pick.profileId
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
  draft: ProposalDraft
}): Promise<Proposal | null> {
  const r = await pool.query(
    `INSERT INTO session_proposals(
       user_id,session_id,session_title,session_agent,session_project,task_id,event_at,
       kind,title,notes,checklist,priority,role_id,project_id,profile_id,evidence,note,origin)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (user_id,session_id,event_at) DO NOTHING RETURNING *`,
    [userId, input.sessionId, input.sessionTitle.slice(0, 200), input.sessionAgent, input.sessionProject.slice(0, 200),
      input.taskId, input.eventAt, input.draft.kind, input.draft.title.slice(0, MAX_TITLE),
      input.draft.notes.slice(0, MAX_NOTES), JSON.stringify(input.draft.checklist),
      input.draft.priority, input.draft.roleId, input.draft.projectId, input.draft.profileId,
      JSON.stringify(input.evidence), input.draft.note.slice(0, 500), input.origin],
  )
  return r.rows[0] ? row(r.rows[0]) : null
}

// ---------- 细化档：让项目经理角色重写 ----------

export const REFINE_CONTRACT = `你在 AgentHub 里当项目经理，读完一段刚结束的会话，写一张能直接开工的任务单。

只回一个 JSON 对象（可以用 \`\`\`json 包起来），不要写解释、寒暄或额外段落。字段：
{"kind":"continue | followup | fix","title":"任务标题","notes":"背景与验证方式","checklist":["验收要点"],"priority":"high | medium | low","roleId":null,"projectId":null,"note":"你的判断依据或缺口"}

规矩：
- title 动词开头，说清「接下来做什么」，不超过 80 字；不要复述会话内容。
- kind：continue = 原任务没做完接着做；followup = 已交付但还有下一步；fix = 有报错或测试失败要先修。
- notes 写给接手的人看：已经做到哪、已知结论、怎么验证，不超过 2000 字，别抄原文。
- checklist 是验收要点，最多 8 条、每条不超过 100 字；想不出来就给空数组。
- priority：卡住别人、线上问题、有失败测试的给 high；普通改进给 medium。
- roleId 是执行人：从【可用角色】里挑最合适的编号，优先已经在这个项目/这段会话里做过活的角色；
  没有把握就沿用原任务的执行人；实在没有合适的给 null，让人来定。你自己不做实现。
- projectId 只能取【可用项目】里的编号，判断不了就给 null。
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
  draft: { title: string; notes: string; checklist: string[]; assignee?: string } | null
  roles: { id: number; name: string; title: string; agent?: string }[]
  projects: { id: number; name: string }[]
}): string {
  const parts = [REFINE_CONTRACT]
  parts.push(`【会话】${input.sessionTitle || '未命名会话'}（${input.agent}${input.project ? ` · ${input.project}` : ''}）`)
  if (input.task) {
    const todo = input.task.todo.length ? `\n未完成清单：${input.task.todo.join('；')}` : ''
    parts.push(`【当时挂着的任务】${input.task.title}${input.task.notes ? `\n说明：${input.task.notes.slice(0, 600)}` : ''}${todo}`)
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
      + (input.draft.assignee ? `\n现在的执行人：${input.draft.assignee}` : ''))
  }
  if (input.roles.length) parts.push(`【可用角色（名字/职责/执行工具）】${input.roles.map(r => `${r.id}=${r.name}${r.title ? ` / ${r.title}` : ''}${r.agent ? ` / ${r.agent}` : ''}`).join('；')}`)
  if (input.projects.length) parts.push(`【可用项目】${input.projects.map(p => `${p.id}=${p.name}`).join('；')}`)
  return parts.join('\n\n')
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
        priority,
        roleId: num(obj.roleId),
        projectId: num(obj.projectId),
        profileId: null,
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
       role_id=$8,project_id=$9,note=$10,origin='agent',updated_at=now(),
       profile_id=COALESCE($11,(SELECT r.profile_id FROM roles r WHERE r.user_id=$1 AND r.id=$8),profile_id)
     WHERE user_id=$1 AND id=$2 AND status='pending' RETURNING *`,
    [userId, id, draft.kind, draft.title.slice(0, MAX_TITLE), draft.notes.slice(0, MAX_NOTES),
      JSON.stringify(draft.checklist), draft.priority, draft.roleId, draft.projectId, draft.note.slice(0, 500),
      draft.profileId],
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
  if (parsed.skip) return { action: 'skipped', proposal: await markProposal(db, userId, proposal.id, 'discarded') }
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

/** 确认时允许人改字段：只接受草稿里出现过的键 */
export function proposalPatch(raw: unknown): Record<string, unknown> {
  const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const out: Record<string, unknown> = {}
  for (const key of ['title', 'notes', 'checklist', 'priority', 'roleId', 'projectId', 'profileId'] as const) {
    if (key in b) out[key] = b[key]
  }
  return out
}

/** 把意见里的文本清单转成任务清单结构（确认建任务时用） */
export function toChecklist(items: string[]): { id: string; text: string; done: boolean }[] {
  return items.slice(0, MAX_ITEMS).map((text, i) => ({ id: `p${i + 1}`, text: text.slice(0, MAX_ITEM), done: false }))
}
