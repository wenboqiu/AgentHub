import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/index.ts'
import { createPool, insertMessage, listMessages } from '../src/db.ts'
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

describe('远程控制', () => {
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

  it('控制接口无登录返回 401；/control/status 只有 agents', async () => {
    const { id } = await newSession(uniq('pc'))
    const url = `/sessions/${encodeURIComponent(id)}/messages`
    assert.equal((await call('POST', url, { text: 'hi' }, 'wrong')).status, 401)
    assert.equal((await call('POST', '/runs/x/stop', {}, 'wrong')).status, 401)
    assert.equal((await call('POST', '/approvals/x', { decision: 'allow' }, 'wrong')).status, 401)
    assert.equal((await call('POST', `/sessions/${encodeURIComponent(id)}/history`, {}, 'wrong')).status, 401)
    const st = await call('GET', '/control/status')
    assert.equal(st.status, 200)
    assert.ok(Array.isArray(st.body.agents) && !('enabled' in st.body))
    assert.equal((await call('GET', '/control/status', undefined, 'bad')).status, 401)
  })

  it('执行器不在线发消息 409，会话不存在 404', async () => {
    const { id } = await newSession(uniq('offline'))
    const r = await call('POST', `/sessions/${encodeURIComponent(id)}/messages`, { text: 'hi' })
    assert.equal(r.status, 409)
    assert.equal(r.body.error, '电脑端不在线')
    assert.equal((await call('POST', `/sessions/${encodeURIComponent('claude:nope')}/messages`, { text: 'hi' })).status, 404)
  })

  it('发消息 → 执行器收到 run.start；run.message/status 广播并可查询；运行中再发 409', async () => {
    const machine = uniq('pc')
    const v = await viewer()
    const ex = await executor(machine)
    await waitFor(() => find(v, 'agents', m => m.agents.includes(machine)))
    assert.ok((await call('GET', '/control/status')).body.agents.includes(machine))
    const { id, key } = await newSession(machine)

    assert.equal((await call('POST', `/sessions/${encodeURIComponent(id)}/messages`, { text: '' })).status, 400)
    const r = await call('POST', `/sessions/${encodeURIComponent(id)}/messages`, { text: '只回复 OK2' })
    assert.equal(r.status, 200)
    const runId = r.body.runId
    const start = await waitFor(() => find(ex, 'run.start'))
    assert.equal(start.runId, runId)
    assert.equal(start.agent, 'claude')
    assert.equal(start.sessionKey, key)
    assert.equal(start.cwd, 'D:\\Work2\\Demo')
    assert.equal(start.text, '只回复 OK2')
    await waitFor(() => find(v, 'message', m => m.message.runId === runId && m.message.role === 'user'))
    assert.equal(find(v, 'run', m => m.run.id === runId).run.status, 'queued')

    // 已有 queued/running 的 run
    const again = await call('POST', `/sessions/${encodeURIComponent(id)}/messages`, { text: '再来' })
    assert.equal(again.status, 409)
    assert.equal(again.body.error, '这个会话正在运行')

    sendJson(ex, { type: 'run.status', runId, status: 'running' })
    sendJson(ex, { type: 'run.message', runId, role: 'assistant', text: 'OK2' })
    sendJson(ex, { type: 'run.message', runId, role: 'tool', text: 'Bash echo hi' })
    sendJson(ex, { type: 'run.status', runId, status: 'done' })
    await waitFor(() => find(v, 'run', m => m.run.id === runId && m.run.status === 'done'))
    assert.equal(find(v, 'message', m => m.message.role === 'assistant').message.text, 'OK2')

    const q = await call('GET', `/sessions/${encodeURIComponent(id)}/messages?limit=100`)
    assert.deepEqual(
      q.body.messages.map((m: any) => [m.role, m.text]),
      [
        ['user', '只回复 OK2'],
        ['assistant', 'OK2'],
        ['tool', 'Bash echo hi'],
      ],
    )
    assert.equal(q.body.run.status, 'done')
    assert.deepEqual(q.body.approvals, [])

    // 结束后可以再发
    assert.equal((await call('POST', `/sessions/${encodeURIComponent(id)}/messages`, { text: '继续' })).status, 200)
  })

  it('Codex 会话 running 时不允许发消息', async () => {
    const machine = uniq('pc')
    await executor(machine)
    const { id } = await newSession(machine, 'codex', 'running')
    const r = await call('POST', `/sessions/${encodeURIComponent(id)}/messages`, { text: 'hi' })
    assert.equal(r.status, 409)
  })

  it('授权：run.approval → viewer 收到 notify → 决定 → 执行器收到；重复决定 409；停止转发', async () => {
    const machine = uniq('pc')
    const v = await viewer()
    const ex = await executor(machine)
    const { id } = await newSession(machine)
    const runId = (await call('POST', `/sessions/${encodeURIComponent(id)}/messages`, { text: '写文件' })).body.runId
    await waitFor(() => find(ex, 'run.start'))
    sendJson(ex, { type: 'run.status', runId, status: 'running' })
    sendJson(ex, { type: 'run.approval', runId, localId: 0, tool: 'Write', detail: 'x.txt hi' })
    const created = await waitFor(() => find(ex, 'approval.created'))
    assert.equal(created.localId, 0)
    const pushed = await waitFor(() => find(v, 'approval', m => m.approval.id === created.approvalId))
    assert.equal(pushed.notify, true)
    assert.equal(pushed.approval.status, 'pending')
    assert.equal(pushed.approval.project, 'Demo')
    assert.equal(pushed.approval.tool, 'Write')

    const pending = await call('GET', `/sessions/${encodeURIComponent(id)}/messages`)
    assert.equal(pending.body.approvals.length, 1)
    assert.ok(pending.body.messages.some((m: any) => m.role === 'approval' && m.text.includes('请求授权')))

    assert.equal((await call('POST', `/approvals/${created.approvalId}`, { decision: 'maybe' })).status, 400)
    assert.equal((await call('POST', `/approvals/${created.approvalId}`, { decision: 'deny' })).status, 200)
    const decide = await waitFor(() => find(ex, 'approval.decide'))
    assert.deepEqual([decide.approvalId, decide.decision], [created.approvalId, 'deny'])
    const after = await waitFor(() => find(v, 'approval', m => m.approval.id === created.approvalId && m.approval.status === 'denied'))
    assert.equal(after.notify, false)
    assert.equal((await call('POST', `/approvals/${created.approvalId}`, { decision: 'allow' })).status, 409)
    assert.equal((await call('POST', '/approvals/nope', { decision: 'allow' })).status, 404)

    assert.equal((await call('POST', `/runs/${runId}/stop`, {})).status, 200)
    const stop = await waitFor(() => find(ex, 'run.stop'))
    assert.equal(stop.runId, runId)
    sendJson(ex, { type: 'run.status', runId, status: 'stopped' })
    await waitFor(() => find(v, 'run', m => m.run.id === runId && m.run.status === 'stopped'))
    assert.equal((await call('POST', `/runs/${runId}/stop`, {})).status, 409)
  })

  it('授权超时立即广播 expired，运行继续；隔离其它机器/运行，重复通知幂等', async () => {
    const machine = uniq('pc')
    const v = await viewer()
    const ex = await executor(machine)
    const stranger = await executor(uniq('other'))
    const { id } = await newSession(machine)
    const runId = (await call('POST', `/sessions/${encodeURIComponent(id)}/messages`, { text: '写文件' })).body.runId
    await waitFor(() => find(ex, 'run.start'))
    sendJson(ex, { type: 'run.status', runId, status: 'running' })
    sendJson(ex, { type: 'run.approval', runId, localId: 7, tool: 'Write', detail: 'x.txt' })
    const created = await waitFor(() => find(ex, 'approval.created'))
    const expire = { type: 'run.approvalExpired', runId, approvalId: created.approvalId }
    // 别的机器不能替本机过期授权；后续状态消息作为串行处理屏障。
    sendJson(stranger, expire)
    const foreignSession = await newSession(uniq('foreign-offline'))
    assert.ok(foreignSession.id)
    sendJson(ex, { ...expire, runId: 'unknown' })
    sendJson(ex, { type: 'run.message', runId, role: 'system', text: 'expiry-barrier' })
    await waitFor(() => find(v, 'message', m => m.message.text === 'expiry-barrier'))
    assert.equal((await call('GET', `/sessions/${encodeURIComponent(id)}/messages`)).body.approvals.length, 1)
    sendJson(ex, expire)
    const expired = await waitFor(() => find(v, 'approval', m => m.approval.id === created.approvalId && m.approval.status === 'expired'))
    assert.equal(expired.notify, false)
    const current = (await call('GET', `/sessions/${encodeURIComponent(id)}/messages`)).body
    assert.equal(current.run.status, 'running')
    assert.deepEqual(current.approvals, [])
    assert.equal((await call('POST', `/approvals/${created.approvalId}`, { decision: 'allow' })).status, 409)
    sendJson(ex, expire)
    sendJson(ex, { type: 'run.message', runId, role: 'system', text: 'repeat-barrier' })
    await waitFor(() => find(v, 'message', m => m.message.text === 'repeat-barrier'))
    assert.equal(v.msgs.filter(m => m.type === 'approval' && m.approval.id === created.approvalId && m.approval.status === 'expired').length, 1)
    const reconnected = await viewer()
    assert.ok(!find(reconnected, 'snapshot').approvals.some((a: any) => a.id === created.approvalId))
  })

  it('执行器断线：run 变 failed，pending 授权变 expired', async () => {
    const machine = uniq('pc')
    const v = await viewer()
    const ex = await executor(machine)
    const { id } = await newSession(machine)
    const runId = (await call('POST', `/sessions/${encodeURIComponent(id)}/messages`, { text: '写文件' })).body.runId
    await waitFor(() => find(ex, 'run.start'))
    sendJson(ex, { type: 'run.status', runId, status: 'running' })
    sendJson(ex, { type: 'run.approval', runId, localId: 1, tool: 'Bash', detail: 'rm x' })
    const created = await waitFor(() => find(ex, 'approval.created'))
    await waitFor(() => find(v, 'approval', m => m.approval.id === created.approvalId))
    ex.ws.close()
    const failed = await waitFor(() => find(v, 'run', m => m.run.id === runId && m.run.status === 'failed'))
    assert.equal(failed.run.error, '电脑端断开')
    await waitFor(() => find(v, 'approval', m => m.approval.id === created.approvalId && m.approval.status === 'expired'))
    await waitFor(() => find(v, 'agents', m => !m.agents.includes(machine) && v.msgs.indexOf(m) > v.msgs.indexOf(failed) - 5))
    const q = await call('GET', `/sessions/${encodeURIComponent(id)}/messages`)
    assert.equal(q.body.approvals.length, 0)
    assert.equal(q.body.run.status, 'failed')
  })

  it('同一 machine 的新执行器连接顶掉旧的', async () => {
    const machine = uniq('pc')
    const a = await executor(machine)
    const b = await connect(`role=agent&machine=${machine}`)
    await waitFor(() => a.closed)
    await sleep(150)
    assert.equal(a.closed!.code, 4000)
    assert.equal(b.closed, null)
    const { id } = await newSession(machine)
    assert.equal((await call('POST', `/sessions/${encodeURIComponent(id)}/messages`, { text: 'hi' })).status, 200)
    await waitFor(() => find(b, 'run.start'))
    assert.equal(find(a, 'run.start'), undefined)
  })

  it('history 往返、去重、执行器不在线 409、超时 504', async () => {
    const machine = uniq('pc')
    const ex = await executor(machine)
    const { id } = await newSession(machine)
    const url = `/sessions/${encodeURIComponent(id)}/history`

    const pending = call('POST', url, {})
    const req = await waitFor(() => find(ex, 'history.request'))
    assert.equal(req.agent, 'claude')
    assert.equal(req.cwd, 'D:\\Work2\\Demo')
    sendJson(ex, {
      type: 'history.result',
      requestId: req.requestId,
      messages: [
        { role: 'user', text: '以前的问题' },
        { role: 'assistant', text: '以前的回答' },
        { role: 'user', text: '以前的问题' },
      ],
    })
    const r = await pending
    assert.equal(r.status, 200)
    // 快照原样保存（重复的消息也是真实对话的一部分，不去重）
    assert.deepEqual(
      r.body.messages.map((m: any) => [m.role, m.text, m.runId]),
      [
        ['user', '以前的问题', null],
        ['assistant', '以前的回答', null],
        ['user', '以前的问题', null],
      ],
    )
    // 再请求一次：用新快照整体替换，最新内容在最后
    ex.msgs.length = 0
    const again = call('POST', url, {})
    const req2 = await waitFor(() => find(ex, 'history.request'))
    sendJson(ex, { type: 'history.result', requestId: req2.requestId, messages: [{ role: 'user', text: '以前的问题' }, { role: 'assistant', text: '以前的回答' }, { role: 'user', text: '新的一条' }] })
    assert.deepEqual((await again).body.messages.map((m: any) => m.text), ['以前的问题', '以前的回答', '新的一条'])
    const listed = await call('GET', `/sessions/${encodeURIComponent(id)}/messages`)
    assert.deepEqual(listed.body.messages.map((m: any) => m.text), ['以前的问题', '以前的回答', '新的一条'])

    // 进行中的 run 的消息保留，排在快照之后
    ex.msgs.length = 0
    assert.equal((await call('POST', `/sessions/${encodeURIComponent(id)}/messages`, { text: '正在跑的问题' })).status, 200)
    const start = await waitFor(() => find(ex, 'run.start'))
    sendJson(ex, { type: 'run.status', runId: start.runId, status: 'running' })
    await sleep(200)
    const third = call('POST', url, {})
    const reqRun = await waitFor(() => find(ex, 'history.request'))
    sendJson(ex, { type: 'history.result', requestId: reqRun.requestId, messages: [{ role: 'user', text: '快照里的' }] })
    assert.deepEqual((await third).body.messages.map((m: any) => m.text), ['快照里的', '正在跑的问题'])
    sendJson(ex, { type: 'run.status', runId: start.runId, status: 'done' })
    await sleep(200)

    // 超时
    ex.msgs.length = 0
    const slow = await call('POST', url, {})
    assert.equal(slow.status, 504)

    // 执行器返回错误
    ex.msgs.length = 0
    const bad = call('POST', url, {})
    const req3 = await waitFor(() => find(ex, 'history.request'))
    sendJson(ex, { type: 'history.result', requestId: req3.requestId, messages: [], error: '找不到记录' })
    const br = await bad
    assert.equal(br.status, 502)

    // 不在线
    const off = await newSession(uniq('nobody'))
    assert.equal((await call('POST', `/sessions/${encodeURIComponent(off.id)}/history`, {})).status, 409)
  })

  it('messages 每个会话只保留最近 200 条', async () => {
    const machine = uniq('pc')
    const ex = await executor(machine)
    const { id } = await newSession(machine)
    const runId = (await call('POST', `/sessions/${encodeURIComponent(id)}/messages`, { text: 'start' })).body.runId
    await waitFor(() => find(ex, 'run.start'))
    for (let i = 0; i < 210; i++) sendJson(ex, { type: 'run.message', runId, role: 'assistant', text: `m${i}` })
    sendJson(ex, { type: 'run.status', runId, status: 'done' })
    // 轮询到 run 结束（说明前面的消息都已处理）
    let q: any
    for (let i = 0; i < 100; i++) {
      q = await call('GET', `/sessions/${encodeURIComponent(id)}/messages?limit=500`)
      if (q.body.run.status === 'done') break
      await sleep(50)
    }
    assert.equal(q.body.run.status, 'done')
    assert.equal(q.body.messages.length, 200)
    assert.equal(q.body.messages.at(-1).text, 'm209')
    assert.equal(q.body.messages[0].text, 'm10')
  })

  it('数据库时钟回拨后新消息仍排在旧消息之后', async () => {
    const id = uniq('clock-regression')
    const u = await makeUser(pool)
    try {
      await insertMessage(pool, u.id, id, null, 'assistant', 'before')
      await pool.query("UPDATE messages SET created_at = now() + interval '1 hour' WHERE session_id = $1", [id])
      await insertMessage(pool, u.id, id, null, 'assistant', 'after')
      assert.deepEqual((await listMessages(pool, u.id, id, 200)).map(m => m.text), ['before', 'after'])
    } finally {
      await pool.query('DELETE FROM messages WHERE session_id = $1', [id])
    }
  })

  it('消息里的 NUL 被去掉', async () => {
    const machine = uniq('pc')
    const ex = await executor(machine)
    const { id } = await newSession(machine)
    const runId = (await call('POST', `/sessions/${encodeURIComponent(id)}/messages`, { text: 'a\u0000b' })).body.runId
    await waitFor(() => find(ex, 'run.start'))
    sendJson(ex, { type: 'run.message', runId, role: 'assistant', text: 'x\u0000y' })
    sendJson(ex, { type: 'run.status', runId, status: 'done' })
    let q: any
    for (let i = 0; i < 100; i++) {
      q = await call('GET', `/sessions/${encodeURIComponent(id)}/messages`)
      if (q.body.run.status === 'done') break
      await sleep(50)
    }
    assert.deepEqual(q.body.messages.map((m: any) => m.text), ['ab', 'xy'])
  })
})
