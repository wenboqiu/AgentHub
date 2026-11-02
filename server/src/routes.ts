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
  applyEvent,
  cleanText,
  createApproval,
  createPendingSession,
  createRun,
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
  listMessages,
  listSessions,
  pendingApprovals,
  removeSession,
  renamePendingSession,
  setRunStatus,
  type Approval,
  type EventIn,
  type Message,
  type Run,
  type Session,
} from './db.ts'
import { authenticate, type Kick } from './auth.ts'
import { ackReminder, collectReminders, listReminders } from './reminders.ts'
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
}

type HistoryResult = { messages: ({ role: string; text: string } & MessageMeta)[]; error?: string }

function bearer(req: FastifyRequest) {
  const h = req.headers.authorization ?? ''
  return h.startsWith('Bearer ') ? h.slice(7) : ''
}

// 一个 WS 连接：属于哪个账号、哪个设备会话（踢设备时按它们关闭）
type Conn = { sock: Sock; userId: number; authSessionId: number }
type Exec = Conn & { machine: string; replyBranch: boolean }
const INVALID_LOGIN = 4401

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

// 返回 kick：删除设备会话 / 账号后，用它立刻关闭对应的 WS（viewer 和执行器）
export function registerRoutes(app: FastifyInstance, pool: pg.Pool, opts: RouteOptions = {}): Kick {
  const historyTimeoutMs = opts.historyTimeoutMs ?? 10_000
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
  const checkReminders = async (user?: number) => {
    for (const r of await collectReminders(pool,user)) broadcast(r.userId, {type:'reminder',reminder:r.reminder})
  }
  const syncTask = async (userId: number, sessionId: string, state: Session['state']) => {
    for (const t of await syncTaskForSession(pool,userId,sessionId,state)) pushTask(userId,t)
  }
  // 新开任务和基于已有会话新开共用同一条创建、广播、发送和失败处理路径。
  async function startSession(userId: number, base: Pick<Session,'agent'|'machine'|'cwd'>, title: string, text: string, mode: 'fork'|'fresh', sessionKey: string, taskId?: number, branchPoint?: string) {
    const runId = randomUUID(), pendingId = `${base.agent}${PENDING}${runId}`
    const db = await pool.connect()
    let pending: Session, run: Run, message: Message, task: Task | undefined
    try {
      await db.query('BEGIN')
      pending = await createPendingSession(db,userId,pendingId,base,title)
      run = await createRun(db,userId,runId,pendingId,base.machine)
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
      throw new TaskError('电脑端不在线',409)
    }
    return {runId,sessionId:pendingId,...(task ? {task} : {})}
  }

  // 执行器掉线（或被新连接顶掉）：它名下的 run 标 failed，pending 授权标 expired
  async function dropExecutor(userId: number, machine: string) {
    const runs = await failActiveRuns(pool, userId, machine, '电脑端断开')
    for (const r of runs) {
      pushRun(userId, r)
      await abortPending(userId, r.sessionId, r.error)
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

  // 拿到真实 id 之前 run 就结束了：临时会话标 aborted 并提醒
  async function abortPending(userId: number, sessionId: string, error: string) {
    if (!isPendingId(sessionId)) return
    const s = await abortPendingSession(pool, userId, sessionId, error || '启动失败')
    if (s) pushSession(userId, s, true)
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
        if (r) { pushSession(req.userId,r.session,r.notify); await syncTask(req.userId,r.session.id,r.session.state) }
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
    const task = await saveTask(pool,req.userId,req.body)
    pushTask(req.userId,task); return {task}
  }))
  app.patch('/tasks/:id', async req => serial(async () => {
    const task = await saveTask(pool,req.userId,req.body,entityId((req.params as {id:string}).id))
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
  app.delete('/tasks/:id/sessions/:sessionId', async req => serial(async () => {
    const p = req.params as {id:string;sessionId:string}
    const task = await linkSession(pool,req.userId,entityId(p.id),p.sessionId,true)
    pushTask(req.userId,task); return {task}
  }))
  app.post('/tasks/:id/start', async req => serial(async () => {
    const task = await getTask(pool,req.userId,entityId((req.params as {id:string}).id)), b = object(req.body ?? {})
    const agent = b.agent ?? task.agent
    if (agent !== 'claude' && agent !== 'codex') throw new TaskError('请选择 Claude 或 Codex')
    const cwd = taskText(b.cwd ?? task.cwd ?? '', '项目目录',4000)
    const online = agentList(req.userId)
    const machine = taskText(b.machine ?? task.machine ?? (online.length === 1 ? online[0] : ''),'电脑名',4000)
    const text = taskText(b.text ?? (task.notes || task.title),'第一条消息',8000)
    if (!executors.has(execKey(req.userId,machine))) throw new TaskError('电脑端不在线',409)
    return startSession(req.userId,{agent,machine,cwd},task.title,text,'fresh','',task.id)
  }))

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

  app.post('/sessions/:id/messages', async (req, reply) => {
    const userId = req.userId
    const id = (req.params as { id: string }).id
    const text = (req.body as { text?: unknown } | null)?.text
    if (typeof text !== 'string' || text.trim().length < 1 || text.length > 8000) return reply.code(400).send({ error: 'text 必须是 1–8000 字符' })
    const clean = text.replaceAll('\0', '')
    // 检查与建 run 放在同一个串行段里，避免同一会话同时建出两个 run
    const res = await serial(async () => {
      const session = await getSession(pool, userId, id)
      if (!session) return { code: 404, error: '会话不存在' } as const
      if (session.agent === 'doubao') return { code: 409, error: '豆包仅支持状态监听，请在豆包客户端中继续对话' } as const
      if (!executors.has(execKey(userId, session.machine))) return { code: 409, error: '电脑端不在线' } as const
      if (await activeRun(pool, userId, id)) return { code: 409, error: '这个会话正在运行' } as const
      if (session.agent === 'codex' && session.state === 'running') return { code: 409, error: 'Codex 会话正在 Desktop 里运行' } as const
      const run = await createRun(pool, userId, randomUUID(), id, session.machine)
      const message = await insertMessage(pool, userId, id, run.id, 'user', clean)
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
      if(messageId!==undefined) {
        const message=await getMessage(pool,userId,id,messageId as number)
        if(!message) return {code:404,error:'回复不存在，请刷新记录'} as const
        if(message.role!=='assistant' || !message.branchPoint) return {code:409,error:'该回复尚无可确认的分支节点，请刷新记录或等待回复完成'} as const
        if(session.state==='running' || await activeRun(pool,userId,id)) return {code:409,error:'请等待当前会话运行结束后再分支'} as const
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

  app.post('/approvals/:id', async (req, reply) => {
    const userId = req.userId
    const id = (req.params as { id: string }).id
    const decision = (req.body as { decision?: unknown } | null)?.decision
    if (decision !== 'allow' && decision !== 'deny') return reply.code(400).send({ error: "decision 必须是 'allow' 或 'deny'" })
    const cur = await getApproval(pool, userId, id)
    if (!cur) return reply.code(404).send({ error: '授权请求不存在' })
    if (cur.status !== 'pending') return reply.code(409).send({ error: '这个授权请求已经处理过了' })
    const run = await getRun(pool, userId, cur.runId)
    if (!run || !executors.has(execKey(userId, run.machine))) return reply.code(409).send({ error: '电脑端不在线' })
    const done = await decideApproval(pool, userId, id, decision === 'allow' ? 'allowed' : 'denied')
    if (!done) return reply.code(409).send({ error: '这个授权请求已经处理过了' })
    const message = await insertMessage(pool, userId, done.sessionId, done.runId, 'approval', `${decision === 'allow' ? '已允许' : '已拒绝'}：${done.tool} ${done.detail}`)
    await pushApproval(userId, done, false)
    pushMessage(userId, message)
    sendExecutor(userId, run.machine, { type: 'approval.decide', approvalId: id, decision })
    return { ok: true }
  })

  app.post('/sessions/:id/history', async (req, reply) => {
    const userId = req.userId
    const id = (req.params as { id: string }).id
    const session = await getSession(pool, userId, id)
    if (!session) return reply.code(404).send({ error: '会话不存在' })
    if (session.agent === 'doubao') return reply.code(409).send({ error: '豆包暂不支持读取完整对话记录' })
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
      .map(m => ({ role: m.role, text: m.text, sourceId:nativeKey(m.sourceId) ?? undefined, branchPoint:nativeKey(m.branchPoint) ?? undefined }))
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
        if (!isPendingId(updated.sessionId) && (status === 'done' || status === 'running')) await syncTask(userId,updated.sessionId,status)
        if (status === 'failed' || status === 'stopped') await abortPending(userId, updated.sessionId, str(m.error) || (status === 'stopped' ? '已停止' : '启动失败'))
        if (TERMINAL.includes(status)) {
          for (const a of await expireApprovalsOfRuns(pool, userId, [run.id])) await pushApproval(userId, a, false)
        }
        return
      }
      case 'run.session': {
        const key = str(m.sessionKey)
        if (!SESSION_KEY_RE.test(key)) return
        const run = await getRun(pool, userId, str(m.runId))
        if (!run || run.machine !== machine || !isPendingId(run.sessionId)) return
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
        if (!run || run.machine !== machine) return
        pushMessage(userId, await insertMessage(pool, userId, run.sessionId, run.id, role as Message['role'], str(m.text), {sourceId:nativeKey(m.sourceId) ?? undefined,branchPoint:role==='assistant' ? nativeKey(m.branchPoint) ?? undefined : undefined}))
        return
      }
      case 'run.approval': {
        const run = await getRun(pool, userId, str(m.runId))
        if (!run || run.machine !== machine || TERMINAL.includes(run.status)) return
        const tool = cleanText(str(m.tool), 100) || 'tool'
        const approval = await createApproval(pool, userId, randomUUID(), run.id, run.sessionId, tool, str(m.detail))
        const message = await insertMessage(pool, userId, run.sessionId, run.id, 'approval', `请求授权：${approval.tool} ${approval.detail}`)
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
      for (const d of queue.splice(0)) handle(d)
      return
    }

    const me: Conn = { sock: socket, userId, authSessionId }
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
        reminders: await listReminders(pool,userId),
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
  app.addHook('onClose', async () => {
    clearInterval(ping)
    clearInterval(reminderTimer)
    for (const c of clients) c.sock.close()
    for (const c of executors.values()) c.sock.close()
  })
  return kick
}
