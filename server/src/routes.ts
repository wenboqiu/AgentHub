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
  renamePendingSession,
  setRunStatus,
  stopTaskRun,
  type Approval,
  type EventIn,
  type Message,
  type Run,
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
}

type HistoryResult = { messages: ({ role: string; text: string; at?: string } & MessageMeta)[]; error?: string }

function bearer(req: FastifyRequest) {
  const h = req.headers.authorization ?? ''
  return h.startsWith('Bearer ') ? h.slice(7) : ''
}

// 一个 WS 连接：属于哪个账号、哪个设备会话（踢设备时按它们关闭）
type Conn = { sock: Sock; userId: number; authSessionId: number }
type Exec = Conn & { machine: string; replyBranch: boolean }
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
      }
    }
  }
  // 新开任务和基于已有会话新开共用同一条创建、广播、发送和失败处理路径。
  async function startSession(userId: number, base: Pick<Session,'agent'|'machine'|'cwd'>, title: string, text: string, mode: 'fork'|'fresh', sessionKey: string, taskId?: number, branchPoint?: string) {
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
    if (!sendExecutor(userId,base.machine,{type:'run.start',runId,sessionId:pendingId,agent:base.agent,sessionKey,cwd:base.cwd,text,mode,...(branchPoint ? {branchPoint} : {})})) {
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

  // 电脑上线后把排队的活按入队顺序投递；失败累计次数，超过上限就放弃并记录
  async function drainQueue(userId: number, machine: string) {
    for (const item of await queuedFor(pool, userId, machine, queueDrainLimit)) {
      if (!executors.has(execKey(userId, machine))) return
      let ok = false
      try {
        await startSession(userId, { agent: item.agent as Session['agent'], machine, cwd: item.cwd }, item.title, item.text, 'fresh', '', item.taskId)
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
          const notify = r.notify
            ? await evaluateNotify(pool, req.userId, { kind:'session', agent:r.session.agent, state:r.session.state as 'done'|'aborted'|'waiting', sessionId:r.session.id })
            : false
          pushSession(req.userId,r.session,notify)
          await syncTask(req.userId,r.session.id,r.session.state)
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
    const b = object(req.body ?? {})
    let task = await saveTask(pool,req.userId,req.body)
    // 建任务时选了配置：空着的执行字段由配置补齐，检查项模板并入清单（优先级只在没显式指定时跟随）
    if (task.profileId !== null) {
      const profile = await getProfile(pool, req.userId, task.profileId)
      const patch = await applyProfile(pool, req.userId, task, profile)
      if (!('priority' in b) && profile.priority !== 'medium') patch.priority = profile.priority
      task = await saveTask(pool, req.userId, patch, task.id)
    }
    pushTask(req.userId,task); return {task}
  }))
  app.patch('/tasks/:id', async req => serial(async () => {
    const id = entityId((req.params as {id:string}).id)
    const b = object(req.body ?? {})
    let task = await saveTask(pool,req.userId,req.body,id)
    // 只有这次请求显式改了配置才套用，避免每次编辑任务都重算一遍检查项
    if ('profileId' in b && task.profileId !== null) {
      const profile = await getProfile(pool, req.userId, task.profileId)
      task = await saveTask(pool, req.userId, await applyProfile(pool, req.userId, task, profile), task.id)
    }
    // 标记完成时收尾手动计时的执行记录，日历才能看到真实的结束时间
    if ((req.body as {status?:unknown}|null)?.status === 'done')
      for (const r of await closeTaskRuns(pool,req.userId,id,'done')) pushRun(req.userId,r)
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
  app.post('/tasks/:id/start', async req => serial(async () => {
    const task = await getTask(pool,req.userId,entityId((req.params as {id:string}).id)), b = object(req.body ?? {})
    // 任务关联了配置但字段还空着（比如配置是后改的）：派活时用配置兜底
    const profile = await findProfile(pool, req.userId, task.profileId)
    const agent = b.agent ?? task.agent ?? profile?.agent
    if (agent === 'doubao' || agent === 'workbuddy') throw new TaskError('豆包、WorkBuddy 只做状态监听，请在客户端里执行后把会话关联到任务')
    if (agent !== 'claude' && agent !== 'codex') throw new TaskError('请选择 Claude 或 Codex')
    const cwd = taskText(b.cwd ?? task.cwd ?? profile?.cwd ?? '', '项目目录',4000)
    const online = agentList(req.userId)
    const machine = taskText(b.machine ?? task.machine ?? (online.length === 1 ? online[0] : ''),'电脑名',4000)
    const text = taskText(b.text ?? (task.notes || task.title),'第一条消息',8000)
    // 电脑离线不再直接失败：入队，等那台电脑上线后自动派发（派给谁、发什么都定下来了）
    if (!executors.has(execKey(req.userId,machine))) {
      await enqueueDispatch(pool, req.userId, task.id, { machine, agent, cwd, text })
      const queued = await saveTask(pool, req.userId, { agent, machine, cwd }, task.id)
      pushTask(req.userId, queued)
      return { queued: true, task: queued }
    }
    // 手动派发优先于排队：同一任务曾在队列里就作废掉，避免重复投递
    if (await dequeueDispatch(pool, req.userId, task.id)) pushTask(req.userId, await getTask(pool, req.userId, task.id))
    return startSession(req.userId,{agent,machine,cwd},task.title,text,'fresh','',task.id)
  }))
  app.delete('/tasks/:id/queue', async req => serial(async () => {
    const id = entityId((req.params as {id:string}).id)
    await getTask(pool,req.userId,id)
    await dequeueDispatch(pool,req.userId,id)
    const task = await getTask(pool,req.userId,id)
    pushTask(req.userId,task); return {task}
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
    return { messages, approvals, run }
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
    const done = await decideApproval(pool, userId, id, decision === 'allow' ? 'allowed' : 'denied')
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
    if (session.agent === 'workbuddy') return reply.code(409).send({ error: 'WorkBuddy 暂不支持读取完整对话记录' })
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
        pushMessage(userId, await insertMessage(pool, userId, run.sessionId, run.id, role as Message['role'], str(m.text), {sourceId:nativeKey(m.sourceId) ?? undefined,branchPoint:role==='assistant' ? nativeKey(m.branchPoint) ?? undefined : undefined}, images.length ? images : null))
        return
      }
      case 'run.approval': {
        const run = await getRun(pool, userId, str(m.runId))
        if (!run || run.machine !== machine || !run.sessionId || TERMINAL.includes(run.status)) return
        const tool = cleanText(str(m.tool), 100) || 'tool'
        const approval = await createApproval(pool, userId, randomUUID(), run.id, run.sessionId, tool, str(m.detail))
        // Codex 提问（request_user_input）：detail 是 questions 的 JSON，消息里给人看问题文本
        const message = await insertMessage(pool, userId, run.sessionId, run.id, 'approval', approvalHeading(approval.tool, approval.detail))
        await pushApproval(userId, approval, true)
        pushMessage(userId, message)
        sendExecutor(userId, machine, { type: 'approval.created', localId: m.localId, approvalId: approval.id })
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
      const me: Exec = { sock: socket, userId, authSessionId, machine, replyBranch:q.get('capabilities')==='reply-branch-v1' }
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
  app.addHook('onClose', async () => {
    clearInterval(ping)
    clearInterval(reminderTimer)
    clearInterval(watchdogTimer)
    clearInterval(queueTimer)
    for (const c of clients) c.sock.close()
    for (const c of executors.values()) c.sock.close()
  })
  return kick
}
