import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type pg from 'pg'
import {
  AGENTS,
  MESSAGE_ROLES,
  STATES,
  ackAll,
  ackSession,
  activeRun,
  applyEvent,
  cleanText,
  createApproval,
  createRun,
  decideApproval,
  expireApproval,
  expireApprovalsOfRuns,
  failActiveRuns,
  getApproval,
  getRun,
  getSession,
  insertHistory,
  insertMessage,
  latestRun,
  listMessages,
  listSessions,
  pendingApprovals,
  removeSession,
  setRunStatus,
  type Approval,
  type EventIn,
  type Message,
  type Run,
  type Session,
} from './db.ts'

type Sock = {
  send(data: string): void
  ping(): void
  close(code?: number, reason?: string): void
  on(ev: string, fn: (...args: any[]) => void): void
  readyState: number
}

export type RouteOptions = {
  token: string
  controlToken?: string
  // 等执行器返回历史记录的最长时间（毫秒），测试里调短
  historyTimeoutMs?: number
}

type HistoryResult = { messages: { role: string; text: string }[]; error?: string }

function bearer(req: FastifyRequest) {
  const h = req.headers.authorization ?? ''
  return h.startsWith('Bearer ') ? h.slice(7) : ''
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function parseEvent(raw: unknown): EventIn | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  if (!AGENTS.includes(e.agent as never) || !STATES.includes(e.state as never)) return null
  if (typeof e.sessionId !== 'string' || !e.sessionId || typeof e.at !== 'string' || Number.isNaN(Date.parse(e.at))) return null
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
  }
}

const TERMINAL = ['done', 'failed', 'stopped']

export function registerRoutes(app: FastifyInstance, pool: pg.Pool, opts: RouteOptions) {
  const token = opts.token
  const controlToken = opts.controlToken ?? ''
  const historyTimeoutMs = opts.historyTimeoutMs ?? 10_000
  const clients = new Set<Sock>()
  // machine -> 在线执行器连接
  const executors = new Map<string, Sock>()
  // 等待执行器返回的历史请求
  const historyWaits = new Map<string, { machine: string; resolve: (r: HistoryResult) => void }>()

  const broadcast = (msg: unknown) => {
    const text = JSON.stringify(msg)
    for (const c of clients) if (c.readyState === 1) c.send(text)
  }
  const pushSession = (session: Session, notify: boolean) => broadcast({ type: 'session', session, notify })
  const agentList = () => [...executors.keys()].sort()
  const pushAgents = () => broadcast({ type: 'agents', agents: agentList() })
  const sendExecutor = (machine: string, msg: unknown) => {
    const s = executors.get(machine)
    if (!s || s.readyState !== 1) return false
    s.send(JSON.stringify(msg))
    return true
  }

  // approval 广播里带上 project，Android 通知用
  const withProject = async (a: Approval) => ({ ...a, project: (await getSession(pool, a.sessionId))?.project ?? '' })
  const pushApproval = async (a: Approval, notify: boolean) => broadcast({ type: 'approval', approval: await withProject(a), notify })
  const pushMessage = (message: Message) => broadcast({ type: 'message', message })
  const pushRun = (run: Run) => broadcast({ type: 'run', run })

  // 事件按到达顺序串行处理，避免同一会话并发读写
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn)
    chain = p.catch(() => {})
    return p
  }

  // 执行器掉线（或被新连接顶掉）：它名下的 run 标 failed，pending 授权标 expired
  async function dropExecutor(machine: string) {
    const runs = await failActiveRuns(pool, machine, '电脑端断开')
    for (const r of runs) pushRun(r)
    const expired = await expireApprovalsOfRuns(
      pool,
      runs.map(r => r.id),
    )
    for (const a of expired) await pushApproval(a, false)
    for (const [id, w] of historyWaits) {
      if (w.machine === machine) {
        historyWaits.delete(id)
        w.resolve({ messages: [], error: '电脑端断开' })
      }
    }
  }

  function control(req: FastifyRequest, reply: FastifyReply): boolean {
    if (!controlToken) {
      reply.code(403).send({ error: '服务端没有开启远程控制' })
      return false
    }
    const given = req.headers['x-control-token']
    if (typeof given !== 'string' || !safeEqual(given, controlToken)) {
      reply.code(403).send({ error: '控制密钥不对' })
      return false
    }
    return true
  }

  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS') return
    if (req.url === '/health' || req.url.startsWith('/health?')) return
    if (req.url.startsWith('/ws')) {
      const t = new URL(req.url, 'http://x').searchParams.get('token')
      if (t !== token) return reply.code(401).send({ error: 'unauthorized' })
      return
    }
    if (bearer(req) !== token) return reply.code(401).send({ error: 'unauthorized' })
  })

  app.get('/health', async () => ({ ok: true }))

  app.post('/events', async (req, reply) => {
    const body = req.body as { events?: unknown }
    if (!body || !Array.isArray(body.events) || body.events.length > 100) return reply.code(400).send({ error: 'events 必须是不超过 100 条的数组' })
    const events = body.events.map(parseEvent)
    if (events.some(e => !e)) return reply.code(400).send({ error: '事件格式不对' })
    let accepted = 0
    for (const ev of events as EventIn[]) {
      const res = await serial(() => applyEvent(pool, ev))
      if (!res) continue
      accepted++
      pushSession(res.session, res.notify)
    }
    return { accepted }
  })

  app.get('/sessions', async req => {
    const q = req.query as { all?: string }
    return { sessions: await listSessions(pool, q.all === '1') }
  })

  app.post('/sessions/ack-all', async () => {
    const list = await ackAll(pool)
    for (const s of list) pushSession(s, false)
    return { acked: list.length }
  })

  app.post('/sessions/:id/ack', async (req, reply) => {
    const s = await ackSession(pool, (req.params as { id: string }).id)
    if (!s) return reply.code(404).send({ error: '会话不存在' })
    pushSession(s, false)
    return { ok: true }
  })

  app.delete('/sessions/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id
    if (!(await removeSession(pool, id))) return reply.code(404).send({ error: '会话不存在' })
    broadcast({ type: 'removed', id })
    return { ok: true }
  })

  // ---------- 远程控制 ----------

  app.get('/control/status', async () => ({ enabled: controlToken !== '', agents: agentList() }))

  app.get('/sessions/:id/messages', async req => {
    const id = (req.params as { id: string }).id
    const q = req.query as { limit?: string }
    const limit = Math.min(Math.max(Number.parseInt(q.limit ?? '100', 10) || 100, 1), 200)
    const [messages, approvals, run] = await Promise.all([listMessages(pool, id, limit), pendingApprovals(pool, id), latestRun(pool, id)])
    return { messages, approvals, run }
  })

  app.post('/sessions/:id/messages', async (req, reply) => {
    if (!control(req, reply)) return reply
    const id = (req.params as { id: string }).id
    const text = (req.body as { text?: unknown } | null)?.text
    if (typeof text !== 'string' || text.trim().length < 1 || text.length > 8000) return reply.code(400).send({ error: 'text 必须是 1–8000 字符' })
    const clean = text.replaceAll('\0', '')
    // 检查与建 run 放在同一个串行段里，避免同一会话同时建出两个 run
    const res = await serial(async () => {
      const session = await getSession(pool, id)
      if (!session) return { code: 404, error: '会话不存在' } as const
      if (!executors.has(session.machine)) return { code: 409, error: '电脑端不在线' } as const
      if (await activeRun(pool, id)) return { code: 409, error: '这个会话正在运行' } as const
      if (session.agent === 'codex' && session.state === 'running') return { code: 409, error: 'Codex 会话正在 Desktop 里运行' } as const
      const run = await createRun(pool, randomUUID(), id, session.machine)
      const message = await insertMessage(pool, id, run.id, 'user', clean)
      return { code: 200, run, message, session } as const
    })
    if (res.code !== 200) return reply.code(res.code).send({ error: (res as { error: string }).error })
    const { run, message, session } = res as Extract<typeof res, { code: 200 }>
    pushRun(run)
    pushMessage(message)
    const sent = sendExecutor(session.machine, {
      type: 'run.start',
      runId: run.id,
      sessionId: id,
      agent: session.agent,
      sessionKey: id.slice(id.indexOf(':') + 1),
      cwd: session.cwd,
      text: clean,
    })
    if (!sent) {
      const failed = await setRunStatus(pool, run.id, 'failed', '电脑端不在线')
      if (failed) pushRun(failed)
      return reply.code(409).send({ error: '电脑端不在线' })
    }
    return { runId: run.id }
  })

  app.post('/runs/:id/stop', async (req, reply) => {
    if (!control(req, reply)) return reply
    const run = await getRun(pool, (req.params as { id: string }).id)
    if (!run) return reply.code(404).send({ error: 'run 不存在' })
    if (TERMINAL.includes(run.status)) return reply.code(409).send({ error: '这个运行已经结束' })
    if (!sendExecutor(run.machine, { type: 'run.stop', runId: run.id })) return reply.code(409).send({ error: '电脑端不在线' })
    return { ok: true }
  })

  app.post('/approvals/:id', async (req, reply) => {
    if (!control(req, reply)) return reply
    const id = (req.params as { id: string }).id
    const decision = (req.body as { decision?: unknown } | null)?.decision
    if (decision !== 'allow' && decision !== 'deny') return reply.code(400).send({ error: "decision 必须是 'allow' 或 'deny'" })
    const cur = await getApproval(pool, id)
    if (!cur) return reply.code(404).send({ error: '授权请求不存在' })
    if (cur.status !== 'pending') return reply.code(409).send({ error: '这个授权请求已经处理过了' })
    const run = await getRun(pool, cur.runId)
    if (!run || !executors.has(run.machine)) return reply.code(409).send({ error: '电脑端不在线' })
    const done = await decideApproval(pool, id, decision === 'allow' ? 'allowed' : 'denied')
    if (!done) return reply.code(409).send({ error: '这个授权请求已经处理过了' })
    const message = await insertMessage(pool, done.sessionId, done.runId, 'approval', `${decision === 'allow' ? '已允许' : '已拒绝'}：${done.tool} ${done.detail}`)
    await pushApproval(done, false)
    pushMessage(message)
    sendExecutor(run.machine, { type: 'approval.decide', approvalId: id, decision })
    return { ok: true }
  })

  app.post('/sessions/:id/history', async (req, reply) => {
    if (!control(req, reply)) return reply
    const id = (req.params as { id: string }).id
    const session = await getSession(pool, id)
    if (!session) return reply.code(404).send({ error: '会话不存在' })
    if (!executors.has(session.machine)) return reply.code(409).send({ error: '电脑端不在线' })
    const requestId = randomUUID()
    const waiting = new Promise<HistoryResult | null>(resolve => {
      const timer = setTimeout(() => {
        historyWaits.delete(requestId)
        resolve(null)
      }, historyTimeoutMs)
      historyWaits.set(requestId, {
        machine: session.machine,
        resolve: r => {
          clearTimeout(timer)
          resolve(r)
        },
      })
    })
    sendExecutor(session.machine, {
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
      .map(m => ({ role: m.role, text: m.text }))
    const messages = await serial(() => insertHistory(pool, id, items))
    return { messages }
  })

  // ---------- WebSocket：viewer 和执行器（role=agent） ----------

  async function onExecutorMessage(machine: string, raw: unknown) {
    if (!raw || typeof raw !== 'object') return
    const m = raw as Record<string, unknown>
    const str = (v: unknown) => (typeof v === 'string' ? v : '')
    switch (m.type) {
      case 'run.status': {
        const status = str(m.status)
        if (!['running', 'done', 'failed', 'stopped'].includes(status)) return
        const run = await getRun(pool, str(m.runId))
        if (!run || run.machine !== machine || TERMINAL.includes(run.status)) return
        const updated = await setRunStatus(pool, run.id, status as Run['status'], str(m.error))
        if (!updated) return
        pushRun(updated)
        if (TERMINAL.includes(status)) {
          for (const a of await expireApprovalsOfRuns(pool, [run.id])) await pushApproval(a, false)
        }
        return
      }
      case 'run.message': {
        const role = str(m.role)
        if (!MESSAGE_ROLES.includes(role as never) || role === 'user' || role === 'approval') return
        const run = await getRun(pool, str(m.runId))
        if (!run || run.machine !== machine) return
        pushMessage(await insertMessage(pool, run.sessionId, run.id, role as Message['role'], str(m.text)))
        return
      }
      case 'run.approval': {
        const run = await getRun(pool, str(m.runId))
        if (!run || run.machine !== machine || TERMINAL.includes(run.status)) return
        const tool = cleanText(str(m.tool), 100) || 'tool'
        const approval = await createApproval(pool, randomUUID(), run.id, run.sessionId, tool, str(m.detail))
        const message = await insertMessage(pool, run.sessionId, run.id, 'approval', `请求授权：${approval.tool} ${approval.detail}`)
        await pushApproval(approval, true)
        pushMessage(message)
        sendExecutor(machine, { type: 'approval.created', localId: m.localId, approvalId: approval.id })
        return
      }
      case 'run.approvalExpired': {
        const run = await getRun(pool, str(m.runId))
        if (!run || run.machine !== machine) return
        const expired = await expireApproval(pool, str(m.approvalId), run.id)
        if (expired) await pushApproval(expired, false)
        return
      }
      case 'history.result': {
        const w = historyWaits.get(str(m.requestId))
        if (!w || w.machine !== machine) return
        historyWaits.delete(str(m.requestId))
        const list = Array.isArray(m.messages) ? (m.messages as { role: string; text: string }[]) : []
        w.resolve({ messages: list, error: typeof m.error === 'string' && m.error ? m.error : undefined })
        return
      }
    }
  }

  app.get('/ws', { websocket: true }, async (socket: Sock, req: FastifyRequest) => {
    const q = new URL(req.url, 'http://x').searchParams
    if (q.get('role') === 'agent') {
      const machine = (q.get('machine') ?? '').trim()
      if (!controlToken || !safeEqual(q.get('control') ?? '', controlToken)) {
        socket.close(4403, '控制密钥不对或服务端没有开启远程控制')
        return
      }
      if (!machine) {
        socket.close(4400, '缺少 machine')
        return
      }
      let registered = false
      const queue: unknown[] = []
      const handle = (data: unknown) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(String(data))
        } catch {
          return
        }
        void serial(() => onExecutorMessage(machine, parsed)).catch(e => app.log.error(e, '处理执行器消息失败'))
      }
      // 注册完成之前到的消息先攒着，注册后按顺序处理
      socket.on('message', (data: unknown) => (registered ? handle(data) : queue.push(data)))
      socket.on('close', () => {
        if (!registered || executors.get(machine) !== socket) return
        executors.delete(machine)
        pushAgents()
        void serial(() => dropExecutor(machine)).catch(e => app.log.error(e, '处理执行器断线失败'))
      })
      socket.on('error', () => {})
      // 同一 machine 的新连接顶掉旧的；旧连接名下的 run 也一并作废
      const old = executors.get(machine)
      if (old) {
        executors.delete(machine)
        try {
          old.close(4000, '被新连接顶掉')
        } catch {}
      }
      await serial(() => dropExecutor(machine))
      if (socket.readyState !== 1) return
      executors.set(machine, socket)
      registered = true
      pushAgents()
      for (const d of queue.splice(0)) handle(d)
      return
    }

    clients.add(socket)
    socket.on('close', () => clients.delete(socket))
    socket.on('error', () => clients.delete(socket))
    socket.send(
      JSON.stringify({
        type: 'snapshot',
        sessions: await listSessions(pool, false),
        agents: agentList(),
        approvals: await Promise.all((await pendingApprovals(pool)).map(withProject)),
      }),
    )
  })

  const ping = setInterval(() => {
    for (const c of [...clients, ...executors.values()]) {
      try {
        c.ping()
      } catch {
        clients.delete(c)
      }
    }
  }, 30_000)
  ping.unref()
  app.addHook('onClose', async () => {
    clearInterval(ping)
    for (const c of clients) c.close()
    for (const c of executors.values()) c.close()
  })
}
