import type { FastifyInstance, FastifyRequest } from 'fastify'
import type pg from 'pg'
import { AGENTS, STATES, ackAll, ackSession, applyEvent, listSessions, removeSession, type EventIn, type Session } from './db.ts'

type Sock = { send(data: string): void; ping(): void; close(): void; on(ev: string, fn: () => void): void; readyState: number }

function bearer(req: FastifyRequest) {
  const h = req.headers.authorization ?? ''
  return h.startsWith('Bearer ') ? h.slice(7) : ''
}

function parseEvent(raw: unknown): EventIn | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  if (!AGENTS.includes(e.agent as never) || !STATES.includes(e.state as never)) return null
  if (typeof e.sessionId !== 'string' || !e.sessionId || typeof e.at !== 'string' || Number.isNaN(Date.parse(e.at))) return null
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  return {
    agent: e.agent as EventIn['agent'],
    sessionId: e.sessionId,
    machine: str(e.machine) || 'unknown',
    cwd: str(e.cwd),
    state: e.state as EventIn['state'],
    at: e.at,
    title: typeof e.title === 'string' ? e.title.slice(0, 200) : undefined,
    summary: typeof e.summary === 'string' ? e.summary : undefined,
    pid: typeof e.pid === 'number' && Number.isInteger(e.pid) && e.pid > 0 ? e.pid : null,
    quiet: e.quiet === true,
  }
}

export function registerRoutes(app: FastifyInstance, pool: pg.Pool, token: string) {
  const clients = new Set<Sock>()
  const broadcast = (msg: unknown) => {
    const text = JSON.stringify(msg)
    for (const c of clients) if (c.readyState === 1) c.send(text)
  }
  const pushSession = (session: Session, notify: boolean) => broadcast({ type: 'session', session, notify })

  // 事件按到达顺序串行处理，避免同一会话并发读写
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn)
    chain = p.catch(() => {})
    return p
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

  app.get('/ws', { websocket: true }, async (socket: Sock) => {
    clients.add(socket)
    socket.on('close', () => clients.delete(socket))
    socket.on('error', () => clients.delete(socket))
    socket.send(JSON.stringify({ type: 'snapshot', sessions: await listSessions(pool, false) }))
  })

  const ping = setInterval(() => {
    for (const c of clients) {
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
  })
}
