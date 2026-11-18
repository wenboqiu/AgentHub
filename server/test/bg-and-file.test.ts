import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/index.ts'
import { createPool } from '../src/db.ts'
import { DATABASE_URL, makeUser } from './helpers.ts'

let TOKEN = ''
let USER = 0
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

describe('后台运行不提前转待验收 + 文件预览', () => {
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
  async function executor(machine: string): Promise<Peer> {
    const ws = new WebSocket(base.replace('http', 'ws') + `/ws?token=${TOKEN}&role=agent&machine=${machine}`)
    const p: Peer = { ws, msgs: [] }
    ws.onmessage = e => p.msgs.push(JSON.parse(String(e.data)))
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('ws error'))
    })
    peers.push(p)
    for (let i = 0; i < 100; i++) {
      if ((await call('GET', '/control/status')).body.agents.includes(machine)) return p
      await sleep(20)
    }
    throw new Error('执行器没有登记')
  }
  const find = (p: Peer, type: string) => p.msgs.find(m => m.type === type)
  const sendJson = (p: Peer, m: unknown) => p.ws.send(JSON.stringify(m))
  const hook = async (key: string, machine: string, state: 'running' | 'done') => {
    const r = await call('POST', '/events', { events: [{ agent: 'claude', sessionId: key, machine, cwd: 'D:\\BgTest', state, at: new Date().toISOString() }] })
    assert.equal(r.status, 200)
  }
  const taskOf = async (id: number) => (await call('GET', '/tasks')).body.tasks.find((t: any) => t.id === id)
  const digest = async (id: number) => (await call('GET', `/tasks/${id}/digest`)).body

  before(async () => {
    app = await buildApp(DATABASE_URL, 'silent', { historyTimeoutMs: 600 })
    base = await app.listen({ port: 0, host: '127.0.0.1' })
    const u = await makeUser(pool)
    TOKEN = u.token
    USER = u.id
  })
  after(async () => {
    for (const p of peers) p.ws.close()
    await app.close()
    await pool.end()
  })

  it('有活动 run 时 hook 的 done 不转任务；run.status done 才转并生成摘要；review 再 done 刷新摘要', async () => {
    const machine = uniq('bg')
    const ex = await executor(machine)
    const key = randomUUID()
    const sid = `claude:${key}`
    await hook(key, machine, 'running')
    const t = (await call('POST', '/tasks', { title: '后台任务' })).body.task
    await call('PATCH', `/tasks/${t.id}`, { status: 'doing' })
    assert.equal((await call('POST', `/tasks/${t.id}/sessions`, { sessionId: sid })).status, 200)
    await pool.query('INSERT INTO messages(user_id, session_id, role, text) VALUES($1,$2,$3,$4)', [USER, sid, 'assistant', '等通知'])
    const runId = randomUUID()
    await pool.query("INSERT INTO runs(id, user_id, session_id, task_id, machine, status) VALUES($1,$2,$3,$4,$5,'running')", [runId, USER, sid, t.id, machine])

    // hook done：run 还在跑，任务保持 doing，没有摘要
    await hook(key, machine, 'done')
    assert.equal((await taskOf(t.id)).status, 'doing')
    assert.equal((await digest(t.id)).review, null)

    // 执行器上报 run done：任务转 review，有摘要
    await pool.query('INSERT INTO messages(user_id, session_id, role, text) VALUES($1,$2,$3,$4)', [USER, sid, 'assistant', '全部做完'])
    sendJson(ex, { type: 'run.status', runId, status: 'done' })
    for (let i = 0; i < 100 && (await taskOf(t.id)).status !== 'review'; i++) await sleep(30)
    assert.equal((await taskOf(t.id)).status, 'review')
    const d1 = (await digest(t.id)).review
    assert.equal(d1.lastReply, '全部做完')

    // 已在 review，会话又跑完一轮：摘要刷新、状态不变
    await sleep(15)
    await pool.query('INSERT INTO messages(user_id, session_id, role, text) VALUES($1,$2,$3,$4)', [USER, sid, 'assistant', '又补了一句'])
    await hook(key, machine, 'done')
    const d2 = (await digest(t.id)).review
    assert.equal((await taskOf(t.id)).status, 'review')
    assert.equal(d2.lastReply, '又补了一句')
    assert.ok(d2.builtAt > d1.builtAt)
  })

  it('GET /tasks/:id/file 与 /sessions/:id/file：不在线 409、往返、执行器报错、超时 504、路径校验', async () => {
    // 不在线
    const offKey = randomUUID()
    await hook(offKey, uniq('off'), 'done')
    assert.equal((await call('GET', `/sessions/${encodeURIComponent(`claude:${offKey}`)}/file?path=a.md`)).status, 409)

    const machine = uniq('pc')
    const ex = await executor(machine)
    const key = randomUUID()
    const sid = `claude:${key}`
    await hook(key, machine, 'done')
    const t = (await call('POST', '/tasks', { title: '预览任务' })).body.task
    await call('POST', `/tasks/${t.id}/sessions`, { sessionId: sid })

    // 任务路径：machine/cwd 取自挂接会话
    const pending = call('GET', `/tasks/${t.id}/file?path=${encodeURIComponent('docs/a.md')}`)
    const req = await waitFor(() => find(ex, 'file.request'))
    assert.equal(req.cwd, 'D:\\BgTest')
    assert.equal(req.path, 'docs/a.md')
    sendJson(ex, { type: 'file.result', requestId: req.requestId, path: 'docs/a.md', text: '# hi', size: 4, truncated: false })
    const r = await pending
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { path: 'docs/a.md', text: '# hi', size: 4, truncated: false })

    // 会话路径 + 执行器报错
    ex.msgs.length = 0
    const bad = call('GET', `/sessions/${encodeURIComponent(sid)}/file?path=x.ts`)
    const req2 = await waitFor(() => find(ex, 'file.request'))
    sendJson(ex, { type: 'file.result', requestId: req2.requestId, error: '找不到文件' })
    assert.equal((await bad).status, 404)

    // 超时
    ex.msgs.length = 0
    assert.equal((await call('GET', `/sessions/${encodeURIComponent(sid)}/file?path=slow.ts`)).status, 504)

    // 路径校验：空 / 过长
    assert.equal((await call('GET', `/sessions/${encodeURIComponent(sid)}/file`)).status, 400)
    assert.equal((await call('GET', `/sessions/${encodeURIComponent(sid)}/file?path=${'a'.repeat(1001)}`)).status, 400)
    // 会话不存在
    assert.equal((await call('GET', `/sessions/${encodeURIComponent('claude:nope')}/file?path=a.md`)).status, 404)
  })
})
