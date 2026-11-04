import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/index.ts'
import { createPool } from '../src/db.ts'
import { DATABASE_URL, makeUser } from './helpers.ts'

const stamp = Date.now()
let n = 0
const uniq = (p: string) => `${p}${stamp}-${n++}`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type Peer = { ws: WebSocket; msgs: any[] }

async function waitFor<T>(fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 6000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('waitFor 超时')
    await sleep(20)
  }
}

function harness(config: Record<string, unknown>) {
  const pool = createPool(DATABASE_URL)
  let app: FastifyInstance
  let base = ''
  let token = ''
  const peers: Peer[] = []

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    return { status: res.status, body: (text.startsWith('{') ? JSON.parse(text) : text) as any }
  }
  const connect = async (query: string) => {
    const ws = new WebSocket(base.replace('http', 'ws') + `/ws?token=${token}&${query}`)
    const p: Peer = { ws, msgs: [] }
    ws.onmessage = e => p.msgs.push(JSON.parse(String(e.data)))
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('ws error'))
    })
    peers.push(p)
    return p
  }
  const executor = async (machine: string) => {
    const e = await connect(`role=agent&machine=${machine}`)
    await waitFor(async () => (await call('GET', '/control/status')).body.agents.includes(machine))
    return e
  }
  const newTask = async (machine: string) => {
    const r = await call('POST', '/tasks', { title: uniq('任务'), agent: 'claude', machine, cwd: 'D:\\Work2\\Demo' })
    assert.equal(r.status, 200)
    return r.body.task as any
  }
  const taskById = async (id: number) => ((await call('GET', '/tasks')).body.tasks as any[]).find(t => t.id === id)

  return {
    pool, peers,
    async start() {
      app = await buildApp(DATABASE_URL, 'silent', config)
      base = await app.listen({ port: 0, host: '127.0.0.1' })
      token = (await makeUser(pool)).token
    },
    async stop() {
      for (const p of peers) p.ws.close()
      await app.close()
      await pool.end()
    },
    call, connect, executor, newTask, taskById,
  }
}

describe('派活排队：离线入队，上线投递', () => {
  const h = harness({ queueSweepIntervalMs: 60 })

  before(() => h.start())
  after(() => h.stop())

  it('电脑离线时不再 409，而是入队并把任务留在待办', async () => {
    const task = await h.newTask('pc-offline')
    const r = await h.call('POST', `/tasks/${task.id}/start`, { text: '查一下构建为什么挂了' })
    assert.equal(r.status, 200)
    assert.equal(r.body.queued, true)
    assert.ok(r.body.task.queuedAt, '任务应带排队时间')
    assert.equal(r.body.task.status, 'todo')
    assert.equal(r.body.task.machine, 'pc-offline')

    const stored = await h.taskById(task.id)
    assert.ok(stored.queuedAt)
    assert.equal(stored.sessionIds.length, 0)
  })

  it('目标电脑上线后自动派发，排队标记清空', async () => {
    const task = await h.newTask('pc-boost')
    const queued = await h.call('POST', `/tasks/${task.id}/start`, { text: '跑一遍全量测试' })
    assert.equal(queued.body.queued, true)

    const exec = await h.executor('pc-boost')
    const started = await waitFor(() => exec.msgs.find(m => m.type === 'run.start'))
    assert.equal(started.agent, 'claude')
    assert.equal(started.cwd, 'D:\\Work2\\Demo')
    assert.equal(started.text, '跑一遍全量测试')

    const after = await waitFor(async () => {
      const t = await h.taskById(task.id)
      return t && t.queuedAt === null && t.status === 'doing' ? t : undefined
    })
    assert.equal(after.sessionIds.length, 1)
  })

  it('可以取消排队；重复派发会覆盖上一次排队的消息', async () => {
    const task = await h.newTask('pc-cancel')
    await h.call('POST', `/tasks/${task.id}/start`, { text: '第一次' })
    await h.call('POST', `/tasks/${task.id}/start`, { text: '第二次' })
    const cancelled = await h.call('DELETE', `/tasks/${task.id}/queue`)
    assert.equal(cancelled.status, 200)
    assert.equal(cancelled.body.task.queuedAt, null)
    assert.equal(cancelled.body.task.status, 'todo')
  })

  it('电脑在线时直接派发，不入队', async () => {
    await h.executor('pc-online')
    const task = await h.newTask('pc-online')
    const r = await h.call('POST', `/tasks/${task.id}/start`, { text: '直接开始' })
    assert.equal(r.body.queued, undefined)
    assert.ok(r.body.sessionId)
    assert.equal(r.body.task.status, 'doing')
    assert.equal(r.body.task.queuedAt, null)
  })
})

describe('派活排队：过期作废', () => {
  const h = harness({ queueTtlMs: 40, queueSweepIntervalMs: 30 })

  before(() => h.start())
  after(() => h.stop())

  it('超过存活时间的排队项被清掉，任务不会永远挂在排队态', async () => {
    const task = await h.newTask('pc-never')
    await h.call('POST', `/tasks/${task.id}/start`, { text: '等不到的派发' })
    const cleared = await waitFor(async () => {
      const t = await h.taskById(task.id)
      return t && t.queuedAt === null ? t : undefined
    })
    assert.equal(cleared.status, 'todo')
  })
})
