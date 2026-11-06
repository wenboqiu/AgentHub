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
const CAPS = 'capabilities=reply-branch-v1,role-v1'

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
  const sockets: WebSocket[] = []

  const call = async (method: string, path: string, body?: unknown, as?: string) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${as ?? token}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    return { status: res.status, body: (text.startsWith('{') ? JSON.parse(text) : text) as any }
  }
  const connect = async (query: string) => {
    const ws = new WebSocket(base.replace('http', 'ws') + `/ws?token=${token}&${query}`)
    const msgs: any[] = []
    ws.onmessage = e => msgs.push(JSON.parse(String(e.data)))
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('ws error')) })
    sockets.push(ws)
    return msgs
  }
  const executor = async (machine: string, caps = CAPS) => {
    const msgs = await connect(`role=agent&machine=${machine}&${caps}`)
    await waitFor(async () => (await call('GET', '/control/status')).body.agents.includes(machine))
    return msgs
  }
  const role = async (body: Record<string, unknown>) => {
    const r = await call('POST', '/roles', body)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    return r.body.role as any
  }
  const task = async (body: Record<string, unknown>) => {
    const r = await call('POST', '/tasks', { title: uniq('任务'), ...body })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    return r.body.task as any
  }

  return {
    pool,
    async start() {
      app = await buildApp(DATABASE_URL, 'silent', {})
      base = await app.listen({ port: 0, host: '127.0.0.1' })
      token = (await makeUser(pool)).token
    },
    async stop() {
      for (const ws of sockets) ws.close()
      await app.close()
      await pool.end()
    },
    call, connect, executor, role, task,
  }
}

describe('角色：谁来做 + 用什么模型 + 按什么准则', () => {
  const h = harness()

  before(() => h.start())
  after(() => h.stop())

  it('增删改查；同名角色直接拒绝，上下文可以留空', async () => {
    const r = await h.role({ name: uniq('前端'), agent: 'claude', model: 'opus', context: '只改前端代码，动手前先看现有写法' })
    assert.equal(r.agent, 'claude')
    assert.equal(r.model, 'opus')
    assert.equal(r.context, '只改前端代码，动手前先看现有写法')
    assert.equal(r.tasks, 0)

    assert.equal((await h.call('POST', '/roles', { name: r.name })).status, 409)

    const updated = await h.call('PATCH', `/roles/${r.id}`, { model: 'sonnet' })
    assert.equal(updated.status, 200)
    assert.equal(updated.body.role.model, 'sonnet')
    assert.equal(updated.body.role.context, r.context, '没传的字段不该被清空')

    const blank = await h.role({ name: uniq('纯人设'), agent: 'codex', context: '' })
    assert.equal(blank.context, '')
    assert.equal(blank.model, null)

    assert.equal((await h.call('POST', '/roles', { name: uniq('坏工具'), agent: 'nope' })).status, 400)
    assert.equal((await h.call('POST', '/roles', { name: uniq('超长'), context: 'x'.repeat(4001) })).status, 400)
    assert.equal((await h.call('DELETE', `/roles/${r.id}`)).status, 200)
    assert.equal((await h.call('PATCH', `/roles/${r.id}`, { name: uniq('没了') })).status, 404)
    assert.equal((await h.call('GET', '/roles')).body.roles.some((x: any) => x.id === r.id), false)
  })

  it('建任务选角色：执行工具跟着角色走', async () => {
    const r = await h.role({ name: uniq('组长'), agent: 'codex', model: 'gpt-5-codex', context: '先给方案再动手' })
    const t = await h.task({ roleId: r.id })
    assert.equal(t.roleId, r.id)
    assert.equal(t.agent, 'codex', '执行工具来自角色')
    assert.equal(t.machine, null, '目录与电脑不归角色管，派发时按项目目录挑')
    assert.equal(t.cwd, null)
    assert.equal(r.context, '先给方案再动手', '上下文不进任务字段，只在派活时下发')
  })

  it('显式填的字段不会被角色覆盖', async () => {
    const r = await h.role({ name: uniq('不要覆盖'), agent: 'claude', model: 'opus' })
    const t = await h.task({ roleId: r.id, agent: 'codex', priority: 'low' })
    assert.equal(t.agent, 'codex')
    assert.equal(t.priority, 'low')
  })

  it('派活时把模型与上下文发给执行器', async () => {
    const machine = `role-on-${stamp}`
    const msgs = await h.executor(machine)
    const r = await h.role({ name: uniq('评审'), agent: 'claude', model: 'haiku', context: '只挑毛病，不要重写' })
    const t = await h.task({ roleId: r.id, machine, cwd: 'D:\\Work2\\Demo' })
    const started = await h.call('POST', `/tasks/${t.id}/start`, {})
    assert.equal(started.status, 200, JSON.stringify(started.body))
    assert.equal(started.body.roleDegraded, undefined, '执行器支持 role-v1 时不该报降级')

    const run = await waitFor(() => msgs.find(m => m.type === 'run.start' && m.runId === started.body.runId))
    assert.equal(run.agent, 'claude')
    assert.equal(run.model, 'haiku')
    assert.match(run.instructions, /只挑毛病，不要重写/)
    assert.equal(run.text, t.title, '第一条消息保持原样，上下文不混进去')
  })

  it('执行器不支持 role-v1 时照常派活，但明确报降级', async () => {
    const machine = `role-old-${stamp}`
    await h.executor(machine, 'capabilities=reply-branch-v1')
    const r = await h.role({ name: uniq('旧机'), agent: 'claude', context: '用中文回复' })
    const t = await h.task({ roleId: r.id, machine, cwd: 'D:\\Work2\\Demo' })
    const started = await h.call('POST', `/tasks/${t.id}/start`, {})
    assert.equal(started.status, 200, JSON.stringify(started.body))
    assert.equal(started.body.roleDegraded, true)
  })

  it('电脑离线时角色随排队一起存下，上线后按入队时的角色执行', async () => {
    const machine = `role-q-${stamp}`
    const r = await h.role({ name: uniq('排队'), agent: 'claude', model: 'opus', context: '慢一点，多想一步' })
    const t = await h.task({ roleId: r.id, machine, cwd: 'D:\\Work2\\Demo' })
    const queued = await h.call('POST', `/tasks/${t.id}/start`, {})
    assert.equal(queued.status, 200)
    assert.equal(queued.body.queued, true)

    // 排队期间把角色改掉：已经排上的这一活仍按当时的角色执行
    await h.call('PATCH', `/roles/${r.id}`, { model: 'sonnet', context: '换过的准则' })
    const msgs = await h.executor(machine)
    const run = await waitFor(() => msgs.find(m => m.type === 'run.start'))
    assert.equal(run.model, 'opus')
    assert.match(run.instructions, /慢一点，多想一步/)
  })

  it('删掉角色后任务照常可用，只是不再指向任何角色', async () => {
    const r = await h.role({ name: uniq('临时'), agent: 'claude', model: 'opus' })
    const t = await h.task({ roleId: r.id })
    assert.equal((await h.call('DELETE', `/roles/${r.id}`)).status, 200)
    const reloaded = (await h.call('GET', '/tasks')).body.tasks.find((x: any) => x.id === t.id)
    assert.equal(reloaded.roleId, null)
    assert.equal(reloaded.agent, 'claude', '已经补上的执行工具保留')
  })

  it('不能引用别人的角色', async () => {
    const mine = await h.role({ name: uniq('我的角色'), agent: 'claude' })
    const other = await makeUser(h.pool)
    const stolen = await h.call('POST', '/tasks', { title: uniq('越权任务'), roleId: mine.id }, other.token)
    assert.equal(stolen.status, 404)
    const theirs = await h.call('GET', '/roles', undefined, other.token)
    assert.equal(theirs.body.roles.some((x: any) => x.id === mine.id), false, '别人的角色不该出现在列表里')
  })
})
