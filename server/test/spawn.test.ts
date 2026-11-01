import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/index.ts'
import { createPool } from '../src/db.ts'
import { DATABASE_URL, makeUser } from './helpers.ts'

let TOKEN = ''
const stamp = Date.now()
let n = 0
const uniq = (p: string) => `${p}${stamp}-${n++}`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type Peer = { ws: WebSocket; msgs: any[]; closed: { code: number } | null }

async function waitFor<T>(fn: () => T | undefined | null | false, ms = 4000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error('waitFor 超时')
    await sleep(20)
  }
}

describe('基于已有会话新开', () => {
  const pool = createPool(DATABASE_URL)
  let app: FastifyInstance
  let base = ''
  const peers: Peer[] = []

  async function call(method: string, path: string, body?: unknown, token = TOKEN) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${token}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    return { status: res.status, body: (text.startsWith('{') ? JSON.parse(text) : text) as any }
  }

  async function connect(query: string): Promise<Peer> {
    const ws = new WebSocket(base.replace('http', 'ws') + `/ws?token=${TOKEN}&${query}`)
    const p: Peer = { ws, msgs: [], closed: null }
    ws.onmessage = e => p.msgs.push(JSON.parse(String(e.data)))
    ws.onclose = e => (p.closed = { code: e.code })
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('ws error'))
    })
    peers.push(p)
    return p
  }
  const viewer = async () => {
    const v = await connect('')
    await waitFor(() => v.msgs.find(m => m.type === 'snapshot'))
    return v
  }
  const executor = async (machine: string) => {
    const e = await connect(`role=agent&machine=${machine}`)
    // 等服务端登记完成
    for (let i = 0; i < 100; i++) {
      if ((await call('GET', '/control/status')).body.agents.includes(machine)) return e
      await sleep(20)
    }
    throw new Error('执行器没有登记')
  }
  const find = (p: Peer, type: string, pred: (m: any) => boolean = () => true) => p.msgs.find(m => m.type === type && pred(m))
  const sendJson = (p: Peer, m: unknown) => p.ws.send(JSON.stringify(m))

  async function newSession(machine: string, agent = 'claude', state = 'done') {
    const sessionId = uniq('s')
    const r = await call('POST', '/events', {
      events: [{ agent, sessionId, machine, cwd: 'D:\\Work2\\Demo', state, at: new Date().toISOString() }],
    })
    assert.equal(r.status, 200)
    return { id: `${agent}:${sessionId}`, key: sessionId }
  }

  before(async () => {
    app = await buildApp(DATABASE_URL, 'silent', { historyTimeoutMs: 600 })
    base = await app.listen({ port: 0, host: '127.0.0.1' })
    TOKEN = (await makeUser(pool)).token
  })
  after(async () => {
    for (const p of peers) p.ws.close()
    await app.close()
    await pool.end()
  })

  const enc = encodeURIComponent
  const spawnUrl = (id: string) => `/sessions/${enc(id)}/spawn`

  it('spawn：404 / 409 / 参数校验；隔离', async () => {
    const { id } = await newSession(uniq('offline'))
    assert.equal((await call('POST', spawnUrl('claude:nope'), { mode: 'fork', text: 'hi' })).status, 404)
    const r = await call('POST', spawnUrl(id), { mode: 'fork', text: 'hi' })
    assert.equal(r.status, 409)
    assert.equal(r.body.error, '电脑端不在线')
    assert.equal((await call('POST', spawnUrl(id), { mode: 'other', text: 'hi' })).status, 400)
    assert.equal((await call('POST', spawnUrl(id), { mode: 'fork', text: '  ' })).status, 400)
    assert.equal((await call('POST', spawnUrl(id), { mode: 'fork', text: 'x'.repeat(8001) })).status, 400)
    const other = await makeUser(pool)
    assert.equal((await call('POST', spawnUrl(id), { mode: 'fork', text: 'hi' }, other.token)).status, 404)
  })

  it('spawn 成功：临时会话 / run / 消息 / 广播 / run.start；原会话运行中也能 spawn；messages 带 mode=resume', async () => {
    const machine = uniq('pc')
    const v = await viewer()
    const ex = await executor(machine)
    const { id, key } = await newSession(machine)
    const run1 = (await call('POST', `/sessions/${enc(id)}/messages`, { text: '先跑着' })).body.runId
    const s1 = await waitFor(() => find(ex, 'run.start', m => m.runId === run1))
    assert.equal(s1.mode, 'resume')

    const r = await call('POST', spawnUrl(id), { mode: 'fork', text: '分叉\n第二行' })
    assert.equal(r.status, 200)
    assert.equal(r.body.sessionId, `claude:pending-${r.body.runId}`)
    const start = await waitFor(() => find(ex, 'run.start', m => m.runId === r.body.runId))
    assert.equal(start.mode, 'fork')
    assert.equal(start.sessionKey, key)
    assert.equal(start.sessionId, r.body.sessionId)
    assert.equal(start.agent, 'claude')
    assert.equal(start.cwd, 'D:\\Work2\\Demo')
    assert.equal(start.text, '分叉\n第二行')
    const ps = await waitFor(() => find(v, 'session', m => m.session.id === r.body.sessionId))
    assert.equal(ps.session.state, 'running')
    assert.equal(ps.session.title, '分叉 第二行')
    assert.equal(ps.session.machine, machine)
    assert.equal(ps.session.project, 'Demo')
    await waitFor(() => find(v, 'run', m => m.run.id === r.body.runId))
    await waitFor(() => find(v, 'message', m => m.message.runId === r.body.runId && m.message.role === 'user'))

    const r2 = await call('POST', spawnUrl(id), { mode: 'fresh', text: '新开' })
    assert.equal(r2.status, 200)
    assert.equal((await waitFor(() => find(ex, 'run.start', m => m.runId === r2.body.runId))).mode, 'fresh')
  })

  it('run.session：临时会话改名，runs/messages/approvals 跟着改', async () => {
    const machine = uniq('pc')
    const v = await viewer()
    const ex = await executor(machine)
    const { id } = await newSession(machine)
    const r = await call('POST', spawnUrl(id), { mode: 'fork', text: '只回复 OK' })
    const pid = r.body.sessionId
    await waitFor(() => find(ex, 'run.start', m => m.runId === r.body.runId))
    sendJson(ex, { type: 'run.status', runId: r.body.runId, status: 'running' })
    sendJson(ex, { type: 'run.approval', runId: r.body.runId, localId: 1, tool: 'Write', detail: 'x' })
    await waitFor(() => find(ex, 'approval.created'))
    const newKey = uniq('new')
    sendJson(ex, { type: 'run.session', runId: r.body.runId, sessionKey: newKey })
    const real = `claude:${newKey}`
    const renamed = await waitFor(() => find(v, 'session.renamed', m => m.to === real))
    assert.equal(renamed.from, pid)
    assert.ok(find(v, 'removed', m => m.id === pid))
    assert.equal(find(v, 'session', m => m.session.id === real).notify, false)
    const q = (await call('GET', `/sessions/${enc(real)}/messages`)).body
    assert.equal(q.run.id, r.body.runId)
    assert.equal(q.run.sessionId, real)
    assert.equal(q.messages[0].text, '只回复 OK')
    assert.equal(q.messages[0].sessionId, real)
    assert.equal(q.approvals.length, 1)
    assert.equal(q.approvals[0].sessionId, real)
    assert.equal((await call('GET', `/sessions/${enc(pid)}/messages`)).status, 404)
    // 第二次 run.session 被忽略（已不是临时会话）
    sendJson(ex, { type: 'run.session', runId: r.body.runId, sessionKey: uniq('again') })
    sendJson(ex, { type: 'run.message', runId: r.body.runId, role: 'system', text: 'barrier1' })
    await waitFor(() => find(v, 'message', m => m.message.text === 'barrier1'))
    assert.equal(v.msgs.filter(m => m.type === 'session.renamed' && m.from === pid).length, 1)
  })

  it('run.session：真实 id 已存在时合并', async () => {
    const machine = uniq('pc')
    const v = await viewer()
    const ex = await executor(machine)
    const { id } = await newSession(machine)
    const r = await call('POST', spawnUrl(id), { mode: 'fresh', text: '合并标题' })
    const pid = r.body.sessionId
    await waitFor(() => find(ex, 'run.start', m => m.runId === r.body.runId))
    const newKey = uniq('new')
    const real = `claude:${newKey}`
    // hook 抢先上报（没有标题）
    const ev = await call('POST', '/events', { events: [{ agent: 'claude', sessionId: newKey, machine, cwd: 'D:\\Work2\\Demo', state: 'running', at: new Date().toISOString() }] })
    assert.equal(ev.status, 200)
    sendJson(ex, { type: 'run.session', runId: r.body.runId, sessionKey: newKey })
    await waitFor(() => find(v, 'session.renamed', m => m.to === real))
    const list = (await call('GET', '/sessions')).body.sessions
    assert.ok(!list.some((s: any) => s.id === pid))
    assert.equal(list.find((s: any) => s.id === real).title, '合并标题')
    assert.equal((await call('GET', `/sessions/${enc(real)}/messages`)).body.messages[0].text, '合并标题')
  })

  it('run.session：非法 key / 非临时 run / 别的机器 都忽略', async () => {
    const machine = uniq('pc')
    const v = await viewer()
    const ex = await executor(machine)
    const stranger = await executor(uniq('other'))
    const { id } = await newSession(machine)
    const r = await call('POST', spawnUrl(id), { mode: 'fork', text: 'x' })
    const pid = r.body.sessionId
    await waitFor(() => find(ex, 'run.start', m => m.runId === r.body.runId))
    sendJson(ex, { type: 'run.session', runId: r.body.runId, sessionKey: '../bad key' })
    sendJson(ex, { type: 'run.session', runId: r.body.runId, sessionKey: 'a'.repeat(101) })
    sendJson(stranger, { type: 'run.session', runId: r.body.runId, sessionKey: uniq('x') })
    // 普通 run 不是临时会话
    const normal = (await call('POST', `/sessions/${enc(id)}/messages`, { text: 'n' })).body.runId
    await waitFor(() => find(ex, 'run.start', m => m.runId === normal))
    sendJson(ex, { type: 'run.session', runId: normal, sessionKey: uniq('y') })
    sendJson(ex, { type: 'run.message', runId: r.body.runId, role: 'system', text: 'barrier2' })
    await waitFor(() => find(v, 'message', m => m.message.text === 'barrier2'))
    assert.ok(!v.msgs.some(m => m.type === 'session.renamed' && m.from === pid))
    assert.ok((await call('GET', '/sessions')).body.sessions.some((s: any) => s.id === pid))
    assert.equal((await call('GET', `/sessions/${enc(id)}/messages`)).body.run.id, normal)
  })

  it('拿到真实 id 前 run failed → 临时会话 aborted 并 notify', async () => {
    const machine = uniq('pc')
    const v = await viewer()
    const ex = await executor(machine)
    const { id } = await newSession(machine)
    const r = await call('POST', spawnUrl(id), { mode: 'fork', text: '会失败' })
    await waitFor(() => find(ex, 'run.start', m => m.runId === r.body.runId))
    sendJson(ex, { type: 'run.status', runId: r.body.runId, status: 'failed', error: '项目目录不在允许列表里' })
    const m = await waitFor(() => find(v, 'session', m => m.session.id === r.body.sessionId && m.session.state === 'aborted'))
    assert.equal(m.notify, true)
    assert.equal(m.session.summary, '项目目录不在允许列表里')
    assert.equal(m.session.acked, false)
    assert.equal((await call('DELETE', `/sessions/${enc(r.body.sessionId)}`)).status, 200)
  })
})
