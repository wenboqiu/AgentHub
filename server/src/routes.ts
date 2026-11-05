import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type pg from 'pg'
import {
  AGENTS,
  MESSAGE_ROLES,
  STATES,
  abortPendingSession,
  ackAll,
  ackSession,
  activeRun,
  activeTaskRun,
  applyEvent,
  cleanText,
  closeTaskRuns,
  createApproval,
  createPendingSession,
  createRun,
  createTaskRun,
  annotateApproval,
  decideApproval,
  expireApproval,
  expireApprovalsOfRuns,
  failActiveRuns,
  getApproval,
  getRun,
  getSession,
  getMessage,
  rateMessage,
  nativeKey,
  type MessageMeta,
  replaceHistory,
  insertMessage,
  isPendingId,
  latestRun,
  listActivity,
  listExecutions,
  listMessages,
  listSessions,
  pendingApprovals,
  removeSession,
  reopenApproval,
  renamePendingSession,
  setRunStatus,
  setRunUsage,
  stopTaskRun,
  type Approval,
  type EventIn,
  type Message,
  type Run,
  type RunUsage,
  type Session,
} from './db.ts'
import { authenticate, type Kick } from './auth.ts'
import { ackReminder, collectReminders, listReminders } from './reminders.ts'
import { evaluateNotify, getSettings, saveSettings } from './notify.ts'
import { buildFailureDigest, buildReviewDigest, getDigests } from './digest.ts'
import { AbortSpreeTracker, cleanupWatchdog, claimStalled, stalledSessions } from './watchdog.ts'
import { taskThread } from './threads.ts'
import { addReviewItem, decideReviewItem, getReview } from './review.ts'
import { bumpAttempts, dequeueDispatch, enqueueDispatch, expireQueued, queuedFor } from './queue.ts'
import { dispatchBoard } from './board.ts'
import { applyProfile, deleteProfile, findProfile, getProfile, listProfiles, saveProfile } from './profiles.ts'
import { applyRole, deleteRole, findRole, getRole, listRoles, roleModel, saveRole } from './roles.ts'
import { appendBrief, deleteProject, deleteBrief, findProject, getProject, listBrief, listProjects, pickProjectProfile, recentBrief, saveProject } from './projects.ts'
import { artifactPath, buildArtifact, deleteArtifact, getArtifact, saveArtifact, summarize } from './artifacts.ts'
import { addMemory, composeInstructions, deleteMemory, listMemories, markMemoriesUsed, pickMemories, updateMemory } from './memories.ts'
import {
  ASSISTANT_TITLE,
  draftPatch,
  followupMessage,
  getDraft,
  getThread,
  isAssistantSession,
  listDrafts,
  markDispatch,
  markDraft,
  openingMessage,
  recordReply,
  resetThread,
  startThread,
} from './assistant.ts'
import {
  PROPOSAL_TITLE,
  generateProposal,
  getProposal,
  listProposals,
  markProposal,
  markRefineRun,
  proposalPatch,
  recordRefine,
  refineMessage,
  toChecklist,
} from './proposals.ts'
import { getManager, quota, recentApproveCount, recentAutoCount, runDispatchTick, runningCount, saveManager } from './dispatch-manager.ts'
import { boundaryLine, hasConstraints, judgeApproval } from './referee.ts'
import { TaskError, deleteGoal, deleteTask, getTask, id as entityId, linkSession, listGoals, listTasks, object, saveGoal, saveTask, syncTaskForSession, tasksForSession, text as taskText, type Task } from './tasks.ts'

type Sock = {
  send(data: string): void
  ping(): void
  close(code?: number, reason?: string): void
  on(ev: string, fn: (...args: any[]) => void): void
  readyState: number
}

export type RouteOptions = {
  // 等执行器返回历史记录的最长时间（毫秒），测试里调短
  historyTimeoutMs?: number
  reminderIntervalMs?: number
  // Watchdog：检查间隔、running 多久没新事件算卡死、失败连击阈值与窗口
  watchdogIntervalMs?: number
  stallAfterMs?: number
  abortSpreeCount?: number
  abortSpreeWindowMs?: number
  // 派活排队：排队项存活时间、一次上线最多投递几条、失败多少次后放弃、过期清扫间隔
  queueTtlMs?: number
  queueDrainLimit?: number
  queueMaxAttempts?: number
  queueSweepIntervalMs?: number
  /** 项目经理自动派发的巡检间隔（默认 60 秒） */
  dispatchIntervalMs?: number
}

type HistoryResult = { messages: ({ role: string; text: string; at?: string } & MessageMeta)[]; error?: string }

function bearer(req: FastifyRequest) {
  const h = req.headers.authorization ?? ''
  return h.startsWith('Bearer ') ? h.slice(7) : ''
}

// 一个 WS 连接：属于哪个账号、哪个设备会话（踢设备时按它们关闭）
type Conn = { sock: Sock; userId: number; authSessionId: number }
type Exec = Conn & { machine: string; replyBranch: boolean; roleV1: boolean }
const INVALID_LOGIN = 4401

// Codex Desktop 结束一轮时不一定会写终态（直接关窗口、进程被杀都只留下 task_started），
// 会话就会永远停在 running，把手机端的发送按钮锁死。
// 超过这个时长没有任何新事件，就不再拿 running 拦发送（强行续跑最多让 Codex 报一次错，
// 但比用户永远发不出去要好）。客户端 sendBlockReason 用同一个阈值。
export const STALE_RUNNING_MS = 30 * 60_000
const stuckRunning = (s: { state: string; eventAt: string }) =>
  s.state === 'running' && Date.now() - Date.parse(s.eventAt) > STALE_RUNNING_MS

function parseEvent(raw: unknown): EventIn | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  if (!AGENTS.includes(e.agent as never) || !STATES.includes(e.state as never)) return null
  if (typeof e.sessionId !== 'string' || !e.sessionId || typeof e.at !== 'string' || Number.isNaN(Date.parse(e.at))) return null
  if (e.expectedAt !== undefined && (typeof e.expectedAt !== 'string' || Number.isNaN(Date.parse(e.expectedAt)))) return null
  if (e.readAt !== undefined && (typeof e.readAt !== 'string' || Number.isNaN(Date.parse(e.readAt)))) return null
  // Postgres 的 text 不能含 NUL，不去掉会整批 500
  const clean = (v: string) => v.replaceAll('\0', '')
  const str = (v: unknown) => (typeof v === 'string' ? clean(v) : '')
  // 活动桶（可选）：时间戳必须可解析，count 限制在合理范围
  let buckets: { at: string; count: number }[] | undefined
  if (e.buckets !== undefined) {
    if (!Array.isArray(e.buckets) || e.buckets.length > 2000) return null
    buckets = []
    for (const b of e.buckets) {
      if (!b || typeof b !== 'object') return null
      const o = b as Record<string, unknown>
      if (typeof o.at !== 'string' || Number.isNaN(Date.parse(o.at))) return null
      buckets.push({ at: o.at, count: typeof o.count === 'number' && Number.isInteger(o.count) && o.count > 0 && o.count <= 1000 ? o.count : 1 })
    }
  }
  return {
    agent: e.agent as EventIn['agent'],
    sessionId: clean(e.sessionId),
    machine: str(e.machine) || 'unknown',
    cwd: str(e.cwd),
    state: e.state as EventIn['state'],
    at: e.at,
    title: typeof e.title === 'string' ? clean(e.title).slice(0, 200) : undefined,
    summary: typeof e.summary === 'string' ? clean(e.summary) : undefined,
    pid: typeof e.pid === 'number' && Number.isInteger(e.pid) && e.pid > 0 ? e.pid : null,
    quiet: e.quiet === true,
    expectedAt: e.expectedAt as string | undefined,
    readAt: e.readAt as string | undefined,
    buckets,
  }
}

const TERMINAL = ['done', 'failed', 'stopped']
const PENDING = ':pending-'
const SESSION_KEY_RE = /^[A-Za-z0-9_-]{1,100}$/

const execKey = (userId: number, machine: string) => `${userId}:${machine}`

/** Codex 提问的 questions JSON：解析出问题文本；解析失败退回原文片段 */
function userInputQuestions(detail: string): { id: string; question: string; options: { label: string; description?: string }[] }[] | null {
  try {
    const v = JSON.parse(detail)
    if (!Array.isArray(v) || !v.length) return null
    const out = v
      .filter((q): q is Record<string, unknown> => !!q && typeof q === 'object' && typeof (q as {id?:unknown}).id === 'string')
      .map(q => ({
        id: String(q.id),
        question: typeof q.question === 'string' ? q.question : String(q.header ?? ''),
        options: Array.isArray(q.options)
          ? q.options.filter((o): o is { label: string; description?: string } => !!o && typeof o === 'object' && typeof (o as {label?:unknown}).label === 'string')
          : [],
      }))
    return out.length ? out : null
  } catch {
    return null
  }
}

/** 用户附图的限制：单张小、张数少，因为要经 WS 转给执行端 */
const USER_IMAGE_PREFIXES = ['data:image/png;base64,', 'data:image/jpeg;base64,', 'data:image/webp;base64,', 'data:image/gif;base64,']
const USER_IMAGE_MAX_CHARS = 2_500_000
const USER_IMAGE_MAX_COUNT = 4
/** 这条路由要收图，body 上限比全局的 1MB 大 */
export const MESSAGE_BODY_LIMIT = 12 * 1024 * 1024

/** 清洗用户附图；返回字符串数组，或 { error } 说明为什么不行 */
function cleanUserImages(raw: unknown): string[] | { error: string } {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) return { error: 'images 必须是数组' }
  if (raw.length > USER_IMAGE_MAX_COUNT) return { error: `最多附带 ${USER_IMAGE_MAX_COUNT} 张图片` }
  const out: string[] = []
  for (const u of raw) {
    if (typeof u !== 'string' || !USER_IMAGE_PREFIXES.some(p => u.startsWith(p))) return { error: '图片格式不支持，只接受 png / jpeg / webp / gif' }
    if (u.length > USER_IMAGE_MAX_CHARS) return { error: '单张图片太大了，请压缩后再发' }
    out.push(u)
  }
  return out
}

/**
 * 清洗执行器上报的 token 用量：只认已知数值字段，防止执行端塞进来一坨任意 JSON。
 * 连一个数都没有就当没报过（返回 null）。
 */
function cleanUsage(raw: unknown): RunUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const num = (k: string) => {
    const v = o[k]
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0
  }
  const input = num('input'), output = num('output')
  const cached = num('cached'), reasoning = num('reasoning')
  const total = num('total') || input + output + cached
  const cost = typeof o.costUsd === 'number' && Number.isFinite(o.costUsd) && o.costUsd > 0 ? Math.min(o.costUsd, 1000) : 0
  if (!input && !output && !cached) return null
  return { input, output, total, ...(cached ? { cached } : {}), ...(reasoning ? { reasoning } : {}), ...(cost ? { costUsd: cost } : {}) }
}

/** 执行器上报的「正在做什么」：kind 为 idle 表示这轮没有在说的话，界面回到中性提示 */
export type LiveActivity = { runId: string; sessionId: string; kind: 'thinking' | 'tool' | 'text' | 'idle'; text: string; at: string }

/** 审批/提问入库消息的标题 */
function approvalHeading(tool: string, detail: string): string {
  if (tool !== 'userInput') return `请求授权：${tool} ${detail}`
  const qs = userInputQuestions(detail)
  if (!qs) return `Codex 提问：${detail.slice(0, 200)}`
  const head = qs.map(q => q.question).join(' / ')
  return `Codex 提问：${head.slice(0, 300)}`
}

// 返回 kick：删除设备会话 / 账号后，用它立刻关闭对应的 WS（viewer 和执行器）
export function registerRoutes(app: FastifyInstance, pool: pg.Pool, opts: RouteOptions = {}): Kick {
  const historyTimeoutMs = opts.historyTimeoutMs ?? 10_000
  const stallAfterMs = opts.stallAfterMs ?? 45 * 60_000
  // 排队项 24 小时后作废；一次上线最多投递 3 条，失败 3 次放弃
  const queueTtlMs = opts.queueTtlMs ?? 24 * 3600_000
  const queueDrainLimit = opts.queueDrainLimit ?? 3
  const queueMaxAttempts = opts.queueMaxAttempts ?? 3
  // 反复失败计数（内存态，服务重启清零）
  const spree = new AbortSpreeTracker(opts.abortSpreeCount ?? 3, opts.abortSpreeWindowMs ?? 2 * 3600_000)
  const clients = new Set<Conn>()
  // (userId, machine) -> 在线执行器连接
  const executors = new Map<string, Exec>()
  // 等待执行器返回的历史请求
  const historyWaits = new Map<string, { userId: number; machine: string; resolve: (r: HistoryResult) => void }>()
  // 每个 run 最近一次「正在做什么」：执行器实时上报，只放内存（不需要持久化），
  // 中途打开会话时随 /messages 一起下发，界面才不会一进来就空着
  const liveActivity = new Map<string, LiveActivity>()

  // 所有推送都只发给同一账号的 viewer
  const broadcast = (userId: number, msg: unknown) => {
    const text = JSON.stringify(msg)
    for (const c of clients) if (c.userId === userId && c.sock.readyState === 1) c.sock.send(text)
  }
  const pushSession = (userId: number, session: Session, notify: boolean) => broadcast(userId, { type: 'session', session, notify })
  const agentList = (userId: number) =>
    [...executors.values()]
      .filter(e => e.userId === userId)
      .map(e => e.machine)
      .sort()
  const pushAgents = (userId: number) => broadcast(userId, { type: 'agents', agents: agentList(userId) })
  const sendExecutor = (userId: number, machine: string, msg: unknown) => {
    const e = executors.get(execKey(userId, machine))
    if (!e || e.sock.readyState !== 1) return false
    try { e.sock.send(JSON.stringify(msg)); return true } catch { return false }
  }

  // approval 广播里带上 project，Android 通知用
  const withProject = async (userId: number, a: Approval) => ({ ...a, project: (await getSession(pool, userId, a.sessionId))?.project ?? '' })
  const pushApproval = async (userId: number, a: Approval, notify: boolean) => broadcast(userId, { type: 'approval', approval: await withProject(userId, a), notify })
  const pushMessage = (userId: number, message: Message) => broadcast(userId, { type: 'message', message })

  /**
   * 会话卡在等授权时，先让项目经理看能不能自己放行。
   * 放行 = 写裁决 + 通知执行器继续，人不再被打扰；判不了 = 把理由挂在记录上交给人。
   * 两种情况都会推送，调用方不必再推一次。
   */
  const refereeHandle = async (userId: number, approval: Approval, machine: string): Promise<void> => {
    const passToHuman = async (rule: string, reason: string, tier = '') => {
      const noted = await annotateApproval(pool, userId, approval.id, rule, reason, tier)
      await pushApproval(userId, noted ?? approval, true)
    }
    const manager = await getManager(pool, userId)
    // 没开代批就按原样推给人，不要往每条审批上写「未开启」这种噪音
    if (!manager.approve.enabled) return pushApproval(userId, approval, true)
    const session = await getSession(pool, userId, approval.sessionId)
    if (!session) return pushApproval(userId, approval, true)

    // 这条审批属于哪个任务：任务自己声明的边界比全局策略更具体，先按它判
    const linked = await tasksForSession(pool, userId, approval.sessionId).catch(() => [])
    const grants = linked.find(t => hasConstraints(t.constraints))?.constraints
    const verdict = judgeApproval({
      tool: approval.tool, detail: approval.detail, cwd: session.cwd, policy: manager.approve, grants,
    })
    if (verdict.action !== 'allow') return passToHuman(verdict.rule, verdict.reason, verdict.tier)

    // 代批也有配额：一小时内放行太多次，说明 agent 在跑飞，后面的全交给人
    if ((await recentApproveCount(pool, userId)) >= manager.approve.maxPerHour) {
      return passToHuman('quota', '这一小时的代批次数已用完')
    }
    const done = await decideApproval(pool, userId, approval.id, 'allowed', 'manager', verdict.rule, verdict.reason, verdict.tier)
    // 人抢先点了：这条已经处理过，什么都别再发
    if (!done) return
    if (!sendExecutor(userId, machine, { type: 'approval.decide', approvalId: approval.id, decision: 'allow' })) {
      // 执行器断了：退回待处理，别让记录显示「已放行」而实际没人继续
      await reopenApproval(pool, userId, approval.id)
      return passToHuman('offline', '项目经理已放行，但电脑端断开了')
    }
    // 时间线里留一句：谁批的、凭什么，事后能追
    const line = `项目经理已放行：${approval.tool} ${approval.detail.replace(/\s+/g, ' ').slice(0, 200)}（${verdict.reason}）`
    pushMessage(userId, await insertMessage(pool, userId, approval.sessionId, approval.runId, 'approval', line))
    await pushApproval(userId, done, false)
  }
  const pushRun = (userId: number, run: Run) => broadcast(userId, { type: 'run', run })

  const closeWhere = (pred: (c: Conn) => boolean) => {
    for (const c of [...clients, ...executors.values()]) {
      if (!pred(c)) continue
      try {
        c.sock.close(INVALID_LOGIN, '登录已失效')
      } catch {}
    }
  }
  const kick: Kick = {
    authSessions: ids => closeWhere(c => ids.includes(c.authSessionId)),
    user: userId => closeWhere(c => c.userId === userId),
  }

  // 事件按到达顺序串行处理，避免同一会话并发读写
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn)
    chain = p.catch(() => {})
    return p
  }

  const pushTask = (userId: number, task: Task) => broadcast(userId, { type: 'task', task })
  // 选了角色：补齐空着的执行工具，并把角色挂的默认配置一并套上（只补空字段，优先级跟着配置走）
  const roleDefaults = async (userId: number, task: Task, b: Record<string, unknown>): Promise<Task> => {
    if (!('roleId' in b) || task.roleId === null) return task
    const role = await getRole(pool, userId, task.roleId)
    const patch = await applyRole(pool, userId, task, role)
    if (!('priority' in b) && role.profileId !== null) {
      const p = await findProfile(pool, userId, role.profileId)
      if (p && p.priority !== 'medium') patch.priority = p.priority
    }
    return saveTask(pool, userId, patch, task.id)
  }
  // 选了项目而任务还没挂配置：项目只挂一套时直接带上；挂多套时留给派活按机器挑，
  // 免得把任务钉在另一台电脑的目录上
  const projectDefaults = async (userId: number, task: Task, b: Record<string, unknown>): Promise<Task> => {
    if (!('projectId' in b) || task.projectId === null || task.profileId !== null) return task
    const project = await findProject(pool, userId, task.projectId)
    if (!project || project.profileIds.length !== 1) return task
    return saveTask(pool, userId, { profileId: project.profileIds[0] }, task.id)
  }
  // 建任务的两条入口共用：「新建任务」和「确认处理意见」走的必须是同一套补值链——
  // 角色决定执行工具并可带出自己的配置，项目补默认配置，配置再补齐字段与检查项模板。
  // 分成两个入口各写一遍的话，从会话生成的任务和手建的任务迟早会长得不一样。
  const createTaskWithDefaults = async (userId: number, body: Record<string, unknown>): Promise<Task> => {
    let task = await saveTask(pool, userId, body)
    task = await roleDefaults(userId, task, body)
    task = await projectDefaults(userId, task, body)
    if (task.profileId !== null) {
      const profile = await getProfile(pool, userId, task.profileId)
      const patch = await applyProfile(pool, userId, task, profile)
      if (!('priority' in body) && profile.priority !== 'medium') patch.priority = profile.priority
      task = await saveTask(pool, userId, patch, task.id)
    }
    return task
  }
  // 通知过滤管线：提醒广播和快照里的提醒都带 notify（静音的照常入列，只是不弹通知）
  const checkReminders = async (user?: number) => {
    for (const r of await collectReminders(pool,user)) {
      const notify = await evaluateNotify(pool, r.userId, { kind:'reminder', entityType:r.reminder.entityType, entityId:r.reminder.entityId })
      broadcast(r.userId, {type:'reminder', reminder:{...r.reminder, notify}})
    }
  }
  const syncTask = async (userId: number, sessionId: string, state: Session['state']) => {
    const tasks = await syncTaskForSession(pool,userId,sessionId,state)
    for (const t of tasks) pushTask(userId,t)
    // 投机执行：任务进入待验收时预生成验收摘要（调用点都在 serial 内，几条查询不阻塞）
    if (state === 'done') {
      for (const t of tasks) {
        const digest = await buildReviewDigest(pool,userId,t.id)
        if (digest) broadcast(userId,{type:'task.digest',taskId:t.id,kind:'review',digest})
        // 每个任务跑完都要有文档产物：这里用摘要兜底生成一份骨架，执行端以后交的会覆盖它
        const artifact = await buildArtifact(pool,userId,t.id)
        if (artifact) broadcast(userId,{type:'task.artifact',taskId:t.id,artifact})
        // 同时往项目近况里记一句：下次派活时项目经理就知道这个项目刚做完什么
        if (t.projectId !== null) {
          await appendBrief(pool,userId,t.projectId,`「${t.title}」${summarize(digest?.lastReply ?? '','已完成',120)}`,t.id)
        }
      }
    }
  }
  // 新开任务和基于已有会话新开共用同一条创建、广播、发送和失败处理路径。
  // role 只在「任务派活」时给：模型与上下文随 run.start 一起下发给执行器（老版本执行器忽略这两个字段）。
  // prompt 用来把「实际发给 agent 的内容」和「记录里显示的内容」分开（助手在消息前面拼了输出格式契约）。
  async function startSession(userId: number, base: Pick<Session,'agent'|'machine'|'cwd'>, title: string, text: string, mode: 'fork'|'fresh', sessionKey: string, taskId?: number, branchPoint?: string, role?: { model: string | null; instructions: string }, prompt?: string) {
    const runId = randomUUID(), pendingId = `${base.agent}${PENDING}${runId}`
    const db = await pool.connect()
    let pending: Session, run: Run, message: Message, task: Task | undefined
    try {
      await db.query('BEGIN')
      pending = await createPendingSession(db,userId,pendingId,base,title)
      run = await createRun(db,userId,runId,pendingId,base.machine,taskId ?? null)
      message = await insertMessage(db,userId,pendingId,runId,'user',text)
      if (taskId !== undefined) {
        await linkSession(db,userId,taskId,pendingId)
        task = await saveTask(db,userId,{status:'doing'},taskId)
      }
      await db.query('COMMIT')
    } catch (e) { await db.query('ROLLBACK'); throw e } finally { db.release() }
    pushSession(userId,pending,false); pushRun(userId,run); pushMessage(userId,message)
    if (task) pushTask(userId,task)
    if (!sendExecutor(userId,base.machine,{type:'run.start',runId,sessionId:pendingId,agent:base.agent,sessionKey,cwd:base.cwd,text:prompt ?? text,mode,...(branchPoint ? {branchPoint} : {}),...(role?.model ? {model:role.model} : {}),...(role?.instructions ? {instructions:role.instructions} : {})})) {
      const failed = await setRunStatus(pool,userId,runId,'failed','电脑端不在线')
      if (failed) pushRun(userId,failed)
      await abortPending(userId,pendingId,'电脑端不在线')
      // 电脑恰好在这一瞬间掉线：任务已被改成 doing，但没有对应的运行，退回 todo
      if (taskId !== undefined) {
        const reverted = await saveTask(pool,userId,{status:'todo'},taskId).catch(() => undefined)
        if (reverted) pushTask(userId,reverted)
      }
      throw new TaskError('电脑端不在线',409)
    }
    return {runId,sessionId:pendingId,...(task ? {task} : {})}
  }

  // 派活编排：手动「开始」与项目经理自动派发共用这一条路径。
  // 先算清「谁来做（角色/配置→执行工具与模型）、在哪做（电脑+目录）、说什么（首条消息）」，
  // 电脑在线就立刻开跑，离线就入队等它上线（排队逻辑不变）。
  // fallbackRoleId 只在任务自己没挂角色时兜底：项目经理派活时用它指定的那个角色。
  const startTaskDispatch = async (userId: number, taskId: number, b: Record<string, unknown>, fallbackRoleId: number | null = null) => {
    const task = await getTask(pool, userId, taskId)
    // 任务是「谁来做」优先按角色定：角色可以指定执行工具、模型和上下文
    const role = (await findRole(pool, userId, task.roleId)) ?? (await findRole(pool, userId, fallbackRoleId))
    // 项目决定「在哪个项目、这个项目有什么约定」；选中的项目还会带出该角色在这个项目上的经验
    const project = await findProject(pool, userId, task.projectId)
    // 任务关联了配置但字段还空着（比如配置是后改的）：派活时用配置兜底；任务没选配置就用角色挂的那个
    const explicitProfile = await findProfile(pool, userId, task.profileId)
      ?? await findProfile(pool, userId, role?.profileId ?? null)
    const online = agentList(userId)
    // 机器先定：显式指定 > 任务上存的 > 唯一在线的那台（配置兜底放在后面）
    let machine = taskText(b.machine ?? task.machine ?? (online.length === 1 ? online[0] : ''), '电脑名', 4000)
    // 项目可以挂多套配置（每台电脑一套），按这次要去的机器挑对应那套，目录才不会串设备
    const profile = explicitProfile ?? await pickProjectProfile(pool, userId, project?.id ?? null, machine, online)
    if (!machine && profile?.machine) machine = profile.machine
    const agent = b.agent ?? role?.agent ?? task.agent ?? profile?.agent
    if (agent === 'doubao' || agent === 'workbuddy') throw new TaskError('豆包、WorkBuddy 只做状态监听，请在客户端里执行后把会话关联到任务')
    if (agent !== 'claude' && agent !== 'codex' && agent !== 'zcode') throw new TaskError('请选择 Claude、Codex 或 ZCode')
    const cwd = taskText(b.cwd ?? task.cwd ?? profile?.cwd ?? '', '项目目录', 4000)
    const text = taskText(b.text ?? (task.notes || task.title), '第一条消息', 8000)
    // 员工记忆：项目内的经验优先，其次是跨项目的通用经验；拼进系统提示一起下发
    const memories = role ? await pickMemories(pool, userId, role.id, task.projectId) : []
    // 项目近况：最近几条任务结论，让接手的人知道这个项目眼下到哪一步了
    const recent = await recentBrief(pool, userId, task.projectId)
    const instructions = [
      composeInstructions({
        role: role ? { name: role.name, title: role.title, context: role.context } : { name: '', title: '', context: '' },
        project,
        recent,
        memories: memories.map(m => m.content),
      }),
      // 任务自己声明的边界：一开始就告诉它，省得做一半被卡住
      boundaryLine(task.constraints),
    ].filter(Boolean).join('\n\n')
    const dispatch = { model: roleModel(role), instructions }
    // 电脑离线不再直接失败：入队，等那台电脑上线后自动派发（派给谁、发什么都定下来了）
    if (!executors.has(execKey(userId, machine))) {
      await enqueueDispatch(pool, userId, task.id, { machine, agent, cwd, text, ...dispatch })
      const queued = await saveTask(pool, userId, { agent, machine, cwd }, task.id)
      pushTask(userId, queued)
      return { queued: true, task: queued }
    }
    // 手动派发优先于排队：同一任务曾在队列里就作废掉，避免重复投递
    if (await dequeueDispatch(pool, userId, task.id)) pushTask(userId, await getTask(pool, userId, task.id))
    const res = await startSession(userId, { agent, machine, cwd }, task.title, text, 'fresh', '', task.id, undefined, dispatch)
    // 执行器太旧：模型和上下文会随 run.start 发过去但被忽略，得让用户知道角色没真正生效
    const degraded = !executors.get(execKey(userId, machine))?.roleV1 && !!(dispatch.model || dispatch.instructions)
    if (!degraded) await markMemoriesUsed(pool, memories.map(m => m.id))
    return degraded ? { ...res, queued: false, roleDegraded: true } : { ...res, queued: false }
  }

  // 电脑上线后把排队的活按入队顺序投递；失败累计次数，超过上限就放弃并记录
  async function drainQueue(userId: number, machine: string) {
    for (const item of await queuedFor(pool, userId, machine, queueDrainLimit)) {
      if (!executors.has(execKey(userId, machine))) return
      let ok = false
      try {
        await startSession(userId, { agent: item.agent as Session['agent'], machine, cwd: item.cwd }, item.title, item.text, 'fresh', '', item.taskId, undefined, { model: item.model, instructions: item.instructions })
        ok = true
      } catch (e) {
        const attempts = await bumpAttempts(pool, userId, item.taskId)
        app.log.warn({ taskId: item.taskId, attempts, err: String(e) }, '排队派发失败')
        if (attempts >= queueMaxAttempts) {
          await dequeueDispatch(pool, userId, item.taskId)
          app.log.warn({ taskId: item.taskId }, '排队派发连续失败，已放弃')
        }
      }
      if (ok) await dequeueDispatch(pool, userId, item.taskId)
      const task = await getTask(pool, userId, item.taskId).catch(() => undefined)
      if (task) pushTask(userId, task)
    }
  }

  // 执行器掉线（或被新连接顶掉）：它名下的 run 标 failed，pending 授权标 expired
  async function dropExecutor(userId: number, machine: string) {
    const runs = await failActiveRuns(pool, userId, machine, '电脑端断开')
    for (const r of runs) {
      pushRun(userId, r)
      if (r.sessionId) await abortPending(userId, r.sessionId, r.error)
    }
    const expired = await expireApprovalsOfRuns(
      pool,
      userId,
      runs.map(r => r.id),
    )
    for (const a of expired) await pushApproval(userId, a, false)
    for (const [id, w] of historyWaits) {
      if (w.userId === userId && w.machine === machine) {
        historyWaits.delete(id)
        w.resolve({ messages: [], error: '电脑端断开' })
      }
    }
  }

  // 拿到真实 id 之前 run 就结束了：临时会话标 aborted 并提醒（走通知过滤管线）
  async function abortPending(userId: number, sessionId: string, error: string) {
    if (!isPendingId(sessionId)) return
    const s = await abortPendingSession(pool, userId, sessionId, error || '启动失败')
    if (!s) return
    const notify = await evaluateNotify(pool, userId, { kind:'session', agent:s.agent, state:'aborted', sessionId:s.id })
    pushSession(userId, s, notify)
  }

  // 鉴权：/health、/auth/login、/admin 页面和 /admin/* 接口（它们自己有 adminGuard）免登录；其它都要设备会话 token
  app.decorateRequest('userId', 0)
  app.decorateRequest('authSessionId', 0)
  app.addHook('onRequest', async (req, reply) => {
    // 没有对应路由的请求（比如 /auth/register）交给 404 处理，不要先返回 401
    if (req.method === 'OPTIONS' || req.is404) return
    const path = req.url.split('?')[0]
    if (path === '/health' || path === '/auth/login' || path === '/admin' || path.startsWith('/admin/')) return
    const isWs = path === '/ws'
    const token = isWs ? new URL(req.url, 'http://x').searchParams.get('token') : bearer(req)
    const r = await authenticate(pool, token)
    if ('error' in r) return reply.code(401).send({ error: r.error })
    req.userId = r.userId
    req.authSessionId = r.authSessionId
  })

  app.get('/health', async () => ({ ok: true }))

  app.post('/events', async (req, reply) => {
    const body = req.body as { events?: unknown }
    if (!body || !Array.isArray(body.events) || body.events.length > 100) return reply.code(400).send({ error: 'events 必须是不超过 100 条的数组' })
    const events = body.events.map(parseEvent)
    if (events.some(e => !e)) return reply.code(400).send({ error: '事件格式不对' })
    let accepted = 0
    for (const ev of events as EventIn[]) {
      const res = await serial(async () => {
        const r = await applyEvent(pool,req.userId,ev)
        if (r) {
          // 通知过滤管线（Fast Path）：底层判定可通知后，再过账号规则；静音的照常入列
          // 角色助手的会话不弹通知：人就等在面板前，回话几秒后自己会看到
          const notify = r.notify && !r.session.title.startsWith(ASSISTANT_TITLE)
            ? await evaluateNotify(pool, req.userId, { kind:'session', agent:r.session.agent, state:r.session.state as 'done'|'aborted'|'waiting', sessionId:r.session.id })
            : false
          pushSession(req.userId,r.session,notify)
          await syncTask(req.userId,r.session.id,r.session.state)
          // 会话跑完：攒一条处理意见等人确认。补报的历史（quiet）不生成；角色助手和细化会话本身也不生成，
          // 否则「问角色」也会产出一条待办，细化还会无限套娃。
          if (r.session.state === 'done' && !ev.quiet &&
              !r.session.title.startsWith(ASSISTANT_TITLE) && !r.session.title.startsWith(PROPOSAL_TITLE)) {
            const proposal = await generateProposal(pool, req.userId, r.session, r.session.eventAt)
              .catch(e => { app.log.error(e, '生成处理意见失败'); return null })
            if (proposal) broadcast(req.userId, { type: 'proposal', proposal })
          }
          // Watchdog：反复失败达到阈值时提醒一次（running 清零计数）
          if ((ev.state === 'aborted' || ev.state === 'running') && !ev.quiet &&
              spree.record(req.userId, r.session.id, ev.state)) {
            broadcast(req.userId, { type:'watchdog', issue:'abort-spree', session:r.session })
          }
        }
        return r
      })
      if (!res) continue
      accepted++
    }
    return { accepted }
  })

  app.get('/sessions', async req => {
    const q = req.query as { all?: string }
    return { sessions: await listSessions(pool, req.userId, q.all === '1') }
  })

  // ---------- 目标与任务（所有变更与执行器事件串行） ----------
  app.get('/goals', async req => serial(async () => ({goals:await listGoals(pool,req.userId)})))
  app.get('/tasks', async req => serial(async () => ({tasks:await listTasks(pool,req.userId)})))
  app.post('/reminders/:id/ack', async req => serial(async () => {
    const id = entityId((req.params as {id:string}).id)
    await ackReminder(pool,req.userId,id)
    broadcast(req.userId,{type:'reminder.acked',id})
    return {ok:true}
  }))
  // 账号级通知规则：agent 静音、免打扰时段、最低优先级（Fast Path）；审批与等待授权不受影响
  app.get('/notify/settings', async req => ({ settings: await getSettings(pool, req.userId) }))
  app.patch('/notify/settings', async req => serial(async () => {
    const settings = await saveSettings(pool, req.userId, req.body)
    broadcast(req.userId, { type: 'notify.settings', settings })
    return { settings }
  }))
  // 项目配置：一组执行环境（agent / 电脑 / 目录）+ 默认优先级 + 检查项模板，起个名字复用
  app.get('/profiles', async req => serial(async () => ({ profiles: await listProfiles(pool, req.userId) })))
  app.post('/profiles', async req => serial(async () => ({ profile: await saveProfile(pool, req.userId, req.body) })))
  app.patch('/profiles/:id', async req => serial(async () => ({
    profile: await saveProfile(pool, req.userId, req.body, entityId((req.params as {id:string}).id)),
  })))
  app.delete('/profiles/:id', async req => serial(async () => {
    const id = entityId((req.params as {id:string}).id)
    // 配置删掉后任务上的执行字段留着，只是不再指向任何配置；这些任务要推一次才能看到变化
    const affected = (await listTasks(pool, req.userId)).filter(t => t.profileId === id).map(t => t.id)
    await deleteProfile(pool, req.userId, id)
    for (const taskId of affected) pushTask(req.userId, await getTask(pool, req.userId, taskId))
    return { ok: true }
  }))
  // 角色：谁来做（执行工具）+ 用什么模型 + 按什么准则（上下文），可再挂一个默认配置
  app.get('/roles', async req => serial(async () => ({ roles: await listRoles(pool, req.userId) })))
  app.post('/roles', async req => serial(async () => ({ role: await saveRole(pool, req.userId, req.body) })))
  app.patch('/roles/:id', async req => serial(async () => ({
    role: await saveRole(pool, req.userId, req.body, entityId((req.params as {id:string}).id)),
  })))
  app.delete('/roles/:id', async req => serial(async () => {
    // 角色删掉后任务上的角色引用被置空（执行工具 / 电脑 / 目录都留着），这些任务要推一次
    const affected = await deleteRole(pool, req.userId, entityId((req.params as {id:string}).id))
    for (const taskId of affected) pushTask(req.userId, await getTask(pool, req.userId, taskId))
    return { ok: true }
  }))
  // 角色记忆：员工的经验条目。projectId 不传 = 全部；传 null = 只列跨项目的通用经验
  app.get('/roles/:id/memories', async req => serial(async () => {
    const roleId = entityId((req.params as {id:string}).id)
    await getRole(pool, req.userId, roleId)
    const q = (req.query ?? {}) as { projectId?: string }
    const scope = q.projectId === undefined ? undefined : q.projectId === '' || q.projectId === 'null' ? null : entityId(q.projectId)
    return { memories: await listMemories(pool, req.userId, roleId, scope) }
  }))
  app.post('/roles/:id/memories', async req => serial(async () => {
    const roleId = entityId((req.params as {id:string}).id)
    await getRole(pool, req.userId, roleId)
    const b = object(req.body ?? {})
    const projectId = b.projectId === undefined || b.projectId === null ? null : entityId(b.projectId)
    const memory = await addMemory(pool, req.userId, roleId, projectId, b.content as string, 'manual')
    return { memory }
  }))
  app.patch('/roles/:id/memories/:memoryId', async req => serial(async () => {
    const p = req.params as {id:string;memoryId:string}
    return { memory: await updateMemory(pool, req.userId, entityId(p.id), entityId(p.memoryId), req.body) }
  }))
  app.delete('/roles/:id/memories/:memoryId', async req => serial(async () => {
    const p = req.params as {id:string;memoryId:string}
    await deleteMemory(pool, req.userId, entityId(p.id), entityId(p.memoryId))
    return { ok: true }
  }))
  // ---------- 角色助手：一句话 → agent 出草稿 → 人确认才落库 ----------
  // 派活通道复用：助手对话就是一个真实会话（ram 里跑在用户自己的电脑上），
  // 服务端只额外记住「这个会话属于助手」，好把 agent 回的 JSON 认成草稿。
  app.get('/assistant', async req => serial(async () => {
    const thread = await getThread(pool, req.userId)
    const [messages, drafts, run, roles, profiles, dirRows] = await Promise.all([
      thread?.sessionId ? listMessages(pool, req.userId, thread.sessionId, 100) : Promise.resolve([]),
      thread ? listDrafts(pool, req.userId, thread.id) : Promise.resolve([]),
      thread?.lastRunId ? getRun(pool, req.userId, thread.lastRunId) : Promise.resolve(null),
      listRoles(pool, req.userId),
      listProfiles(pool, req.userId),
      // 目录候选：这台账号用过的目录，界面下拉直接选，省得每次都手打路径
      pool.query(`SELECT machine, cwd, max(updated_at) at FROM sessions
                  WHERE user_id = $1 AND cwd <> '' GROUP BY machine, cwd ORDER BY at DESC LIMIT 40`, [req.userId]),
    ])
    const online = agentList(req.userId)
    const seen = new Set<string>()
    const dirs = [
      // 配置里登记的排在前面：那是用户刻意维护的目录
      ...profiles.filter(p => p.cwd).map(p => ({ machine: p.machine ?? '', cwd: p.cwd as string })),
      ...dirRows.rows.map(r => ({ machine: String(r.machine ?? ''), cwd: String(r.cwd) })),
    ].filter(d => {
      const key = `${d.machine}\0${d.cwd}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, 40)
    return {
      thread,
      messages,
      drafts,
      // 正在等 agent 回话：界面据此显示「思考中」并锁住输入框
      pending: !!run && (run.status === 'queued' || run.status === 'running'),
      runError: run && run.status === 'failed' ? run.error : '',
      online,
      suggestion: {
        agent: thread?.agent ?? 'claude',
        machine: thread?.machine ?? (online.length === 1 ? online[0] : ''),
        // 默认就是空：交给电脑端用 <文档>/AgentHub，用户不用为了建角色先挑项目目录
        cwd: thread?.cwd ?? '',
      },
      dirs,
      roles: roles.length,
    }
  }))
  // 开新对话：清掉旧 thread（旧草稿一并没了），重新派一次
  app.post('/assistant/start', async req => serial(async () => {
    const b = object(req.body ?? {})
    const request = taskText(b.text, '需求', 4000)
    const machine = taskText(b.machine, '电脑名', 200)
    // 先确认电脑在线再动旧 thread：开新对话会连草稿一起清掉，别因为一台离线电脑白丢历史
    if (!executors.has(execKey(req.userId, machine))) throw new TaskError('那台电脑不在线，先在电脑上打开 AgentHub', 409)
    // 目录留空 = 用电脑端自己的默认工作目录（<文档>/AgentHub，卸载重装也还在）
    const cwd = typeof b.cwd === 'string' ? b.cwd : ''
    const thread = await startThread(pool, req.userId, { agent: b.agent, machine, cwd })
    const [roles, profiles] = await Promise.all([listRoles(pool, req.userId), listProfiles(pool, req.userId)])
    const prompt = openingMessage({
      request,
      roles: roles.map(r => ({ name: r.name, title: r.title })),
      profiles: profiles.map(p => ({ id: p.id, name: p.name })),
    })
    const res = await startSession(
      req.userId, { agent: thread.agent, machine: thread.machine, cwd: thread.cwd },
      `${ASSISTANT_TITLE}${request.slice(0, 40)}`, request, 'fresh', '', undefined, undefined, undefined, prompt,
    )
    await markDispatch(pool, req.userId, res.runId)
    return { thread: await getThread(pool, req.userId), runId: res.runId }
  }))
  // 追问：同一条会话续聊，契约已经在上下文里了，消息前面只补一句提醒
  app.post('/assistant/reply', async req => serial(async () => {
    const thread = await getThread(pool, req.userId)
    if (!thread?.sessionId) throw new TaskError('还没开始对话', 409)
    const request = taskText(object(req.body ?? {}).text, '需求', 4000)
    const session = await getSession(pool, req.userId, thread.sessionId)
    if (!session) throw new TaskError('助手会话已经不在了，重新开始一次', 409)
    if (!executors.has(execKey(req.userId, session.machine))) throw new TaskError('那台电脑不在线', 409)
    if (await activeRun(pool, req.userId, session.id)) throw new TaskError('上一句还在想，等它回完再说', 409)
    const run = await createRun(pool, req.userId, randomUUID(), session.id, session.machine)
    const message = await insertMessage(pool, req.userId, session.id, run.id, 'user', request)
    await markDispatch(pool, req.userId, run.id)
    pushRun(req.userId, run)
    pushMessage(req.userId, message)
    const sent = sendExecutor(req.userId, session.machine, {
      type: 'run.start', runId: run.id, sessionId: session.id, agent: session.agent,
      sessionKey: session.id.slice(session.id.indexOf(':') + 1), cwd: session.cwd,
      text: followupMessage(request), mode: 'resume',
    })
    if (!sent) {
      const failed = await setRunStatus(pool, req.userId, run.id, 'failed', '电脑端不在线')
      if (failed) pushRun(req.userId, failed)
      throw new TaskError('电脑端不在线', 409)
    }
    return { runId: run.id }
  }))
  // 确认：用户可能改过字段，改过的键以界面为准，其余按草稿原值，最终仍走 saveRole 的校验
  app.post('/assistant/drafts/:id/confirm', async req => serial(async () => {
    const id = entityId((req.params as {id:string}).id)
    const draft = await getDraft(pool, req.userId, id)
    if (draft.status !== 'pending') throw new TaskError('这张草稿已经处理过了', 409)
    const base = draft.draft ?? { name: '', title: '', agent: null, model: null, context: '', tools: [], profileId: null }
    const role = await saveRole(pool, req.userId, { ...base, ...draftPatch(req.body) })
    const updated = await markDraft(pool, req.userId, id, 'created', role.id)
    return { role, draft: updated }
  }))
  app.post('/assistant/drafts/:id/discard', async req => serial(async () => ({
    draft: await markDraft(pool, req.userId, entityId((req.params as {id:string}).id), 'discarded'),
  })))
  // 重开：连会话一起放掉，助手记录里不再有这条
  app.post('/assistant/reset', async req => serial(async () => {
    await resetThread(pool, req.userId)
    return { ok: true }
  }))
  // 项目：一个代码库的身份与背景知识，可指向一套默认执行配置
  app.get('/projects', async req => serial(async () => ({ projects: await listProjects(pool, req.userId) })))
  app.post('/projects', async req => serial(async () => ({ project: await saveProject(pool, req.userId, req.body) })))
  app.patch('/projects/:id', async req => serial(async () => ({
    project: await saveProject(pool, req.userId, req.body, entityId((req.params as {id:string}).id)),
  })))
  app.delete('/projects/:id', async req => serial(async () => {
    const id = entityId((req.params as {id:string}).id)
    // 项目删掉后任务上的归属被置空，这些任务要推一次才能看到变化
    const affected = (await listTasks(pool, req.userId)).filter(t => t.projectId === id).map(t => t.id)
    await deleteProject(pool, req.userId, id)
    for (const taskId of affected) pushTask(req.userId, await getTask(pool, req.userId, taskId))
    return { ok: true }
  }))
  app.get('/projects/:id', async req => serial(async () => ({
    project: await getProject(pool, req.userId, entityId((req.params as {id:string}).id)),
  })))
  // 项目近况：任务完成时自动追加，也可人手写一条/删掉写错的。派活时取最近几条注入提示
  app.get('/projects/:id/brief', async req => serial(async () => ({
    entries: await listBrief(pool, req.userId, entityId((req.params as {id:string}).id)),
  })))
  app.post('/projects/:id/brief', async req => serial(async () => {
    const id = entityId((req.params as {id:string}).id)
    await getProject(pool, req.userId, id)
    const b = object(req.body ?? {})
    await appendBrief(pool, req.userId, id, taskText(b.text, '近况', 240))
    return { entries: await listBrief(pool, req.userId, id) }
  }))
  app.delete('/projects/:id/brief/:entryId', async req => serial(async () => {
    const p = req.params as {id:string;entryId:string}
    const id = entityId(p.id)
    await deleteBrief(pool, req.userId, id, entityId(p.entryId))
    return { entries: await listBrief(pool, req.userId, id) }
  }))
  app.post('/goals', async req => serial(async () => {
    const goal = await saveGoal(pool,req.userId,req.body)
    broadcast(req.userId,{type:'goal',goal}); return {goal}
  }))
  app.patch('/goals/:id', async req => serial(async () => {
    const goal = await saveGoal(pool,req.userId,req.body,entityId((req.params as {id:string}).id))
    broadcast(req.userId,{type:'goal',goal}); return {goal}
  }))
  app.delete('/goals/:id', async req => serial(async () => {
    const id = entityId((req.params as {id:string}).id)
    const affected = (await listTasks(pool,req.userId)).filter(t => t.goalId === id)
    await deleteGoal(pool,req.userId,id)
    broadcast(req.userId,{type:'goal.removed',id})
    for (const t of affected) pushTask(req.userId,await getTask(pool,req.userId,t.id))
    return {ok:true}
  }))
  app.post('/tasks', async req => serial(async () => {
    // 三条补值链（角色 → 项目 → 配置）与「确认处理意见」共用，见 createTaskWithDefaults
    const task = await createTaskWithDefaults(req.userId, object(req.body ?? {}))
    pushTask(req.userId,task); return {task}
  }))
  app.patch('/tasks/:id', async req => serial(async () => {
    const id = entityId((req.params as {id:string}).id)
    const b = object(req.body ?? {})
    let task = await saveTask(pool,req.userId,req.body,id)
    // 只有这次请求显式换了角色才套用，避免每次编辑都重算
    task = await roleDefaults(req.userId, task, b)
    task = await projectDefaults(req.userId, task, b)
    // 只有这次请求显式改了配置 / 项目才套用，避免每次编辑任务都重算一遍检查项
    if (('profileId' in b || 'projectId' in b) && task.profileId !== null) {
      const profile = await getProfile(pool, req.userId, task.profileId)
      task = await saveTask(pool, req.userId, await applyProfile(pool, req.userId, task, profile), task.id)
    }
    // 标记完成时收尾手动计时的执行记录，日历才能看到真实的结束时间
    if ((req.body as {status?:unknown}|null)?.status === 'done')
      for (const r of await closeTaskRuns(pool,req.userId,id,'done')) pushRun(req.userId,r)
    // 手动推进到待验收/已完成也补一份产物：不依赖会话事件，「每个任务都有文档」才成立
    if (b.status === 'review' || b.status === 'done') {
      const artifact = await buildArtifact(pool,req.userId,id)
      if (artifact) broadcast(req.userId,{type:'task.artifact',taskId:id,artifact})
      // 项目近况：同一任务只记一条（唯一索引兜住），已由会话完成写过时这里不会重复
      if (b.status === 'done' && task.projectId !== null) await appendBrief(pool,req.userId,task.projectId,`「${task.title}」已完成`,id)
    }
    pushTask(req.userId,task); return {task}
  }))
  app.delete('/tasks/:id', async req => serial(async () => {
    const id = entityId((req.params as {id:string}).id)
    await deleteTask(pool,req.userId,id)
    broadcast(req.userId,{type:'task.removed',id}); return {ok:true}
  }))
  app.post('/tasks/:id/sessions', async req => serial(async () => {
    const task = await linkSession(pool,req.userId,entityId((req.params as {id:string}).id),taskText(object(req.body).sessionId,'会话 ID',200))
    pushTask(req.userId,task); return {task}
  }))
  // 验收：检查项（来自任务清单）+ 证据（会话记录摘取）+ 打回沉淀的标准
  app.get('/tasks/:id/review', async req => serial(async () => {
    return getReview(pool, req.userId, entityId((req.params as {id:string}).id))
  }))
  app.post('/tasks/:id/review', async req => serial(async () => {
    const id = entityId((req.params as {id:string}).id)
    const item = await addReviewItem(pool, req.userId, id, taskText(object(req.body).title, '检查项', 500))
    return { item }
  }))
  app.patch('/tasks/:id/review/:itemId', async req => serial(async () => {
    const p = req.params as {id:string;itemId:string}
    const b = object(req.body)
    const status = b.status
    if (status !== 'pending' && status !== 'pass' && status !== 'fail') throw new TaskError('判定状态不合法')
    const note = b.note === undefined ? '' : taskText(b.note, '打回原因', 500, true)
    const item = await decideReviewItem(pool, req.userId, entityId(p.id), entityId(p.itemId), status, note)
    return { item }
  }))
  // 投机预摘要：验收摘要（进入待验收时后台生成）与失败上下文
  app.get('/tasks/:id/digest', async req => serial(async () => {
    const id = entityId((req.params as {id:string}).id)
    await getTask(pool,req.userId,id)
    return getDigests(pool,req.userId,id)
  }))
  // 任务产物：跑完自动生成一份 Markdown 骨架，人可改、可重建、可删。path 是导出时建议的文件名
  app.get('/tasks/:id/artifact', async req => serial(async () => {
    const id = entityId((req.params as {id:string}).id)
    const task = await getTask(pool,req.userId,id)
    // 老任务没赶上自动生成：打开时补一次，人改过的不会被覆盖
    const artifact = await getArtifact(pool,req.userId,id) ?? await buildArtifact(pool,req.userId,id)
    return { artifact, path: artifactPath(id, task.title) }
  }))
  app.patch('/tasks/:id/artifact', async req => serial(async () => {
    const id = entityId((req.params as {id:string}).id)
    await getTask(pool,req.userId,id)
    const b = object(req.body ?? {})
    if (typeof b.md !== 'string') throw new TaskError('产物内容必须是文本')
    const artifact = await saveArtifact(pool,req.userId,id,b.md)
    broadcast(req.userId,{type:'task.artifact',taskId:id,artifact})
    return { artifact }
  }))
  // 重建：会用最新的会话材料覆盖骨架。人改过的要显式 force 才覆盖
  app.post('/tasks/:id/artifact/rebuild', async req => serial(async () => {
    const id = entityId((req.params as {id:string}).id)
    const task = await getTask(pool,req.userId,id)
    const b = object(req.body ?? {})
    const artifact = await buildArtifact(pool,req.userId,id,{ force: b.force === true })
    if (!artifact) throw new TaskError('这个任务还没有可整理的材料', 409)
    broadcast(req.userId,{type:'task.artifact',taskId:id,artifact})
    return { artifact, path: artifactPath(id, task.title) }
  }))
  app.delete('/tasks/:id/artifact', async req => serial(async () => {
    const id = entityId((req.params as {id:string}).id)
    await getTask(pool,req.userId,id)
    await deleteArtifact(pool,req.userId,id)
    return { ok: true }
  }))
  // Thread 视图：任务 = 统一事件流（关联会话消息 + 执行记录 + 时间提醒 + 摘要）
  app.get('/threads/task/:id', async req => serial(async () => {
    const id = entityId((req.params as {id:string}).id)
    await getTask(pool,req.userId,id)
    const q = req.query as { limit?: string }
    const limit = Math.min(Math.max(Number.parseInt(q.limit ?? '200', 10) || 200, 1), 200)
    return { events: await taskThread(pool,req.userId,id,limit) }
  }))
  // 手动计时：任务不依赖任何会话也能产生执行记录（日历里的基本单位）
  app.post('/tasks/:id/timer/start', async req => serial(async () => {
    const taskId = entityId((req.params as {id:string}).id)
    const task = await getTask(pool,req.userId,taskId)
    if (task.status === 'done') throw new TaskError('已完成的任务不能再开始计时')
    if (await activeTaskRun(pool,req.userId,taskId)) throw new TaskError('这个任务已经在执行中',409)
    const run = await createTaskRun(pool,req.userId,randomUUID(),taskId)
    pushRun(req.userId,run)
    const updated = await saveTask(pool,req.userId,{status:'doing'},taskId)
    pushTask(req.userId,updated)
    return {run,task:updated}
  }))
  app.post('/tasks/:id/timer/stop', async req => serial(async () => {
    const taskId = entityId((req.params as {id:string}).id)
    await getTask(pool,req.userId,taskId)
    const run = await activeTaskRun(pool,req.userId,taskId)
    if (!run) throw new TaskError('这个任务没有在执行',409)
    const stopped = await stopTaskRun(pool,req.userId,run.id)
    if (stopped) pushRun(req.userId,stopped)
    return {run:stopped,task:await getTask(pool,req.userId,taskId)}
  }))
  app.delete('/tasks/:id/sessions/:sessionId', async req => serial(async () => {
    const p = req.params as {id:string;sessionId:string}
    const task = await linkSession(pool,req.userId,entityId(p.id),p.sessionId,true)
    pushTask(req.userId,task); return {task}
  }))
  app.post('/tasks/:id/start', async req => serial(async () =>
    startTaskDispatch(req.userId, entityId((req.params as {id:string}).id), object(req.body ?? {}))))
  app.delete('/tasks/:id/queue', async req => serial(async () => {
    const id = entityId((req.params as {id:string}).id)
    await getTask(pool,req.userId,id)
    await dequeueDispatch(pool,req.userId,id)
    const task = await getTask(pool,req.userId,id)
    pushTask(req.userId,task); return {task}
  }))
  // ---------- 处理意见：会话跑完 → 攒一件事 → 人确认才建任务 ----------
  // 意见挂在会话上（会话可能还没挂任务），确认后才变成任务；生成与确认都不改会话本身。
  app.get('/proposals', async req => {
    const q = req.query as { sessionId?: string; limit?: string }
    const sessionId = typeof q.sessionId === 'string' && q.sessionId ? q.sessionId : undefined
    const limit = Math.min(Math.max(Number.parseInt(q.limit ?? '50', 10) || 50, 1), 200)
    return { proposals: await listProposals(pool, req.userId, { sessionId, limit }) }
  })
  // 细化：借电脑上已登录的 agent 重写这份意见。和角色助手同一条通道，服务端仍然没有模型凭据。
  app.post('/proposals/:id/refine', async req => serial(async () => {
    const id = entityId((req.params as {id:string}).id)
    const proposal = await getProposal(pool, req.userId, id)
    if (proposal.status !== 'pending') throw new TaskError('这条意见已经处理过了', 409)
    const b = object(req.body ?? {})
    const session = await getSession(pool, req.userId, proposal.sessionId)
    const online = agentList(req.userId)
    const machine = taskText(b.machine ?? session?.machine ?? (online.length === 1 ? online[0] : ''), '电脑名', 200)
    if (!executors.has(execKey(req.userId, machine))) throw new TaskError('那台电脑不在线，先在电脑上打开 AgentHub', 409)
    const manager = await getManager(pool, req.userId)
    const role = await findRole(pool, req.userId, manager.roleId)
    // 谁来判断：优先用项目经理角色配的执行工具；没配就跟着原会话那台用同一个工具
    const agent = role?.agent === 'claude' || role?.agent === 'codex' || role?.agent === 'zcode'
      ? role.agent
      : (session && (session.agent === 'claude' || session.agent === 'codex' || session.agent === 'zcode') ? session.agent : 'claude')
    const [msgs, task, roles, projects] = await Promise.all([
      listMessages(pool, req.userId, proposal.sessionId, 8),
      proposal.taskId === null ? Promise.resolve(null) : getTask(pool, req.userId, proposal.taskId).catch(() => null),
      listRoles(pool, req.userId),
      listProjects(pool, req.userId),
    ])
    const prompt = refineMessage({
      sessionTitle: proposal.sessionTitle,
      agent: proposal.sessionAgent,
      project: proposal.sessionProject,
      task: task ? { title: task.title, notes: task.notes, todo: task.checklist.filter(i => !i.done).map(i => i.text) } : null,
      tail: msgs.filter(m => m.role === 'user' || m.role === 'assistant').slice(-6).map(m => ({ role: m.role, text: m.text })),
      evidence: proposal.evidence,
      draft: {
        title: proposal.title, notes: proposal.notes, checklist: proposal.checklist,
        constraints: proposal.constraints,
        // 现在的执行人一并给项目经理看：它可以选择沿用，也可以换人
        assignee: [proposal.assignee.roleName, proposal.assignee.agent, proposal.assignee.machine].filter(Boolean).join(' · '),
      },
      roles: roles.map(r => ({ id: r.id, name: r.name, title: r.title, agent: r.agent ?? '' })),
      projects: projects.map(p => ({ id: p.id, name: p.name })),
    })
    // 项目经理自己的上下文就是它做判断的准则，拼在首条消息前面（与派活时的系统提示同源）
    const brief = role?.context ? `${role.context}\n\n${prompt}` : prompt
    // 第 9 参是「这次 run 用谁的身份」：漏了它，细化就会用执行工具自己的默认模型，
    // 项目经理角色配的模型等于没配。上下文已经在 brief 里，这里不再重复注入 instructions。
    const res = await startSession(
      req.userId, { agent, machine, cwd: session?.cwd ?? '' },
      `${PROPOSAL_TITLE}${proposal.title.slice(0, 40)}`, prompt, 'fresh', '', undefined, undefined,
      { model: roleModel(role), instructions: '' }, brief,
    )
    await markRefineRun(pool, req.userId, id, res.runId)
    return { runId: res.runId }
  }))
  // 确认：这张任务单已经是「谁做、在哪做、做什么」都齐了的，确认即落库。
  // 默认顺手派发（人点了确认就是要它开始）；dispatch:false 表示只建任务，留着以后自己派或交给项目经理。
  app.post('/proposals/:id/confirm', async req => serial(async () => {
    const id = entityId((req.params as {id:string}).id)
    const proposal = await getProposal(pool, req.userId, id)
    if (proposal.status !== 'pending') throw new TaskError('这条意见已经处理过了', 409)
    const b = object(req.body ?? {})
    const patch = proposalPatch(b)
    // 执行人优先取项目经理排好的（角色 + 配置），界面改了哪个字段就按界面的来。
    // 配置只带「明确指派过的那一套」：项目兜底配置留给派发时按在线机器挑，别把任务钉在离线的电脑上。
    const body: Record<string, unknown> = {
      title: proposal.title,
      notes: proposal.notes,
      priority: proposal.priority,
      roleId: proposal.assignee.roleId,
      projectId: proposal.projectId,
      profileId: proposal.profileId,
      checklist: toChecklist(proposal.checklist),
      // 项目经理声明的执行边界跟着任务走：代批和派发都要用它
      constraints: proposal.constraints,
    }
    // 清单传的是文本数组，转成任务的 {id,text,done}
    for (const [k, v] of Object.entries(patch)) {
      body[k] = k === 'checklist'
        ? toChecklist(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
        : v
    }
    const task = await createTaskWithDefaults(req.userId, body)
    const linked = await linkSession(pool, req.userId, task.id, proposal.sessionId)
    await markProposal(pool, req.userId, id, 'accepted', task.id)
    pushTask(req.userId, linked)
    // 派发失败不影响任务已建好这件事，把原因带回去让界面提示
    let dispatched: { queued: boolean } | null = null
    let dispatchError = ''
    if (b.dispatch !== false) {
      try { dispatched = await startTaskDispatch(req.userId, linked.id, {}) }
      catch (e) { dispatchError = e instanceof Error ? e.message : String(e) }
    }
    return { task: await getTask(pool, req.userId, linked.id), proposal: await getProposal(pool, req.userId, id), dispatched, dispatchError }
  }))
  app.post('/proposals/:id/discard', async req => serial(async () => ({
    proposal: await markProposal(pool, req.userId, entityId((req.params as {id:string}).id), 'discarded'),
  })))

  // ---------- 项目经理：全局一个，负责细化意见 + （可选）自动派发已确认的任务 ----------
  app.get('/dispatch/manager', async req => serial(async () => {
    const manager = await getManager(pool, req.userId)
    const [roles, running, recent] = await Promise.all([
      listRoles(pool, req.userId),
      runningCount(pool, req.userId),
      recentAutoCount(pool, req.userId),
    ])
    return { manager, roles, running, recent, quota: quota(manager, running, recent) }
  }))
  app.patch('/dispatch/manager', async req => serial(async () => {
    const manager = await saveManager(pool, req.userId, req.body)
    const [running, recent] = await Promise.all([runningCount(pool, req.userId), recentAutoCount(pool, req.userId)])
    return { manager, running, recent, quota: quota(manager, running, recent) }
  }))

  // 派活看板：排队中 / 在跑 / 卡住（进行中无运行）的任务聚到一张板上
  app.get('/dispatch/board', async req => serial(async () =>
    dispatchBoard(pool, req.userId, agentList(req.userId))))

  app.post('/sessions/ack-all', async req => {
    const list = await ackAll(pool, req.userId)
    for (const s of list) pushSession(req.userId, s, false)
    return { acked: list.length }
  })

  app.post('/sessions/:id/ack', async (req, reply) => {
    const s = await ackSession(pool, req.userId, (req.params as { id: string }).id)
    if (!s) return reply.code(404).send({ error: '会话不存在' })
    pushSession(req.userId, s, false)
    return { ok: true }
  })

  app.delete('/sessions/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id
    if (!(await removeSession(pool, req.userId, id))) return reply.code(404).send({ error: '会话不存在' })
    broadcast(req.userId, { type: 'removed', id })
    return { ok: true }
  })

  // ---------- 远程控制 ----------

  app.get('/control/status', async req => ({ agents: agentList(req.userId) }))

  app.get('/sessions/:id/messages', async (req, reply) => {
    const id = (req.params as { id: string }).id
    const q = req.query as { limit?: string }
    const limit = Math.min(Math.max(Number.parseInt(q.limit ?? '100', 10) || 100, 1), 200)
    // 会话不属于当前账号一律 404（不泄露别人的数据是否存在）
    if (!(await getSession(pool, req.userId, id))) return reply.code(404).send({ error: '会话不存在' })
    const [messages, approvals, run] = await Promise.all([listMessages(pool, req.userId, id, limit), pendingApprovals(pool, req.userId, id), latestRun(pool, req.userId, id)])
    // 正在跑的话把最近一次「正在做什么」一起带上（内存态，没赶上就没有）
    const activity = run && (run.status === 'running' || run.status === 'queued') ? liveActivity.get(run.id) ?? null : null
    return { messages, approvals, run, activity }
  })

  app.post('/sessions/:id/messages', { bodyLimit: MESSAGE_BODY_LIMIT }, async (req, reply) => {
    const userId = req.userId
    const id = (req.params as { id: string }).id
    const body = req.body as { text?: unknown; images?: unknown } | null
    const images = cleanUserImages(body?.images)
    if (!Array.isArray(images)) return reply.code(400).send({ error: images.error })
    const rawText = typeof body?.text === 'string' ? body.text.replaceAll('\0', '') : ''
    // 只发图不写字也算合法消息
    if (!rawText.trim() && !images.length) return reply.code(400).send({ error: 'text 必须是 1–8000 字符' })
    if (rawText.length > 8000) return reply.code(400).send({ error: 'text 必须是 1–8000 字符' })
    const clean = rawText
    // 检查与建 run 放在同一个串行段里，避免同一会话同时建出两个 run
    const res = await serial(async () => {
      const session = await getSession(pool, userId, id)
      if (!session) return { code: 404, error: '会话不存在' } as const
      if (session.agent === 'doubao') return { code: 409, error: '豆包仅支持状态监听，请在豆包客户端中继续对话' } as const
      if (session.agent === 'workbuddy') return { code: 409, error: 'WorkBuddy 仅支持状态监听，请在 WorkBuddy 中继续对话' } as const
      if (!executors.has(execKey(userId, session.machine))) return { code: 409, error: '电脑端不在线' } as const
      if (await activeRun(pool, userId, id)) return { code: 409, error: '这个会话正在运行' } as const
      if (session.agent === 'codex' && session.state === 'running' && !stuckRunning(session)) return { code: 409, error: 'Codex 会话正在 Desktop 里运行' } as const
      const run = await createRun(pool, userId, randomUUID(), id, session.machine)
      const message = await insertMessage(pool, userId, id, run.id, 'user', clean, {}, images.length ? images : null)
      return { code: 200, run, message, session } as const
    })
    if (res.code !== 200) return reply.code(res.code).send({ error: (res as { error: string }).error })
    const { run, message, session } = res as Extract<typeof res, { code: 200 }>
    pushRun(userId, run)
    pushMessage(userId, message)
    const sent = sendExecutor(userId, session.machine, {
      type: 'run.start',
      runId: run.id,
      sessionId: id,
      agent: session.agent,
      sessionKey: id.slice(id.indexOf(':') + 1),
      cwd: session.cwd,
      text: clean,
      ...(images.length ? { images } : {}),
      mode: 'resume',
    })
    if (!sent) {
      const failed = await setRunStatus(pool, userId, run.id, 'failed', '电脑端不在线')
      if (failed) pushRun(userId, failed)
      return reply.code(409).send({ error: '电脑端不在线' })
    }
    return { runId: run.id }
  })

  app.patch('/sessions/:id/messages/:messageId/feedback',async(req,reply)=>{
    const {id,messageId} = req.params as {id:string;messageId:string}
    const n=Number(messageId), rating=(req.body as {rating?:unknown}|null)?.rating
    if(!Number.isSafeInteger(n) || n<=0 || !['up','down',null].includes(rating as never)) return reply.code(400).send({error:'评价参数不正确'})
    return serial(async()=>{
      const message=await getMessage(pool,req.userId,id,n)
      if(!message) return reply.code(404).send({error:'回复不存在，请刷新记录'})
      if(message.role!=='assistant' || !message.sourceId) return reply.code(409).send({error:'请先刷新记录，再评价这条回复'})
      await rateMessage(pool,req.userId,id,message.sourceId,rating as 'up'|'down'|null)
      const updated={...message,rating:rating as 'up'|'down'|null}
      pushMessage(req.userId,updated)
      return {message:updated}
    })
  })

  // 基于已有会话新开：fork = 带上下文分叉，fresh = 同目录从零开始
  app.post('/sessions/:id/spawn', async (req, reply) => {
    const userId = req.userId
    const id = (req.params as { id: string }).id
    const body = req.body as { mode?: unknown; text?: unknown; messageId?:unknown } | null
    const mode = body?.mode
    const messageId=body?.messageId
    if(messageId!==undefined && (mode!=='fork' || typeof messageId!=='number' || !Number.isSafeInteger(messageId) || messageId<=0)) return reply.code(400).send({error:'messageId 必须是分支回复的有效编号'})
    const text = body?.text
    if (mode !== 'fork' && mode !== 'fresh') return reply.code(400).send({ error: "mode 必须是 'fork' 或 'fresh'" })
    if (typeof text !== 'string' || text.trim().length < 1 || text.length > 8000) return reply.code(400).send({ error: 'text 必须是 1–8000 字符' })
    const clean = text.replaceAll('\0', '')
    const res = await serial(async () => {
      const session = await getSession(pool, userId, id)
      if (!session) return { code: 404, error: '会话不存在' } as const
      let point:string|undefined
      if (session.agent === 'doubao') return { code: 409, error: '豆包仅支持状态监听，暂不支持新开或分支会话' } as const
      if (session.agent === 'workbuddy') return { code: 409, error: 'WorkBuddy 仅支持状态监听，暂不支持新开或分支会话' } as const
      if (session.agent === 'zcode' && mode === 'fork') return { code: 409, error: 'ZCode 暂不支持按回复分叉：可以同目录新开，或直接在会话里继续聊' } as const
      if(messageId!==undefined) {
        const message=await getMessage(pool,userId,id,messageId as number)
        if(!message) return {code:404,error:'回复不存在，请刷新记录'} as const
        if(message.role!=='assistant' || !message.branchPoint) return {code:409,error:'该回复尚无可确认的分支节点，请刷新记录或等待回复完成'} as const
        if((session.state==='running' && !stuckRunning(session)) || await activeRun(pool,userId,id)) return {code:409,error:'请等待当前会话运行结束后再分支'} as const
        point=message.branchPoint
        if(executors.get(execKey(userId,session.machine))?.replyBranch!==true) return {code:409,error:'电脑端尚不支持指定回复分支，请更新电脑端'} as const
      }
      if (!executors.has(execKey(userId, session.machine))) return { code: 409, error: '电脑端不在线' } as const
      return { code: 200, result: await startSession(userId,session,clean.replace(/\s+/g,' ').trim().slice(0,80),clean,mode,id.slice(id.indexOf(':')+1),undefined,point) } as const
    })
    if (res.code !== 200) return reply.code(res.code).send({ error: (res as { error: string }).error })
    return (res as Extract<typeof res, {code:200}>).result
  })

  app.post('/runs/:id/stop', async (req, reply) => {
    const run = await getRun(pool, req.userId, (req.params as { id: string }).id)
    if (!run) return reply.code(404).send({ error: 'run 不存在' })
    if (TERMINAL.includes(run.status)) return reply.code(409).send({ error: '这个运行已经结束' })
    if (!sendExecutor(req.userId, run.machine, { type: 'run.stop', runId: run.id })) return reply.code(409).send({ error: '电脑端不在线' })
    return { ok: true }
  })

  // 日历：一段时间内的执行记录（默认最近 7 天）
  app.get('/runs', async (req, reply) => {
    const q = req.query as { from?: string; to?: string }
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 7 * 86_400_000)
    const to = q.to ? new Date(q.to) : new Date()
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return reply.code(400).send({ error: 'from/to 时间格式不合法' })
    return { executions: await listExecutions(pool, req.userId, from, to) }
  })

  app.get('/activity', async (req, reply) => {
    const q = req.query as { from?: string; to?: string }
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 7 * 86_400_000)
    const to = q.to ? new Date(q.to) : new Date()
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return reply.code(400).send({ error: 'from/to 时间格式不合法' })
    return { activity: await listActivity(pool, req.userId, from, to) }
  })

  app.post('/approvals/:id', async (req, reply) => {
    const userId = req.userId
    const id = (req.params as { id: string }).id
    const body = (req.body ?? {}) as { decision?: unknown; answers?: unknown }
    const decision = body.decision
    if (decision !== 'allow' && decision !== 'deny') return reply.code(400).send({ error: "decision 必须是 'allow' 或 'deny'" })
    const cur = await getApproval(pool, userId, id)
    if (!cur) return reply.code(404).send({ error: '授权请求不存在' })
    if (cur.status !== 'pending') return reply.code(409).send({ error: '这个授权请求已经处理过了' })
    const run = await getRun(pool, userId, cur.runId)
    if (!run || !executors.has(execKey(userId, run.machine))) return reply.code(409).send({ error: '电脑端不在线' })
    // Codex 提问：allow 需要带答案 {"问题id": ["选项"]}；deny = 跳过
    let answers: Record<string, string[]> | null = null
    if (cur.tool === 'userInput') {
      if (decision === 'allow') {
        const raw = body.answers
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return reply.code(400).send({ error: 'answers 必须是 {"问题id": ["选项"]} 形式的对象' })
        const entries = Object.entries(raw as Record<string, unknown>).slice(0, 10)
        if (entries.some(([k, v]) => !k || !Array.isArray(v) || v.some(x => typeof x !== 'string'))) {
          return reply.code(400).send({ error: 'answers 必须是 {"问题id": ["选项"]} 形式的对象' })
        }
        answers = Object.fromEntries(entries.map(([k, v]) => [k, (v as unknown[]).map(x => cleanText(String(x), 500)).slice(0, 10)]))
      }
    }
    const done = await decideApproval(pool, userId, id, decision === 'allow' ? 'allowed' : 'denied', 'user')
    if (!done) return reply.code(409).send({ error: '这个授权请求已经处理过了' })
    const qs = done.tool === 'userInput' ? userInputQuestions(done.detail) : null
    const message = await insertMessage(
      pool,
      userId,
      done.sessionId,
      done.runId,
      'approval',
      qs
        ? decision === 'allow' && answers
          ? `已回答：${qs.map(q => {
              const picked = answers[q.id] ?? []
              return `${q.question} → ${picked.length ? picked.join('、') : '（未选择）'}`
            }).join('；').slice(0, 900)}`
          : `已跳过 Codex 提问：${qs.map(q => q.question).join(' / ').slice(0, 300)}`
        : `${decision === 'allow' ? '已允许' : '已拒绝'}：${done.tool} ${done.detail}`,
    )
    await pushApproval(userId, done, false)
    pushMessage(userId, message)
    sendExecutor(userId, run.machine, { type: 'approval.decide', approvalId: id, decision, ...(answers ? { answers } : {}) })
    return { ok: true }
  })

  app.post('/sessions/:id/history', async (req, reply) => {
    const userId = req.userId
    const id = (req.params as { id: string }).id
    const session = await getSession(pool, userId, id)
    if (!session) return reply.code(404).send({ error: '会话不存在' })
    if (session.agent === 'doubao') return reply.code(409).send({ error: '豆包暂不支持读取完整对话记录' })
    // 角色助手的会话不同步原生历史：快照会整段替换消息、重排 id，而草稿按消息 id 挂着，
    // 一同步草稿卡就全变成孤儿；这条会话本来也只在助手面板里看，我们的记录就是全文。
    if (await isAssistantSession(pool, userId, id)) return { messages: await listMessages(pool, userId, id, 100) }
    if (!executors.has(execKey(userId, session.machine))) return reply.code(409).send({ error: '电脑端不在线' })
    const requestId = randomUUID()
    const waiting = new Promise<HistoryResult | null>(resolve => {
      const timer = setTimeout(() => {
        historyWaits.delete(requestId)
        resolve(null)
      }, historyTimeoutMs)
      historyWaits.set(requestId, {
        userId,
        machine: session.machine,
        resolve: r => {
          clearTimeout(timer)
          resolve(r)
        },
      })
    })
    sendExecutor(userId, session.machine, {
      type: 'history.request',
      requestId,
      agent: session.agent,
      sessionKey: id.slice(id.indexOf(':') + 1),
      cwd: session.cwd,
    })
    const result = await waiting
    if (!result) return reply.code(504).send({ error: '电脑端没有及时返回历史记录' })
    if (result.error) return reply.code(502).send({ error: result.error })
    const items = result.messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
      .map(m => ({
        role: m.role,
        text: m.text,
        sourceId: nativeKey(m.sourceId) ?? undefined,
        branchPoint: nativeKey(m.branchPoint) ?? undefined,
        // 原生日志的真实时间；老电脑端不发这个字段，服务端会退回复用库里已有时间
        at: typeof m.at === 'string' && !Number.isNaN(Date.parse(m.at)) ? m.at : undefined,
      }))
    const messages = await serial(() => replaceHistory(pool, userId, id, items))
    return { messages }
  })

  // ---------- WebSocket：viewer 和执行器（role=agent） ----------

  async function onExecutorMessage(userId: number, machine: string, raw: unknown) {
    if (!raw || typeof raw !== 'object') return
    const m = raw as Record<string, unknown>
    const str = (v: unknown) => (typeof v === 'string' ? v : '')
    switch (m.type) {
      case 'run.status': {
        const status = str(m.status)
        if (!['running', 'done', 'failed', 'stopped'].includes(status)) return
        const run = await getRun(pool, userId, str(m.runId))
        if (!run || run.machine !== machine || TERMINAL.includes(run.status)) return
        const updated = await setRunStatus(pool, userId, run.id, status as Run['status'], str(m.error))
        if (!updated) return
        pushRun(userId, updated)
        if (updated.sessionId && !isPendingId(updated.sessionId) && (status === 'done' || status === 'running')) await syncTask(userId,updated.sessionId,status)
        // 投机执行：run 失败时预收集错误上下文挂到任务上（关联任务或会话所属任务）
        if (status === 'failed') {
          const ids = updated.taskId ? [Number(updated.taskId)]
            : updated.sessionId ? (await tasksForSession(pool,userId,updated.sessionId)).map(t => t.id) : []
          for (const id of ids) {
            const digest = await buildFailureDigest(pool,userId,id,{ id:updated.id, sessionId:updated.sessionId, error:updated.error })
            if (digest) broadcast(userId,{type:'task.digest',taskId:id,kind:'failure',digest})
          }
        }
        if (updated.sessionId && (status === 'failed' || status === 'stopped')) await abortPending(userId, updated.sessionId, str(m.error) || (status === 'stopped' ? '已停止' : '启动失败'))
        if (TERMINAL.includes(status)) {
          liveActivity.delete(run.id)
          for (const a of await expireApprovalsOfRuns(pool, userId, [run.id])) await pushApproval(userId, a, false)
        }
        return
      }
      case 'run.session': {
        const key = str(m.sessionKey)
        if (!SESSION_KEY_RE.test(key)) return
        const run = await getRun(pool, userId, str(m.runId))
        if (!run || run.machine !== machine || !run.sessionId || !isPendingId(run.sessionId)) return
        const from = run.sessionId
        const to = `${from.slice(0, from.indexOf(':'))}:${key}`
        const session = await renamePendingSession(pool, userId, from, to)
        if (!session) return
        broadcast(userId, { type: 'removed', id: from })
        pushSession(userId, session, false)
        broadcast(userId, { type: 'session.renamed', from, to })
        const latest = await getRun(pool, userId, run.id)
        if (latest) pushRun(userId, latest)
        for (const task of await tasksForSession(pool,userId,to)) pushTask(userId,task)
        await syncTask(userId,to,latest?.status === 'done' ? 'done' : session.state)
        return
      }
      case 'run.message': {
        const role = str(m.role)
        if (!MESSAGE_ROLES.includes(role as never) || role === 'user' || role === 'approval') return
        const run = await getRun(pool, userId, str(m.runId))
        if (!run || run.machine !== machine || !run.sessionId) return
        // Codex 生成/展示的图片：执行器已转成 data URL；最多 4 张、单张 ≤ 9MB
        const rawImages = Array.isArray(m.images) ? m.images : []
        const images = rawImages
          .filter((u): u is string => typeof u === 'string' && u.startsWith('data:image/') && u.length <= 9_000_000)
          .slice(0, 4)
        const saved = await insertMessage(pool, userId, run.sessionId, run.id, role as Message['role'], str(m.text), {sourceId:nativeKey(m.sourceId) ?? undefined,branchPoint:role==='assistant' ? nativeKey(m.branchPoint) ?? undefined : undefined}, images.length ? images : null)
        pushMessage(userId, saved)
        // 角色助手：这条回复如果是 agent 交的 JSON 草稿，就地解析入库，界面轮询即可看到卡片
        if (role === 'assistant') {
          const draft = await recordReply(pool, userId, run.id, saved.id, saved.text).catch(() => null)
          if (draft) broadcast(userId, { type: 'assistant.draft', draft })
          // 处理意见细化：这条回复属于某条待细化的意见就就地更新（明确 skip 的意见会被关掉）
          const refined = await recordRefine(pool, userId, run.id, saved.text).catch(() => null)
          if (refined) {
            broadcast(userId, { type: 'proposal', proposal: refined.proposal })
            if (refined.action === 'skipped') broadcast(userId, { type: 'proposal.skipped', proposal: refined.proposal })
          }
        }
        return
      }
      case 'run.activity': {
        const run = await getRun(pool, userId, str(m.runId))
        if (!run || run.machine !== machine || !run.sessionId) return
        const kind = str(m.kind)
        if (!['thinking', 'tool', 'text', 'idle'].includes(kind)) return
        const at = new Date().toISOString()
        const text = kind === 'idle' ? '' : cleanText(str(m.text), 300)
        // 只是「现在在做什么」，不落库：run 结束后就不再需要了
        if (kind === 'idle') liveActivity.delete(run.id)
        else liveActivity.set(run.id, { runId: run.id, sessionId: run.sessionId, kind: kind as LiveActivity['kind'], text, at })
        // 顺手清掉十分钟前的旧条目，避免长跑实例里无限增长
        const cutoff = Date.now() - 10 * 60_000
        for (const [id, a] of liveActivity) if (Date.parse(a.at) < cutoff) liveActivity.delete(id)
        broadcast(userId, { type: 'activity', activity: { runId: run.id, sessionId: run.sessionId, kind, text, at } })
        return
      }
      case 'run.usage': {
        const run = await getRun(pool, userId, str(m.runId))
        if (!run || run.machine !== machine) return
        const usage = cleanUsage(m.usage)
        if (!usage) return
        const updated = await setRunUsage(pool, userId, run.id, usage)
        if (updated) pushRun(userId, updated)
        return
      }
      case 'run.approval': {
        const run = await getRun(pool, userId, str(m.runId))
        if (!run || run.machine !== machine || !run.sessionId || TERMINAL.includes(run.status)) return
        const tool = cleanText(str(m.tool), 100) || 'tool'
        const approval = await createApproval(pool, userId, randomUUID(), run.id, run.sessionId, tool, str(m.detail))
        // Codex 提问（request_user_input）：detail 是 questions 的 JSON，消息里给人看问题文本
        const message = await insertMessage(pool, userId, run.sessionId, run.id, 'approval', approvalHeading(approval.tool, approval.detail))
        pushMessage(userId, message)
        // 先告诉执行器这个审批拿到了 id，再发裁决；顺序反了执行器只能走迟到分支
        sendExecutor(userId, machine, { type: 'approval.created', localId: m.localId, approvalId: approval.id })
        // 项目经理先看：能自己放行就直接让 agent 继续，判不了才弹给人
        await refereeHandle(userId, approval, machine)
        return
      }
      case 'run.approvalExpired': {
        const run = await getRun(pool, userId, str(m.runId))
        if (!run || run.machine !== machine) return
        const expired = await expireApproval(pool, userId, str(m.approvalId), run.id)
        if (expired) await pushApproval(userId, expired, false)
        return
      }
      case 'history.result': {
        const w = historyWaits.get(str(m.requestId))
        if (!w || w.userId !== userId || w.machine !== machine) return
        historyWaits.delete(str(m.requestId))
        const list = Array.isArray(m.messages) ? (m.messages as ({ role: string; text: string } & MessageMeta)[]) : []
        w.resolve({ messages: list, error: typeof m.error === 'string' && m.error ? m.error : undefined })
        return
      }
    }
  }

  app.get('/ws', { websocket: true }, async (socket: Sock, req: FastifyRequest) => {
    const { userId, authSessionId } = req
    const q = new URL(req.url, 'http://x').searchParams
    if (q.get('role') === 'agent') {
      const machine = (q.get('machine') ?? '').trim()
      if (!machine) {
        socket.close(4400, '缺少 machine')
        return
      }
      const key = execKey(userId, machine)
      // capabilities 是逗号分隔的能力清单：reply-branch-v1（指定回复分支）、role-v1（认模型与上下文）
      const caps = new Set((q.get('capabilities') ?? '').split(',').map(s => s.trim()).filter(Boolean))
      const me: Exec = { sock: socket, userId, authSessionId, machine, replyBranch: caps.has('reply-branch-v1'), roleV1: caps.has('role-v1') }
      let registered = false
      const queue: unknown[] = []
      const handle = (data: unknown) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(String(data))
        } catch {
          return
        }
        void serial(() => onExecutorMessage(userId, machine, parsed)).catch(e => app.log.error(e, '处理执行器消息失败'))
      }
      // 注册完成之前到的消息先攒着，注册后按顺序处理
      socket.on('message', (data: unknown) => (registered ? handle(data) : queue.push(data)))
      socket.on('close', () => {
        if (!registered || executors.get(key)?.sock !== socket) return
        executors.delete(key)
        pushAgents(userId)
        void serial(() => dropExecutor(userId, machine)).catch(e => app.log.error(e, '处理执行器断线失败'))
      })
      socket.on('error', () => {})
      // 同一账号同一 machine 的新连接顶掉旧的；旧连接名下的 run 也一并作废
      const old = executors.get(key)
      if (old) {
        executors.delete(key)
        try {
          old.sock.close(4000, '被新连接顶掉')
        } catch {}
      }
      await serial(() => dropExecutor(userId, machine))
      if (socket.readyState !== 1) return
      executors.set(key, me)
      registered = true
      pushAgents(userId)
      void serial(() => drainQueue(userId, machine)).catch(e => app.log.error(e, '投递排队派发失败'))
      for (const d of queue.splice(0)) handle(d)
      return
    }

    const me: Conn = { sock: socket, userId, authSessionId }
    // 前端心跳：应用层 ping/pong。协议层 ping 浏览器/WebView 里看不到，
    // 没法用来判断"假连接"（手机切网后 socket 看着还开着，其实早就收不到消息了）
    socket.on('message', (data: unknown) => {
      try {
        if ((JSON.parse(String(data)) as { type?: string } | null)?.type !== 'ping') return
        if (socket.readyState === 1) socket.send('{"type":"pong"}')
      } catch {
        /* 非法消息忽略 */
      }
    })
    socket.on('close', () => clients.delete(me))
    socket.on('error', () => clients.delete(me))
    await serial(async () => {
    if (socket.readyState !== 1) return
    await checkReminders(userId)
    socket.send(
      JSON.stringify({
        type: 'snapshot',
        sessions: await listSessions(pool, userId, false),
        agents: agentList(userId),
        approvals: await Promise.all((await pendingApprovals(pool, userId)).map(a => withProject(userId, a))),
        goals: await listGoals(pool,userId),
        tasks: await listTasks(pool,userId),
        reminders: await Promise.all((await listReminders(pool,userId)).map(async r =>
          ({ ...r, notify: await evaluateNotify(pool,userId,{ kind:'reminder', entityType:r.entityType, entityId:r.entityId }) }))),
      }),
    )
    clients.add(me)
    })
  })

  const ping = setInterval(() => {
    for (const c of [...clients, ...executors.values()]) {
      try {
        c.sock.ping()
      } catch {
        clients.delete(c)
      }
    }
  }, 30_000)
  ping.unref()
  const reminderTimer = setInterval(() => {
    void serial(() => checkReminders()).catch(e => app.log.error(e,'检查时间提醒失败'))
  }, opts.reminderIntervalMs ?? 15_000)
  reminderTimer.unref()
  // Watchdog：独立检测回路，只提醒不干预（执行在 Claude/Codex 手里）
  const watchdogTimer = setInterval(() => {
    // 独立回路：不进事件 serial 链（检查只读 + 幂等领取，不与事件处理争抢顺序）
    void (async () => {
      for (const row of await stalledSessions(pool, stallAfterMs)) {
        if (!(await claimStalled(pool, row.userId, row.sessionId, row.eventKey))) continue
        const s = await getSession(pool, row.userId, row.sessionId)
        if (s) broadcast(row.userId, { type:'watchdog', issue:'stall', session:s })
      }
      await cleanupWatchdog(pool)
    })().catch(e => app.log.error(e, 'Watchdog 检查失败'))
  }, opts.watchdogIntervalMs ?? 60_000)
  watchdogTimer.unref()
  // 排队项过期清扫：电脑一直不上线时，不能让一周后的一次上线喷出几十个会话
  const queueTimer = setInterval(() => {
    void (async () => {
      for (const d of await expireQueued(pool, queueTtlMs)) {
        const task = await getTask(pool, d.userId, d.taskId).catch(() => undefined)
        if (task) pushTask(d.userId, task)
      }
    })().catch(e => app.log.error(e, '清理过期排队派发失败'))
  }, opts.queueSweepIntervalMs ?? 60_000)
  queueTimer.unref()
  // 项目经理：定期看有没有「人已确认、还没派出去」的任务。挑活与限额在 dispatch-manager 里，
  // 这里只把派发动作注入进去（和手动「开始」走同一个 startTaskDispatch）。
  // 跑在 serial 链里：避免和手动派发、事件处理同时抢同一个任务。
  const dispatchTimer = setInterval(() => {
    void serial(() => runDispatchTick({
      pool,
      dispatch: (userId, taskId, fallbackRoleId) => startTaskDispatch(userId, taskId, {}, fallbackRoleId),
    })).then(r => {
      if (r.dispatched || r.failed) app.log.info(r, '项目经理自动派发')
    }).catch(e => app.log.error(e, '自动派发失败'))
  }, opts.dispatchIntervalMs ?? 60_000)
  dispatchTimer.unref()
  app.addHook('onClose', async () => {
    clearInterval(ping)
    clearInterval(reminderTimer)
    clearInterval(watchdogTimer)
    clearInterval(queueTimer)
    clearInterval(dispatchTimer)
    for (const c of clients) c.sock.close()
    for (const c of executors.values()) c.sock.close()
  })
  return kick
}
