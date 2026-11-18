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

type Peer = { ws: WebSocket; msgs: any[] }

async function waitFor<T>(fn: () => T | undefined | null | false, ms = 4000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error('waitFor 超时')
    await sleep(20)
  }
}

// Claude 终端会话的权限确认：电脑端 hook.approval → 审批卡 → 客户端点按钮 → hook.approval.decide
describe('Claude hook 审批', () => {
  const pool = createPool(DATABASE_URL)
  let app: FastifyInstance
  let base = ''
  const peers: Peer[] = []

  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${TOKEN}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    return { status: res.status, body: (text.startsWith('{') ? JSON.parse(text) : text) as any }
  }

  async function connect(query: string): Promise<Peer> {
    const ws = new WebSocket(base.replace('http', 'ws') + `/ws?token=${TOKEN}&${query}`)
    const p: Peer = { ws, msgs: [] }
    ws.onmessage = e => p.msgs.push(JSON.parse(String(e.data)))
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
    for (let i = 0; i < 100; i++) {
      if ((await call('GET', '/control/status')).body.agents.includes(machine)) return e
      await sleep(20)
    }
    throw new Error('执行器没有登记')
  }
  const find = (p: Peer, type: string, pred: (m: any) => boolean = () => true) => p.msgs.find(m => m.type === type && pred(m))
  const sendJson = (p: Peer, m: unknown) => p.ws.send(JSON.stringify(m))

  async function newSession(machine: string) {
    const sessionId = uniq('hk')
    const r = await call('POST', '/events', {
      events: [{ agent: 'claude', sessionId, machine, cwd: 'D:\\Work2\\Demo', state: 'waiting', at: new Date().toISOString() }],
    })
    assert.equal(r.status, 200)
    return { id: `claude:${sessionId}`, key: sessionId }
  }

  before(async () => {
    app = await buildApp(DATABASE_URL, 'silent', {})
    base = await app.listen({ port: 0, host: '127.0.0.1' })
    TOKEN = (await makeUser(pool)).token
  })
  after(async () => {
    for (const p of peers) p.ws.close()
    await app.close()
    await pool.end()
  })

  it('canAllow=false：建审批行并通知；allow 403，deny 200 且执行器收到 hook.approval.decide', async () => {
    const machine = uniq('pc')
    const v = await viewer()
    const ex = await executor(machine)
    const { id, key } = await newSession(machine)
    sendJson(ex, { type: 'hook.approval', localId: 7, sessionKey: key, tool: 'Bash', detail: 'rm -rf x', canAllow: false })
    const created = await waitFor(() => find(ex, 'hook.approval.created'))
    assert.equal(created.localId, 7)
    assert.ok(created.approvalId)
    const pushed = await waitFor(() => find(v, 'approval', m => m.approval.id === created.approvalId))
    assert.equal(pushed.notify, true)
    assert.equal(pushed.approval.canAllow, false)
    assert.equal(pushed.approval.tool, 'Bash')
    assert.equal(pushed.approval.status, 'pending')

    const list = await call('GET', `/sessions/${encodeURIComponent(id)}/messages`)
    assert.equal(list.body.approvals.length, 1)
    assert.equal(list.body.approvals[0].canAllow, false)
    assert.ok(list.body.messages.some((m: any) => m.role === 'approval' && m.text.includes('请求授权')))

    assert.equal((await call('POST', `/approvals/${created.approvalId}`, { decision: 'allow' })).status, 403)
    assert.equal(find(ex, 'hook.approval.decide'), undefined)
    assert.equal((await call('POST', `/approvals/${created.approvalId}`, { decision: 'deny' })).status, 200)
    const decide = await waitFor(() => find(ex, 'hook.approval.decide'))
    assert.deepEqual([decide.approvalId, decide.decision], [created.approvalId, 'deny'])
    assert.equal(find(ex, 'approval.decide'), undefined, '不用 run 的 approval.decide')
    await waitFor(() => find(v, 'approval', m => m.approval.id === created.approvalId && m.approval.status === 'denied'))
    assert.equal((await call('POST', `/approvals/${created.approvalId}`, { decision: 'deny' })).status, 409)
  })

  it('canAllow=true：allow 可以', async () => {
    const machine = uniq('pc')
    const ex = await executor(machine)
    const { key } = await newSession(machine)
    sendJson(ex, { type: 'hook.approval', localId: 1, sessionKey: key, tool: 'Write', detail: 'a.txt', canAllow: true })
    const created = await waitFor(() => find(ex, 'hook.approval.created'))
    assert.equal((await call('POST', `/approvals/${created.approvalId}`, { decision: 'allow' })).status, 200)
    const decide = await waitFor(() => find(ex, 'hook.approval.decide'))
    assert.deepEqual([decide.approvalId, decide.decision], [created.approvalId, 'allow'])
  })

  it('会话不存在或属于别的电脑：回 approvalId 空串，不建审批', async () => {
    const machine = uniq('pc')
    const ex = await executor(machine)
    sendJson(ex, { type: 'hook.approval', localId: 1, sessionKey: uniq('nosuch'), tool: 'Bash', detail: 'ls', canAllow: true })
    const none = await waitFor(() => find(ex, 'hook.approval.created'))
    assert.equal(none.approvalId, '')

    const other = await newSession(uniq('other-pc'))
    sendJson(ex, { type: 'hook.approval', localId: 2, sessionKey: other.key, tool: 'Bash', detail: 'ls', canAllow: true })
    const refused = await waitFor(() => find(ex, 'hook.approval.created', m => m.localId === 2))
    assert.equal(refused.approvalId, '')
    assert.equal((await call('GET', `/sessions/${encodeURIComponent(other.id)}/messages`)).body.approvals.length, 0)
  })

  it('hook.approval.expired 置为 expired 并广播；之后点按钮 409', async () => {
    const machine = uniq('pc')
    const v = await viewer()
    const ex = await executor(machine)
    const { key } = await newSession(machine)
    sendJson(ex, { type: 'hook.approval', localId: 1, sessionKey: key, tool: 'Bash', detail: 'ls', canAllow: false })
    const created = await waitFor(() => find(ex, 'hook.approval.created'))
    sendJson(ex, { type: 'hook.approval.expired', approvalId: created.approvalId })
    const ev = await waitFor(() => find(v, 'approval', m => m.approval.id === created.approvalId && m.approval.status === 'expired'))
    assert.equal(ev.notify, false)
    assert.equal((await call('POST', `/approvals/${created.approvalId}`, { decision: 'deny' })).status, 409)
  })

  it('电脑端断开：pending 的 hook 审批过期', async () => {
    const machine = uniq('pc')
    const v = await viewer()
    const ex = await executor(machine)
    const { id, key } = await newSession(machine)
    sendJson(ex, { type: 'hook.approval', localId: 1, sessionKey: key, tool: 'Bash', detail: 'ls', canAllow: true })
    const created = await waitFor(() => find(ex, 'hook.approval.created'))
    ex.ws.close()
    await waitFor(() => find(v, 'approval', m => m.approval.id === created.approvalId && m.approval.status === 'expired'))
    assert.equal((await call('GET', `/sessions/${encodeURIComponent(id)}/messages`)).body.approvals.length, 0)
  })

  it('电脑端不在线时点按钮 409', async () => {
    const machine = uniq('pc')
    const ex = await executor(machine)
    const { key } = await newSession(machine)
    sendJson(ex, { type: 'hook.approval', localId: 1, sessionKey: key, tool: 'Bash', detail: 'ls', canAllow: true })
    const created = await waitFor(() => find(ex, 'hook.approval.created'))
    // 断线时会被过期，所以直接断言：过期后按钮 409
    ex.ws.close()
    await sleep(300)
    assert.equal((await call('POST', `/approvals/${created.approvalId}`, { decision: 'deny' })).status, 409)
  })
})
