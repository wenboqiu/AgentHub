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

function harness() {
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
  const board = async () => (await call('GET', '/dispatch/board')).body as { entries: any[]; agents: string[]; generatedAt: string }
  const entry = async (taskId: number) => (await board()).entries.find(e => e.taskId === taskId)
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
  const newTask = async (fields: Record<string, unknown> = {}) => {
    const r = await call('POST', '/tasks', { title: uniq('任务'), agent: 'claude', machine: 'board-pc', cwd: 'D:\\Work2\\Demo', ...fields })
    assert.equal(r.status, 200)
    return r.body.task as any
  }

  return {
    pool, peers,
    async start() {
      app = await buildApp(DATABASE_URL, 'silent', {})
      base = await app.listen({ port: 0, host: '127.0.0.1' })
      token = (await makeUser(pool)).token
    },
    async stop() {
      for (const p of peers) p.ws.close()
      await app.close()
      await pool.end()
    },
    call, board, entry, connect, executor, newTask,
  }
}

describe('派活看板：排队与在线派发', () => {
  const h = harness()

  before(() => h.start())
  after(() => h.stop())

  it('离线派发的任务出现在看板排队区，带尝试次数和离线标记', async () => {
    const task = await h.newTask()
    await h.call('POST', `/tasks/${task.id}/start`, { text: '离线也要排队' })
    const e = await waitFor(async () => {
      const x = await h.entry(task.id)
      return x?.queued ? x : undefined
    })
    assert.equal(e.status, 'todo')
    assert.equal(e.machine, 'board-pc')
    assert.equal(e.machineOnline, false)
    assert.equal(e.attempts, 0)
    assert.ok(e.queuedAt)
    assert.equal(e.stuck, false)
  })

  it('取消排队后条目从看板消失', async () => {
    const task = await h.newTask()
    await h.call('POST', `/tasks/${task.id}/start`, { text: '待会儿取消' })
    await h.call('DELETE', `/tasks/${task.id}/queue`)
    await waitFor(async () => ((await h.entry(task.id)) === undefined ? true : undefined))
  })

  it('在线派发后进入运行区：有活跃 run、不卡住、电脑在线', async () => {
    await h.executor('board-pc')
    const task = await h.newTask()
    const r = await h.call('POST', `/tasks/${task.id}/start`, { text: '直接开跑' })
    assert.ok(r.body.sessionId)
    const e = await waitFor(async () => {
      const x = await h.entry(task.id)
      return x && x.run && x.status === 'doing' ? x : undefined
    })
    assert.equal(e.queued, false)
    assert.equal(e.stuck, false)
    assert.equal(e.machineOnline, true)
    assert.ok(['queued', 'running'].includes(e.run.status))
  })

  it('doing 却没有活跃 run：标卡住，重新派发后恢复', async () => {
    const task = await h.newTask()
    await h.call('PATCH', `/tasks/${task.id}`, { status: 'doing' })
    const e = await waitFor(async () => {
      const x = await h.entry(task.id)
      return x?.stuck ? x : undefined
    })
    assert.equal(e.run, null)
    assert.equal(e.machineOnline, true)

    const r = await h.call('POST', `/tasks/${task.id}/start`, { text: '重新派发' })
    assert.equal(r.status, 200)
    const ok = await waitFor(async () => {
      const x = await h.entry(task.id)
      return x && x.run && !x.stuck ? x : undefined
    })
    assert.equal(ok.stuck, false)
  })
})

describe('派活看板：会话关联的 run 与等待授权', () => {
  const h = harness()

  before(() => h.start())
  after(() => h.stop())

  it('run 只挂在关联会话上（没有 task_id）也能认出来；等待授权会标记', async () => {
    const exec = await h.executor('board-pc')
    const task = await h.newTask()
    const started = await h.call('POST', `/tasks/${task.id}/start`, { text: '第一轮' })
    const sessionId = started.body.sessionId as string
    const firstRunId = started.body.runId as string

    // 第一轮停掉：任务仍是 doing，但直挂的 run 已经不在了
    exec.ws.send(JSON.stringify({ type: 'run.status', runId: firstRunId, status: 'stopped' }))
    await waitFor(async () => ((await h.entry(task.id))?.stuck === true ? true : undefined))

    // 在关联会话里续聊：这条 run 没写 task_id，只能靠 task_sessions 找到
    const msg = await h.call('POST', `/sessions/${encodeURIComponent(sessionId)}/messages`, { text: '接着跑' })
    assert.equal(msg.status, 200)
    const resumed = await waitFor(async () => {
      const x = await h.entry(task.id)
      return x && x.run && !x.stuck ? x : undefined
    })
    assert.equal(resumed.run.id, msg.body.runId)

    // 执行器请求授权：看板标「等待授权」
    exec.ws.send(JSON.stringify({ type: 'run.approval', runId: msg.body.runId, tool: 'bash', detail: 'ls', localId: 'a1' }))
    const waiting = await waitFor(async () => {
      const x = await h.entry(task.id)
      return x?.waitingApproval ? x : undefined
    })
    assert.equal(waiting.stuck, false)
  })
})
