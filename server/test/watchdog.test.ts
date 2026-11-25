import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../src/index.ts'
import { createPool } from '../src/db.ts'
import { AbortSpreeTracker } from '../src/watchdog.ts'
import { DATABASE_URL, makeUser } from './helpers.ts'

describe('Watchdog 检测回路', () => {
  const pool = createPool(DATABASE_URL)
  let app: Awaited<ReturnType<typeof buildApp>>, base: string, a: Awaited<ReturnType<typeof makeUser>>
  const peers: WebSocket[] = []
  async function call(method: string, path: string, body?: unknown) {
    const r = await app.inject({ method: method as any, url: path, headers: { authorization: `Bearer ${a.token}` }, ...(body === undefined ? {} : { payload: body as any }) })
    return { status: r.statusCode, body: r.json() }
  }
  async function waitFor(msgs: any[], pred: (m: any) => boolean): Promise<any> {
    // 30 秒：全量并行时几个套件共用一条到远程测试库的连接，watchdog 扫残留会话会把隧道打满
    const until = Date.now() + 30_000
    for (;;) {
      const found = msgs.findLast(pred)
      if (found) return found
      if (Date.now() > until) throw new Error('等待广播超时')
      await new Promise(r => setTimeout(r, 10))
    }
  }
  async function connect() {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${a.token}`)
    const msgs: any[] = []
    ws.onmessage = e => msgs.push(JSON.parse(String(e.data)))
    peers.push(ws)
    await new Promise<void>((ok, fail) => { ws.onopen = () => ok(); ws.onerror = () => fail(new Error('连接失败')) })
    await waitFor(msgs, (m: any) => m.type === 'snapshot')
    return msgs
  }
  const event = (key: string, state: 'running' | 'aborted', secondsAgo: number) =>
    call('POST', '/events', { events: [{ agent: 'claude', sessionId: key, machine: 'wd机', cwd: 'D:\\WD', state, at: new Date(Date.now() - secondsAgo * 1000).toISOString() }] })
  const stalls = (msgs: any[], id: string) => msgs.filter(m => m.type === 'watchdog' && m.issue === 'stall' && m.session.id === id)

  before(async () => {
    app = await buildApp(DATABASE_URL, process.env.DIAG ? 'info' : 'silent', { watchdogIntervalMs: 50, stallAfterMs: 300, abortSpreeCount: 2, abortSpreeWindowMs: 60_000 })
    base = await app.listen({ port: 0, host: '127.0.0.1' })
    a = await makeUser(pool)
  })
  after(async () => {
    for (const ws of peers) ws.close()
    await app.close()
    await pool.query('DELETE FROM users WHERE id=ANY($1::bigint[])', [[a.id]])
    await pool.end()
  })

  it('长时间无事件的会话提醒卡死；同一事件只提醒一次，有新事件后重新武装', async () => {
    const msgs = await connect()
    const key = randomUUID(), id = `claude:${key}`
    // 6 天前（窗口 7 天内最老的一批）：库里可能有历史残留的卡死会话积压，测试会话必须排在最前
    await event(key, 'running', 6 * 86_400)
    const w = await waitFor(msgs, m => m.type === 'watchdog' && m.issue === 'stall' && m.session.id === id)
    assert.equal(w.session.state, 'running')
    await new Promise(r => setTimeout(r, 300))
    assert.equal(stalls(msgs, id).length, 1)
    // 新事件（event_at 变化）→ 重新武装，再提醒一次
    await event(key, 'running', 6 * 86_400 - 60)
    await waitFor(msgs, m => stalls(msgs, id).length >= 2)
    await new Promise(r => setTimeout(r, 300))
    assert.equal(stalls(msgs, id).length, 2)
  })

  it('反复失败达到阈值提醒一次，同窗口内不重复', async () => {
    const msgs = await connect()
    const key = randomUUID(), id = `claude:${key}`
    await event(key, 'aborted', 30)
    await event(key, 'aborted', 20)
    const w = await waitFor(msgs, m => m.type === 'watchdog' && m.issue === 'abort-spree' && m.session.id === id)
    assert.equal(w.session.state, 'aborted')
    await event(key, 'aborted', 10)
    await new Promise(r => setTimeout(r, 200))
    assert.equal(msgs.filter(m => m.type === 'watchdog' && m.issue === 'abort-spree' && m.session.id === id).length, 1)
  })

  it('AbortSpreeTracker：running 清零计数，窗口过期重新武装', () => {
    const t = new AbortSpreeTracker(2, 100)
    assert.equal(t.record(1, 's', 'aborted'), false)
    assert.equal(t.record(1, 's', 'aborted'), true)
    assert.equal(t.record(1, 's', 'aborted'), false)
    t.record(1, 's', 'running')
    assert.equal(t.record(1, 's', 'aborted'), false)
    assert.equal(t.record(1, 's', 'aborted'), true)
    // 窗口过期：重新计数，两次后再次触发
    assert.equal(t.record(1, 's', 'aborted', Date.now() + 200), false)
    assert.equal(t.record(1, 's', 'aborted', Date.now() + 201), true)
    // 账号/会话隔离
    assert.equal(t.record(2, 's', 'aborted'), false)
    assert.equal(t.record(2, 's', 'aborted'), true)
  })
})
