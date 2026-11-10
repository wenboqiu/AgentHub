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
  const executor = async (machine: string, agents?: string) => {
    const msgs = await connect(`role=agent&machine=${machine}&capabilities=reply-branch-v1,role-v1${agents ? `&agents=${agents}` : ''}`)
    await waitFor(async () => (await call('GET', '/control/status')).body.agents.includes(machine))
    return msgs
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
    call, connect, executor, project, task,
  }
}

describe('项目：一个代码库的身份与背景知识', () => {
  const h = harness()

  before(() => h.start())
  after(() => h.stop())

  it('增删改查；同名拒绝，说明可以留空', async () => {
    const p = await h.project({ name: uniq('AgentHub'), brief: 'Fastify + Postgres，改完要跑 tsc' })
    assert.equal(p.name.startsWith('AgentHub'), true)
    assert.equal(p.brief, 'Fastify + Postgres，改完要跑 tsc')
    assert.deepEqual(p.dirs, [])
    assert.equal(p.tasks, 0)

    assert.equal((await h.call('POST', '/projects', { name: p.name })).status, 409)

    const updated = await h.call('PATCH', `/projects/${p.id}`, { brief: '换过的说明' })
    assert.equal(updated.status, 200)
    assert.equal(updated.body.project.brief, '换过的说明')

    const blank = await h.project({ name: uniq('空说明'), brief: '' })
    assert.equal(blank.brief, '')

    const one = await h.call('GET', `/projects/${p.id}`)
    assert.equal(one.body.project.id, p.id)
    assert.equal((await h.call('DELETE', `/projects/${p.id}`)).status, 200)
    assert.equal((await h.call('GET', `/projects/${p.id}`)).status, 404)
    assert.equal((await h.call('GET', '/projects')).body.projects.some((x: any) => x.id === p.id), false)
  })

  it('任务挂项目；项目删掉后任务回到未归属，其他字段不动', async () => {
    const p = await h.project({ name: uniq('待删项目') })
    const t = await h.task({ projectId: p.id, cwd: 'D:\\Work2\\Keep' })
    assert.equal(t.projectId, p.id)
    assert.equal(p.tasks === 0, true, '建任务时项目计数是入参时刻的，不要求实时')

    const listed = (await h.call('GET', '/projects')).body.projects.find((x: any) => x.id === p.id)
    assert.equal(listed.tasks, 1)

    assert.equal((await h.call('DELETE', `/projects/${p.id}`)).status, 200)
    const reloaded = (await h.call('GET', '/tasks')).body.tasks.find((x: any) => x.id === t.id)
    assert.equal(reloaded.projectId, null)
    assert.equal(reloaded.cwd, 'D:\\Work2\\Keep', '已填的执行字段保留')
  })

  it('项目目录在派活时兜底：任务没填目录也能按机器定下来', async () => {
    const machine = `proj-pc-${stamp}`
    const msgs = await h.executor(machine)
    const p = await h.project({
      name: uniq('带目录的项目'),
      brief: '这个项目只跑 Node',
      dirs: [{ machine, cwd: 'D:\\Work2\\ProjApp' }],
    })
    const t = await h.task({ projectId: p.id, agent: 'claude' })
    // 建任务时项目不落目录：留到派发时按机器挑，才不会把任务钉在某台电脑上
    assert.equal(t.machine, null)
    assert.equal(t.cwd, null)
    const started = await h.call('POST', `/tasks/${t.id}/start`, {})
    assert.equal(started.status, 200, JSON.stringify(started.body))
    const run = await waitFor(() => msgs.find(m => m.type === 'run.start' && m.runId === started.body.runId))
    assert.equal(run.cwd, 'D:\\Work2\\ProjApp')
    assert.match(run.instructions, /这个项目只跑 Node/, '项目背景随派活下发')
  })

  it('项目没登记目录又没给目录：派活要人「去补目录」，而不是报字段格式', async () => {
    await h.executor(`proj-empty-${stamp}`)
    const p = await h.project({ name: uniq('无目录项目') })
    const t = await h.task({ projectId: p.id, agent: 'claude' })
    const started = await h.call('POST', `/tasks/${t.id}/start`, {})
    assert.equal(started.status, 409, JSON.stringify(started.body))
    assert.match(started.body.error, /还没登记目录/, started.body.error)
    assert.match(started.body.error, new RegExp(p.name), '得点名是哪个项目，人才知道去哪补')
    // 没派出去的任务留在待办：补好目录再点一次就行
    const reloaded = (await h.call('GET', '/tasks')).body.tasks.find((x: any) => x.id === t.id)
    assert.equal(reloaded.status, 'todo')
  })

  it('一个项目存多台电脑的目录：派活按这次要去的机器挑对应那条', async () => {
    const pcA = `proj-a-${stamp}`
    const pcB = `proj-b-${stamp}`
    await h.executor(pcA)
    const msgsB = await h.executor(pcB)
    const p = await h.project({
      name: uniq('多设备项目'),
      dirs: [
        { machine: pcA, cwd: 'D:\\Work2\\MultiA' },
        { machine: pcB, cwd: '/Users/wenbo/MultiA' },
      ],
    })
    assert.deepEqual(p.dirs.map((d: any) => d.machine), [pcA, pcB])

    const t = await h.task({ projectId: p.id, agent: 'claude' })
    assert.equal(t.cwd, null)

    // 指到 B 电脑派活：用 B 那条的目录，不是第一条的
    const started = await h.call('POST', `/tasks/${t.id}/start`, { machine: pcB })
    assert.equal(started.status, 200, JSON.stringify(started.body))
    const run = await waitFor(() => msgsB.find(m => m.type === 'run.start' && m.runId === started.body.runId))
    assert.equal(run.cwd, '/Users/wenbo/MultiA')

    // 已经填了目录（比如在 A 电脑上派过）就不再被项目目录覆盖
    const pinned = await h.task({ projectId: p.id, agent: 'claude', machine: pcA, cwd: 'D:\\Work2\\SelfPick' })
    assert.equal(pinned.cwd, 'D:\\Work2\\SelfPick')
  })

  it('目录列表校验：同一台电脑只能有一条、目录必填', async () => {
    const mine = await h.project({ name: uniq('目录校验项目') })
    const dup = await h.call('PATCH', `/projects/${mine.id}`, {
      dirs: [{ machine: 'pc-x', cwd: 'D:\\A' }, { machine: 'pc-x', cwd: 'D:\\B' }],
    })
    assert.equal(dup.status, 400)
    const noCwd = await h.call('PATCH', `/projects/${mine.id}`, { dirs: [{ machine: 'pc-x', cwd: '' }] })
    assert.equal(noCwd.status, 400)
    // 不绑机器的目录也只允许一条
    const dupAny = await h.call('PATCH', `/projects/${mine.id}`, {
      dirs: [{ machine: null, cwd: 'D:\\A' }, { machine: null, cwd: 'D:\\B' }],
    })
    assert.equal(dupAny.status, 400)
    const ok = await h.call('PATCH', `/projects/${mine.id}`, {
      dirs: [{ machine: null, cwd: 'D:\\通用' }, { machine: 'pc-x', cwd: 'D:\\A' }],
    })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.project.dirs.length, 2)
  })

  it('可选电脑清单：在线的排前面，用过的离线机器也列出来', async () => {
    const pc = `mach-on-${stamp}`
    await h.executor(pc)
    // 离线机器：只在项目配置里手填过，从没连上来过
    const offName = `mach-off-${stamp}`
    await h.project({ name: uniq('清单项目'), dirs: [{ machine: offName, cwd: 'D:\\Off' }] })

    const ms = (await h.call('GET', '/machines')).body.machines as { name: string; online: boolean; at: string | null }[]
    const on = ms.find(m => m.name === pc)
    assert.ok(on, '在线机器在清单里')
    assert.equal(on.online, true)
    const off = ms.find(m => m.name === offName)
    assert.ok(off, '配置里手填的离线机器也在')
    assert.equal(off.online, false)
    assert.ok(ms.findIndex(m => m.name === pc) < ms.findIndex(m => m.name === offName), '在线的排前面')

    // 别人看不见我的机器
    const other = await makeUser(h.pool)
    assert.equal((await h.call('GET', '/machines', undefined, other.token)).body.machines.some((m: any) => m.name === pc), false)
  })

  it('开着 AgentHub 但没开远程执行：显示「连着、不接活」，派活不选它；打开开关后转成在线', async () => {
    const pc = `listen-pc-${stamp}`
    await h.connect(`role=agent&machine=${pc}&capabilities=reply-branch-v1,role-v1&agents=claude&exec=off`)
    const machine = async () => {
      for (let i = 0; i < 200; i++) {
        const m = ((await h.call('GET', '/machines')).body.machines as any[]).find(x => x.name === pc)
        if (m) return m
        await new Promise(r => setTimeout(r, 10))
      }
      throw new Error('清单里没有这台')
    }
    const m = await machine()
    assert.equal(m.online, false)
    assert.equal(m.listening, true)
    assert.deepEqual(m.agents, ['claude'], '工具清单照样上报')
    assert.equal((await h.call('GET', '/control/status')).body.agents.includes(pc), false, '不算能接活的在线电脑')
    // 往它上面派活：当离线处理（排队），不会真发过去
    const t = await h.task({ agent: 'claude', machine: pc, cwd: 'D:\\Listen' })
    const r = await h.call('POST', `/tasks/${t.id}/start`, {})
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.queued, true, JSON.stringify(r.body))

    // 打开远程执行：同一台电脑用 exec 连上来，顶掉不接活的那条，排队的单投递过来
    const msgs = await h.executor(pc, 'claude')
    const on = await machine()
    assert.equal(on.online, true)
    assert.equal(on.listening, false)
    await waitFor(() => msgs.some(x => x.type === 'run.start'))
  })

  it('电脑上报装了哪些工具；没上报过的老电脑不判成不支持', async () => {
    const pc = `caps-pc-${stamp}`
    const old = `caps-old-${stamp}`
    await h.executor(pc, 'claude,zcode')
    await h.executor(old) // 老客户端：不带 agents

    const ms = (await h.call('GET', '/machines')).body.machines as { name: string; online: boolean; agents: string[] }[]
    assert.deepEqual(ms.find(m => m.name === pc)?.agents, ['claude', 'zcode'])
    assert.deepEqual(ms.find(m => m.name === old)?.agents, [], '没上报过 = 不知道')

    // 明确没装这个工具就别派了，排到天亮也跑不起来
    const p = await h.project({ name: uniq('能力项目'), dirs: [{ machine: pc, cwd: 'D:\\Work2\\Caps' }] })
    const role = (await h.call('POST', '/roles', { name: uniq('Codex 角色'), title: '写代码', agent: 'codex' })).body.role
    const t = await h.task({ projectId: p.id, roleId: role.id, agent: 'codex', machine: pc, cwd: 'D:\\Work2\\Caps' })
    const refused = await h.call('POST', `/tasks/${t.id}/start`, {})
    assert.equal(refused.status, 409, JSON.stringify(refused.body))
    assert.match(String(refused.body.error), /没装 codex/)

    // 换成年久失修的机器（没上报）照旧放行，交给执行器自己报错
    const t2 = await h.task({ projectId: p.id, agent: 'codex', machine: old, cwd: 'D:\\Work2\\Caps' })
    const ok = await h.call('POST', `/tasks/${t2.id}/start`, {})
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
  })
  it('电脑改名：旧名下的会话与项目目录一起挪到新名，旧名不再出现在清单里', async () => {
    const oldName = `old-pc-${stamp}`
    const newName = `new-pc-${stamp}`
    // 服务端存的 id 是「agent:sessionId」，这里的 sessionId 不用自己带前缀
    const sid = `claude:rename-${stamp}`
    const rawSid = `rename-${stamp}`
    const sent = await h.call('POST', '/events', {
      events: [{ agent: 'claude', sessionId: rawSid, machine: oldName, cwd: 'D:\\Work2\\Rename', state: 'done', at: new Date().toISOString() }],
    })
    assert.equal(sent.status, 200, JSON.stringify(sent.body))
    const p = await h.project({
      name: uniq('改名项目'),
      dirs: [{ machine: oldName, cwd: 'D:\\Work2\\Old' }, { machine: null, cwd: 'D:\\通用' }],
    })

    const renamed = await h.call('POST', '/machines/rename', { from: oldName, to: newName })
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body))
    assert.equal(renamed.body.sessions >= 1, true, '会话跟着改名')
    assert.equal(renamed.body.projects, 1, '项目目录跟着改名')

    const session = (await h.call('GET', '/sessions?all=1')).body.sessions.find((s: any) => s.id === sid)
    assert.equal(session.machine, newName)
    const proj = (await h.call('GET', '/projects')).body.projects.find((x: any) => x.id === p.id)
    assert.deepEqual(proj.dirs.map((d: any) => d.machine), [newName, null])

    const names = (await h.call('GET', '/machines')).body.machines.map((m: any) => m.name)
    assert.equal(names.includes(oldName), false, '旧名从清单里消失')
    assert.equal(names.includes(newName), true)

    // 名字没变就不用改
    assert.equal((await h.call('POST', '/machines/rename', { from: newName, to: newName })).status, 400)
  })

  it('不能引用别人的项目', async () => {
    const mine = await h.project({ name: uniq('我的项目') })
    const other = await makeUser(h.pool)
    const stolen = await h.call('POST', '/tasks', { title: uniq('越权'), projectId: mine.id }, other.token)
    assert.equal(stolen.status, 404)
    assert.equal((await h.call('GET', '/projects', undefined, other.token)).body.projects.some((x: any) => x.id === mine.id), false)
  })
})
