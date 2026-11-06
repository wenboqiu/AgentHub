import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/index.ts'
import { createPool } from '../src/db.ts'
import { CONTRACT, MAX_DRAFT_CONTEXT, followupMessage, openingMessage, parseDraft } from '../src/assistant.ts'
import { DATABASE_URL, makeUser } from './helpers.ts'

const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const uniq = (p: string) => `${p}-${stamp}`
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

// 一份合格的 agent 回复：前半段废话 + 代码块，验证解析能挑出 JSON
const reply = (fields: Record<string, unknown>) => `好的，我整理成草稿了：\n\n\`\`\`json\n${JSON.stringify(fields, null, 2)}\n\`\`\`\n\n要不要再改改？`

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
  const executor = async (machine: string) => {
    const ws = new WebSocket(base.replace('http', 'ws') + `/ws?token=${token}&role=agent&machine=${machine}&${CAPS}`)
    const msgs: any[] = []
    ws.onmessage = e => msgs.push(JSON.parse(String(e.data)))
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('ws error')) })
    sockets.push(ws)
    await waitFor(async () => (await call('GET', '/control/status')).body.agents.includes(machine))
    return { msgs, send: (m: unknown) => ws.send(JSON.stringify(m)) }
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
    call, executor,
  }
}

describe('角色助手：草稿解析（纯函数，不碰库）', () => {
  it('代码块、裸 JSON、带前言的 JSON 都能挑出来', () => {
    const fields = { name: '前端实现', title: '只改前端', agent: 'codex', model: 'gpt-6.1-sol', context: '改完跑 tsc', tools: ['Read', 'Edit'] }
    for (const raw of [reply(fields), JSON.stringify(fields), `我明白了。\n${JSON.stringify(fields)}\n就这样。`]) {
      const draft = parseDraft(raw)
      assert.equal(draft?.name, '前端实现')
      assert.equal(draft?.agent, 'codex')
      assert.equal(draft?.model, 'gpt-6.1-sol')
      assert.deepEqual(draft?.tools, ['Read', 'Edit'])
    }
  })

  it('没有 JSON、没有名字、JSON 坏了都返回 null（宁可没草稿也不猜）', () => {
    assert.equal(parseDraft('这个角色应该叫前端实现，用 Codex。'), null)
    assert.equal(parseDraft('```json\n{"title":"只改前端"}\n```'), null)
    assert.equal(parseDraft('```json\n{"name": "前端实现",}\n```'), null)
    assert.equal(parseDraft('```json\n{"name":"   "}\n```'), null)
    assert.equal(parseDraft(''), null)
  })

  it('字段清洗：非法 agent 归 null、工具去重限量、编号认字符串、上下文截断', () => {
    const draft = parseDraft(JSON.stringify({
      name: 'x'.repeat(80),
      title: 'y'.repeat(200),
      agent: 'doubao',
      model: '',
      context: 'z'.repeat(MAX_DRAFT_CONTEXT + 500),
      tools: ['Read', 'Read', ' Edit ', 42, ''],
      note: 'n'.repeat(800),
    }))
    assert.equal(draft?.name.length, 60)
    assert.equal(draft?.title.length, 120)
    assert.equal(draft?.agent, null, '豆包不能派活，不能当成角色执行工具')
    assert.equal(draft?.model, null)
    assert.equal(draft?.context.length, MAX_DRAFT_CONTEXT)
    assert.deepEqual(draft?.tools, ['Read', 'Edit'])
    assert.equal(draft?.note.length, 500)
  })

  it('首条消息带契约与防重名清单；追问只补一句提醒', () => {
    const open = openingMessage({
      request: '要个前端实现',
      roles: [{ name: '评审', title: '只看 diff' }, { name: '无名' }],
    })
    assert.ok(open.includes(CONTRACT))
    assert.ok(open.includes('评审（只看 diff）') && open.includes('无名'))
    assert.ok(open.endsWith('【用户需求】要个前端实现'))
    assert.ok(followupMessage('改名成 前端').includes('只回那个 JSON'))
  })
})

describe('角色助手：派活出草稿，确认才建角色', () => {
  const h = harness()

  before(() => h.start())
  after(() => h.stop())

  it('电脑不在线直接拒绝，不留下半条 thread', async () => {
    const r = await h.call('POST', '/assistant/start', { agent: 'claude', machine: uniq('offline'), cwd: 'D:\\Work2\\Demo', text: '要个前端' })
    assert.equal(r.status, 409)
    assert.equal((await h.call('GET', '/assistant')).body.thread, null)
  })

  it('一句话 → agent 回 JSON → 草稿 → 确认建角色', async () => {
    const machine = uniq('assist')
    const exec = await h.executor(machine)

    const started = await h.call('POST', '/assistant/start', { agent: 'claude', machine, cwd: 'D:\\Work2\\Demo', text: '要个负责前端实现的人' })
    assert.equal(started.status, 200, JSON.stringify(started.body))
    const runId = started.body.runId

    const begin = await waitFor(() => exec.msgs.find(m => m.type === 'run.start' && m.runId === runId))
    assert.equal(begin.agent, 'claude')
    assert.equal(begin.mode, 'fresh')
    assert.ok(begin.text.includes(CONTRACT), '契约要随首条消息下发')
    assert.ok(begin.text.includes('【用户需求】要个负责前端实现的人'))

    // 会话拿真实 id，再看记录里存的用户消息：只留原话，不把契约塞进对话
    exec.send({ type: 'run.session', runId, sessionKey: `sess-${stamp}` })
    const state = await waitFor(async () => {
      const s = await h.call('GET', '/assistant')
      return s.body.thread?.sessionId ? s.body : null
    })
    assert.equal(state.messages[0].text, '要个负责前端实现的人')
    assert.equal(state.pending, true)
    assert.equal(state.drafts.length, 0)

    exec.send({
      type: 'run.message', runId, role: 'assistant',
      text: reply({ name: uniq('前端实现'), title: '负责前端页面与交互', agent: 'codex', model: 'gpt-6.1-sol', context: '动手前先读现有写法，改完跑 tsc', tools: ['Read', 'Edit', 'Bash'], note: '没提验收标准，先按 tsc 通过算' }),
    })
    const withDraft = await waitFor(async () => {
      const s = await h.call('GET', '/assistant')
      return s.body.drafts.length ? s.body : null
    })
    const draft = withDraft.drafts[0]
    assert.equal(draft.status, 'pending')
    assert.equal(draft.draft.agent, 'codex')
    assert.equal(draft.draft.note.includes('验收标准'), true)
    assert.equal(draft.messageId, withDraft.messages.find((m: any) => m.role === 'assistant').id)

    // 确认时用户改过的字段优先
    const renamed = uniq('前端')
    const made = await h.call('POST', `/assistant/drafts/${draft.id}/confirm`, { name: renamed })
    assert.equal(made.status, 200, JSON.stringify(made.body))
    assert.equal(made.body.role.name, renamed)
    assert.equal(made.body.role.agent, 'codex')
    assert.equal(made.body.role.model, 'gpt-6.1-sol')
    assert.deepEqual(made.body.role.tools, ['Read', 'Edit', 'Bash'])
    assert.equal(made.body.draft.status, 'created')
    assert.equal(made.body.draft.roleId, made.body.role.id)
    assert.ok((await h.call('GET', '/roles')).body.roles.some((r: any) => r.id === made.body.role.id))

    assert.equal((await h.call('POST', `/assistant/drafts/${draft.id}/confirm`, {})).status, 409, '不能重复创建')
    assert.equal((await h.call('POST', '/assistant/drafts/99999999/discard')).status, 404)
  })

  it('追问走同一条会话续聊，仍只回原话；丢弃的草稿不能再确认', async () => {
    const machine = uniq('assist2')
    const exec = await h.executor(machine)

    const started = await h.call('POST', '/assistant/start', { agent: 'codex', machine, cwd: 'D:\\Work2\\Demo', text: '来个人做代码评审' })
    assert.equal(started.status, 200, JSON.stringify(started.body))
    assert.equal(started.body.thread.agent, 'codex')
    const first = await waitFor(() => exec.msgs.find(m => m.type === 'run.start' && m.runId === started.body.runId))
    exec.send({ type: 'run.session', runId: first.runId, sessionKey: `sess2-${stamp}` })
    const state = await waitFor(async () => {
      const s = await h.call('GET', '/assistant')
      return s.body.thread?.sessionId ? s.body : null
    })

    // 上一轮还没结束：不许再发
    assert.equal(state.pending, true)

    exec.send({ type: 'run.message', runId: first.runId, role: 'assistant', text: reply({ name: uniq('评审'), title: '只看 diff', agent: 'codex' }) })
    const drafted = await waitFor(async () => {
      const s = await h.call('GET', '/assistant')
      return s.body.drafts.length ? s.body : null
    })
    exec.send({ type: 'run.status', runId: first.runId, status: 'done' })
    await waitFor(async () => (await h.call('GET', '/assistant')).body.pending === false)

    const reply2 = await h.call('POST', '/assistant/reply', { text: '名字改成 代码评审' })
    assert.equal(reply2.status, 200, JSON.stringify(reply2.body))
    const next = await waitFor(() => exec.msgs.find(m => m.type === 'run.start' && m.runId === reply2.body.runId))
    assert.equal(next.mode, 'resume')
    assert.equal(next.sessionId, drafted.thread.sessionId)
    assert.ok(next.text.includes('【用户需求】名字改成 代码评审'))

    const after = await waitFor(async () => {
      const s = await h.call('GET', '/assistant')
      return s.body.messages.some((m: any) => m.text === '名字改成 代码评审') ? s.body : null
    })
    assert.equal(after.messages.filter((m: any) => m.role === 'user').length, 2)

    const d = drafted.drafts[0]
    assert.equal((await h.call('POST', `/assistant/drafts/${d.id}/discard`)).status, 200)
    assert.equal((await h.call('POST', `/assistant/drafts/${d.id}/confirm`, {})).status, 409)
    const finalState = (await h.call('GET', '/assistant')).body
    assert.equal(finalState.drafts.find((x: any) => x.id === d.id).status, 'discarded')

    // 重开：thread 与草稿一起清掉
    assert.equal((await h.call('POST', '/assistant/reset', {})).status, 200)
    const cleared = (await h.call('GET', '/assistant')).body
    assert.equal(cleared.thread, null)
    assert.equal(cleared.drafts.length, 0)
    assert.equal(cleared.messages.length, 0)
  })

  it('别的账号看不到也动不了我的草稿', async () => {
    const machine = uniq('assist3')
    const exec = await h.executor(machine)
    const started = await h.call('POST', '/assistant/start', { agent: 'claude', machine, cwd: 'D:\\Work2\\Demo', text: '要个懂数据库的' })
    const begin = await waitFor(() => exec.msgs.find(m => m.type === 'run.start' && m.runId === started.body.runId))
    exec.send({ type: 'run.message', runId: begin.runId, role: 'assistant', text: reply({ name: uniq('DBA'), title: '管迁移' }) })
    const mine = await waitFor(async () => {
      const s = await h.call('GET', '/assistant')
      return s.body.drafts.length ? s.body.drafts[0] : null
    })

    const other = (await makeUser(h.pool)).token
    assert.equal((await h.call('GET', '/assistant', undefined, other)).body.thread, null)
    assert.equal((await h.call('POST', `/assistant/drafts/${mine.id}/confirm`, {}, other)).status, 404)
    assert.equal((await h.call('POST', `/assistant/drafts/${mine.id}/discard`, {}, other)).status, 404)
  })
})
