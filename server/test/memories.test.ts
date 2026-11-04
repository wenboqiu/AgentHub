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
    const msgs = await connect(`role=agent&machine=${machine}&capabilities=reply-branch-v1,role-v1`)
    await waitFor(async () => (await call('GET', '/control/status')).body.agents.includes(machine))
    return msgs
  }
  const role = async (body: Record<string, unknown>) => {
    const r = await call('POST', '/roles', body)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    return r.body.role as any
  }
  const project = async (body: Record<string, unknown>) => {
    const r = await call('POST', '/projects', body)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    return r.body.project as any
  }
  const task = async (body: Record<string, unknown>) => {
    const r = await call('POST', '/tasks', { title: uniq('任务'), ...body })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    return r.body.task as any
  }
  const memory = async (roleId: number, body: Record<string, unknown>) => {
    const r = await call('POST', `/roles/${roleId}/memories`, body)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    return r.body.memory as any
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
    call, connect, executor, role, project, task, memory,
  }
}

describe('角色记忆：员工在项目上积累的经验', () => {
  const h = harness()

  before(() => h.start())
  after(() => h.stop())

  it('增删改查；按项目筛选；同一条重复写入只加权重不堆条目', async () => {
    const r = await h.role({ name: uniq('后端'), agent: 'claude' })
    const p1 = await h.project({ name: uniq('项目甲') })
    const p2 = await h.project({ name: uniq('项目乙') })

    const general = await h.memory(r.id, { content: '提交前先跑全量测试' })
    assert.equal(general.projectId, null)
    assert.equal(general.weight, 1)
    assert.equal(general.source, 'manual')

    const scoped = await h.memory(r.id, { content: '这个项目的接口都用 camelCase', projectId: p1.id })
    assert.equal(scoped.projectId, p1.id)

    const all = (await h.call('GET', `/roles/${r.id}/memories`)).body.memories
    assert.equal(all.length, 2)
    const onlyGeneral = (await h.call('GET', `/roles/${r.id}/memories?projectId=`)).body.memories
    assert.deepEqual(onlyGeneral.map((m: any) => m.id), [general.id])
    const onlyP1 = (await h.call('GET', `/roles/${r.id}/memories?projectId=${p1.id}`)).body.memories
    assert.deepEqual(onlyP1.map((m: any) => m.id), [scoped.id])

    const again = await h.memory(r.id, { content: '提交前先跑全量测试' })
    assert.equal(again.id, general.id, '重复内容复用同一条')
    assert.equal(again.weight, 2)

    const edited = await h.call('PATCH', `/roles/${r.id}/memories/${general.id}`, { content: '提交前先跑全量测试和 tsc' })
    assert.equal(edited.status, 200)
    assert.equal(edited.body.memory.content, '提交前先跑全量测试和 tsc')
    assert.equal(edited.body.memory.weight, 2, '改内容不丢权重')

    assert.equal((await h.call('DELETE', `/roles/${r.id}/memories/${scoped.id}`)).status, 200)
    assert.equal((await h.call('DELETE', `/roles/${r.id}/memories/${scoped.id}`)).status, 404)
    assert.equal((await h.call('GET', `/roles/${r.id}/memories`)).body.memories.length, 1)
    assert.equal(p2.id > 0, true)
  })

  it('派活时把准则、项目背景和记忆一起下发；项目内的经验排在通用经验前面', async () => {
    const machine = `mem-pc-${stamp}`
    const msgs = await h.executor(machine)
    const p = await h.project({ name: uniq('注入项目'), brief: '单体服务，不要引入新依赖' })
    const r = await h.role({ name: uniq('实现'), agent: 'claude', model: 'sonnet', title: '负责服务端实现', context: '先读现有代码再动手' })
    await h.memory(r.id, { content: '跨项目经验：提交前跑测试' })
    await h.memory(r.id, { content: '这个项目专用：分页参数叫 page/size', projectId: p.id })
    const t = await h.task({ roleId: r.id, projectId: p.id, machine, cwd: 'D:\\Work2\\Mem' })

    const started = await h.call('POST', `/tasks/${t.id}/start`, {})
    assert.equal(started.status, 200, JSON.stringify(started.body))
    const run = await waitFor(() => msgs.find(m => m.type === 'run.start' && m.runId === started.body.runId))

    assert.equal(run.model, 'sonnet')
    assert.match(run.instructions, /【角色】.*负责服务端实现/)
    assert.match(run.instructions, /先读现有代码再动手/)
    assert.match(run.instructions, /【项目】.*注入项目/)
    assert.match(run.instructions, /单体服务，不要引入新依赖/)
    assert.match(run.instructions, /分页参数叫 page\/size/)
    assert.match(run.instructions, /跨项目经验：提交前跑测试/)
    assert.ok(
      run.instructions.indexOf('分页参数') < run.instructions.indexOf('跨项目经验'),
      '同一个角色的项目经验要排在通用经验前',
    )
    assert.equal(run.text, t.title, '记忆不进第一条消息')

    // 用过一次要计数，方便之后按「用得少的优先」轮换
    const used = (await h.call('GET', `/roles/${r.id}/memories`)).body.memories
    assert.equal(used.every((m: any) => m.uses === 1), true)
    assert.equal(used.every((m: any) => !!m.lastUsedAt), true)
  })

  it('没选项目时只带跨项目的通用经验', async () => {
    const machine = `mem-noProj-${stamp}`
    const msgs = await h.executor(machine)
    const p = await h.project({ name: uniq('别的项目') })
    const r = await h.role({ name: uniq('通用'), agent: 'claude' })
    await h.memory(r.id, { content: '通用经验：中文回复' })
    await h.memory(r.id, { content: '别的项目专用经验', projectId: p.id })
    const t = await h.task({ roleId: r.id, machine, cwd: 'D:\\Work2\\NoProj' })

    const started = await h.call('POST', `/tasks/${t.id}/start`, {})
    const run = await waitFor(() => msgs.find(m => m.type === 'run.start' && m.runId === started.body.runId))
    assert.match(run.instructions, /通用经验：中文回复/)
    assert.equal(run.instructions.includes('别的项目专用经验'), false)
  })

  it('验收打回的原因自动变成该员工在这个项目上的经验', async () => {
    const p = await h.project({ name: uniq('打回项目') })
    const r = await h.role({ name: uniq('被批评的'), agent: 'claude' })
    const t = await h.task({ roleId: r.id, projectId: p.id })

    const item = (await h.call('POST', `/tasks/${t.id}/review`, { title: '空状态要有提示' })).body.item
    const judged = await h.call('PATCH', `/tasks/${t.id}/review/${item.id}`, { status: 'fail', note: '列表为空时没有空状态文案' })
    assert.equal(judged.status, 200)

    const memories = (await h.call('GET', `/roles/${r.id}/memories?projectId=${p.id}`)).body.memories
    assert.equal(memories.length, 1)
    assert.equal(memories[0].content, '列表为空时没有空状态文案')
    assert.equal(memories[0].source, 'review')

    // 同一个原因再次被打回：不新增条目，只加权重
    const item2 = (await h.call('POST', `/tasks/${t.id}/review`, { title: '空状态要有提示（第二项）' })).body.item
    await h.call('PATCH', `/tasks/${t.id}/review/${item2.id}`, { status: 'fail', note: '列表为空时没有空状态文案' })
    const after = (await h.call('GET', `/roles/${r.id}/memories?projectId=${p.id}`)).body.memories
    assert.equal(after.length, 1)
    assert.equal(after[0].weight, 2)

    // 通过不产生记忆
    const item3 = (await h.call('POST', `/tasks/${t.id}/review`, { title: '接口返回 200' })).body.item
    await h.call('PATCH', `/tasks/${t.id}/review/${item3.id}`, { status: 'pass', note: '' })
    assert.equal((await h.call('GET', `/roles/${r.id}/memories?projectId=${p.id}`)).body.memories.length, 1)
  })

  it('删角色连带删记忆；删项目只删这个项目的经验，通用经验留下', async () => {
    const r = await h.role({ name: uniq('要删的'), agent: 'claude' })
    const p = await h.project({ name: uniq('要删的项目') })
    await h.memory(r.id, { content: '通用经验' })
    await h.memory(r.id, { content: '项目经验', projectId: p.id })

    assert.equal((await h.call('DELETE', `/projects/${p.id}`)).status, 200)
    const left = (await h.call('GET', `/roles/${r.id}/memories`)).body.memories
    assert.deepEqual(left.map((m: any) => m.content), ['通用经验'])

    await h.memory(r.id, { content: '另一条' })
    assert.equal((await h.call('DELETE', `/roles/${r.id}`)).status, 200)
    const rows = await h.pool.query('SELECT count(*) c FROM role_memories WHERE role_id=$1', [r.id])
    assert.equal(Number(rows.rows[0].c), 0)
  })

  it('不能读写别人的角色记忆', async () => {
    const r = await h.role({ name: uniq('我的'), agent: 'claude' })
    await h.memory(r.id, { content: '我的经验' })
    const other = await makeUser(h.pool)
    assert.equal((await h.call('GET', `/roles/${r.id}/memories`, undefined, other.token)).status, 404)
    assert.equal((await h.call('POST', `/roles/${r.id}/memories`, { content: '塞进来' }, other.token)).status, 404)
  })
})
