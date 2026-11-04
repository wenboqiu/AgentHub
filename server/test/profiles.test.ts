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
  const executor = async (machine: string) => {
    const msgs = await connect(`role=agent&machine=${machine}`)
    await waitFor(async () => (await call('GET', '/control/status')).body.agents.includes(machine))
    return msgs
  }
  const profile = async (body: Record<string, unknown>) => {
    const r = await call('POST', '/profiles', body)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    return r.body.profile as any
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
    call, connect, executor, profile, task,
  }
}

describe('项目配置：执行环境 + 检查项模板', () => {
  const h = harness()

  before(() => h.start())
  after(() => h.stop())

  it('增删改查；同名配置直接拒绝', async () => {
    const p = await h.profile({ name: uniq('前端'), agent: 'claude', machine: 'pc-a', cwd: 'D:\\Work2\\AgentHub', priority: 'high', checklist: ['tsc 通过', 'build 通过'] })
    assert.equal(p.name.startsWith('前端'), true)
    assert.deepEqual(p.checklist, ['tsc 通过', 'build 通过'])
    assert.equal(p.tasks, 0)

    assert.equal((await h.call('POST', '/profiles', { name: p.name })).status, 409)

    const updated = await h.call('PATCH', `/profiles/${p.id}`, { machine: 'pc-b', checklist: ['tsc 通过'] })
    assert.equal(updated.status, 200)
    assert.equal(updated.body.profile.machine, 'pc-b')
    assert.deepEqual(updated.body.profile.checklist, ['tsc 通过'])
    assert.equal(updated.body.profile.name, p.name, '没传的字段不该被清空')

    assert.equal((await h.call('POST', '/profiles', { name: uniq('重复项'), checklist: ['同一项', '同一项'] })).status, 400)
    assert.equal((await h.call('DELETE', `/profiles/${p.id}`)).status, 200)
    assert.equal((await h.call('PATCH', `/profiles/${p.id}`, { name: uniq('没了') })).status, 404)
    assert.equal((await h.call('GET', '/profiles')).body.profiles.some((x: any) => x.id === p.id), false)
  })

  it('建任务时套用配置：补齐空着的工具 / 电脑 / 目录，模板变成检查项', async () => {
    const p = await h.profile({ name: uniq('后端'), agent: 'codex', machine: 'pc-srv', cwd: 'D:\\Work2\\Api', priority: 'high', checklist: ['全量测试绿', '接口手测一遍'] })
    const t = await h.task({ profileId: p.id })
    assert.equal(t.profileId, p.id)
    assert.equal(t.agent, 'codex')
    assert.equal(t.machine, 'pc-srv')
    assert.equal(t.cwd, 'D:\\Work2\\Api')
    assert.equal(t.priority, 'high', '没显式指定优先级时跟随配置')
    assert.deepEqual(t.checklist.map((i: any) => i.text), ['全量测试绿', '接口手测一遍'])
    assert.ok(t.checklist.every((i: any) => i.id.startsWith('tpl-') && i.done === false))

    // 清单会自动同步成验收检查项
    const review = await h.call('GET', `/tasks/${t.id}/review`)
    assert.equal(review.status, 200)
    assert.deepEqual(review.body.items.map((i: any) => i.title), ['全量测试绿', '接口手测一遍'])
    assert.ok(review.body.items.every((i: any) => i.status === 'pending'))
  })

  it('显式填的字段不会被配置覆盖', async () => {
    const p = await h.profile({ name: uniq('覆盖'), agent: 'claude', machine: 'pc-x', cwd: 'D:\\Work2\\X', priority: 'high' })
    const t = await h.task({ profileId: p.id, agent: 'codex', machine: 'pc-y', cwd: 'D:\\Work2\\Y', priority: 'low' })
    assert.equal(t.agent, 'codex')
    assert.equal(t.machine, 'pc-y')
    assert.equal(t.cwd, 'D:\\Work2\\Y')
    assert.equal(t.priority, 'low')
  })

  it('换配置：未勾选的模板项跟着换掉，已勾选的和手工项保留', async () => {
    const a = await h.profile({ name: uniq('A'), checklist: ['A-1', 'A-2'] })
    const b = await h.profile({ name: uniq('B'), checklist: ['B-1'] })
    const t = await h.task({ profileId: a.id })
    const kept = t.checklist[0]
    // 勾掉 A-1（等同于验收通过），再加一条手工清单项
    const edited = await h.call('PATCH', `/tasks/${t.id}`, {
      checklist: [{ ...kept, done: true }, { id: 'manual-1', text: '手工补的', done: false }, t.checklist[1]],
    })
    assert.equal(edited.status, 200)

    const switched = await h.call('PATCH', `/tasks/${t.id}`, { profileId: b.id })
    assert.equal(switched.status, 200)
    const texts = switched.body.task.checklist.map((i: any) => i.text)
    assert.deepEqual(texts, ['A-1', '手工补的', 'B-1'], '已勾选的 A-1 与手工项留下，未勾选的 A-2 换成了 B-1')
    assert.equal(switched.body.task.profileId, b.id)
  })

  it('删掉配置后任务照常可用，只是不再指向任何配置', async () => {
    const p = await h.profile({ name: uniq('临时'), agent: 'claude', machine: 'pc-t', cwd: 'D:\\Work2\\T' })
    const t = await h.task({ profileId: p.id })
    assert.equal((await h.call('DELETE', `/profiles/${p.id}`)).status, 200)
    const reloaded = (await h.call('GET', '/tasks')).body.tasks.find((x: any) => x.id === t.id)
    assert.equal(reloaded.profileId, null)
    assert.equal(reloaded.agent, 'claude', '执行字段保留')
    assert.equal(reloaded.cwd, 'D:\\Work2\\T')
  })

  it('不能引用别人的配置', async () => {
    const mine = await h.profile({ name: uniq('我的'), agent: 'claude' })
    const other = await makeUser(h.pool)
    const stolen = await h.call('POST', '/tasks', { title: uniq('越权任务'), profileId: mine.id }, other.token)
    assert.equal(stolen.status, 404)
    const theirs = await h.call('GET', '/profiles', undefined, other.token)
    assert.equal(theirs.body.profiles.some((x: any) => x.id === mine.id), false, '别人的配置不该出现在列表里')
  })

  it('派活时用配置兜底目录与工具', async () => {
    const p = await h.profile({ name: uniq('派活'), agent: 'claude', cwd: 'D:\\Work2\\FromProfile' })
    // 先建一个没有 agent / cwd 的任务，再挂上配置：记录链接但字段仍空
    const t = await h.task({ profileId: p.id })
    const cleared = await h.call('PATCH', `/tasks/${t.id}`, { agent: null, cwd: null })
    assert.equal(cleared.status, 200)
    assert.equal(cleared.body.task.cwd, null)

    const msgs = await h.executor(`pc-${stamp}`)
    const started = await h.call('POST', `/tasks/${t.id}/start`, { machine: `pc-${stamp}` })
    assert.equal(started.status, 200, JSON.stringify(started.body))
    const run = await waitFor(() => msgs.find(m => m.type === 'run.start'))
    assert.equal(run.cwd, 'D:\\Work2\\FromProfile', '目录从配置兜底')
    assert.equal(run.agent, 'claude')
  })
})
