import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { FastifyInstance } from 'fastify'
import pg from 'pg'
import { buildApp } from '../src/index.ts'
import { DATABASE_URL, makeUser } from './helpers.ts'

let TOKEN = ''
const run = Date.now()
let n = 0
const sid = () => `t${run}-${n++}`
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString()

describe('AgentHub 服务端', () => {
  let app: FastifyInstance
  let base = ''

  async function call(method: string, path: string, body?: unknown, token: string | null = TOKEN) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    return { status: res.status, body: (text.startsWith('{') ? JSON.parse(text) : text) as any }
  }
  const ev = (sessionId: string, state: string, extra: Record<string, unknown> = {}) => ({
    agent: 'claude',
    sessionId,
    machine: 'pc',
    cwd: 'D:\\Work2\\Demo',
    state,
    at: iso(),
    ...extra,
  })
  const send = (events: unknown[]) => call('POST', '/events', { events })
  async function get(id: string) {
    const r = await call('GET', '/sessions?all=1')
    return (r.body.sessions as any[]).find(s => s.id === id)
  }

  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 })
  before(async () => {
    app = await buildApp(DATABASE_URL, 'silent', {})
    base = await app.listen({ port: 0, host: '127.0.0.1' })
    TOKEN = (await makeUser(pool)).token
  })
  after(async () => {
    await app.close()
    await pool.end()
  })

  it('/health 免鉴权，其它接口无 token 或错 token 返回 401', async () => {
    assert.equal((await call('GET', '/health', undefined, null)).status, 200)
    assert.equal((await call('GET', '/sessions', undefined, null)).status, 401)
    assert.equal((await call('GET', '/sessions', undefined, 'wrong')).status, 401)
    assert.equal((await call('GET', '/sessions', undefined, 'wrong')).body.error, '登录已过期，请重新登录')
    assert.equal((await call('GET', '/sessions', undefined, null)).body.error, '请先登录')
    assert.equal((await call('POST', '/events', { events: [] }, null)).status, 401)
  })

  it('running -> done 提醒且未处理，随后 running 自动已处理', async () => {
    const s = sid()
    const ws = new WebSocket(base.replace('http', 'ws') + `/ws?token=${TOKEN}`)
    const msgs: any[] = []
    ws.onmessage = e => msgs.push(JSON.parse(String(e.data)))
    await new Promise(r => (ws.onopen = r))
    await new Promise(r => setTimeout(r, 200))
    assert.equal(msgs[0].type, 'snapshot')

    await send([ev(s, 'running', { title: '你好', at: iso(-3000) })])
    await send([ev(s, 'done', { summary: '搞定了', at: iso(-2000) })])
    await new Promise(r => setTimeout(r, 200))
    const done = msgs.filter(m => m.type === 'session' && m.session.id === `claude:${s}`)
    assert.equal(done.length, 2)
    assert.equal(done[0].notify, false)
    assert.equal(done[1].notify, true)
    assert.equal(done[1].session.acked, false)
    assert.equal(done[1].session.project, 'Demo')
    let row = await get(`claude:${s}`)
    assert.equal(row.state, 'done')
    assert.equal(row.acked, false)
    assert.equal(row.summary, '搞定了')
    assert.equal(row.title, '你好')

    await send([ev(s, 'running', { at: iso(-1000) })])
    row = await get(`claude:${s}`)
    assert.equal(row.state, 'running')
    assert.equal(row.acked, true)
    ws.close()
  })

  it('乱序的旧事件被丢弃', async () => {
    const s = sid()
    await send([ev(s, 'done', { at: iso(-1000) })])
    const r = await send([ev(s, 'running', { at: iso(-5000) })])
    assert.equal(r.body.accepted, 0)
    assert.equal((await get(`claude:${s}`)).state, 'done')
  })

  it('Codex 改名可同步，状态核对不能覆盖新事件；Claude 首条标题不随提示词变化', async () => {
    const s=sid(), at=iso(-3000), newer=iso(-1000)
    await send([ev(s,'running',{agent:'codex',title:'首条提示',at})])
    await send([ev(s,'running',{agent:'codex',title:'Codex 显示名',at,expectedAt:at,quiet:true})])
    assert.equal((await get(`codex:${s}`)).title,'Codex 显示名')
    await send([ev(s,'running',{agent:'codex',at:newer})])
    const stale=await send([ev(s,'idle',{agent:'codex',at:iso(),expectedAt:at,quiet:true})])
    assert.equal(stale.body.accepted,0)
    assert.equal((await get(`codex:${s}`)).state,'running')
    await send([ev(s,'unknown',{agent:'codex',at:newer,expectedAt:newer,quiet:true})])
    assert.equal((await get(`codex:${s}`)).state,'unknown')
    const end=iso()
    await send([ev(s,'done',{agent:'codex',at:end})])
    await send([ev(s,'done',{agent:'codex',title:'重命名后',at:end,expectedAt:end,quiet:true})])
    assert.equal((await get(`codex:${s}`)).title,'重命名后')
    assert.equal((await get(`codex:${s}`)).acked,false)
    await send([ev(s,'running',{title:'原始标题',at})])
    await send([ev(s,'running',{title:'新一轮提示',at:newer})])
    assert.equal((await get(`claude:${s}`)).title,'原始标题')
  })

  it('quiet 不提醒，done 直接已处理', async () => {
    const s = sid()
    const ws = new WebSocket(base.replace('http', 'ws') + `/ws?token=${TOKEN}`)
    const msgs: any[] = []
    ws.onmessage = e => msgs.push(JSON.parse(String(e.data)))
    await new Promise(r => (ws.onopen = r))
    await send([ev(s, 'done', { quiet: true })])
    await new Promise(r => setTimeout(r, 200))
    const m = msgs.find(m => m.type === 'session' && m.session.id === `claude:${s}`)
    assert.equal(m.notify, false)
    assert.equal(m.session.acked, true)
    ws.close()
  })

  it('ack、ack-all 与删除', async () => {
    const a = sid()
    const b = sid()
    await send([ev(a, 'waiting', { summary: '要授权' }), ev(b, 'done')])
    assert.equal((await get(`claude:${a}`)).acked, false)
    assert.equal((await call('POST', `/sessions/${encodeURIComponent(`claude:${a}`)}/ack`)).status, 200)
    assert.equal((await get(`claude:${a}`)).acked, true)
    assert.equal((await get(`claude:${b}`)).acked, false)
    assert.equal((await call('POST', '/sessions/ack-all')).status, 200)
    assert.equal((await get(`claude:${b}`)).acked, true)
    assert.equal((await call('POST', '/sessions/claude:nope/ack')).status, 404)
    assert.equal((await call('DELETE', `/sessions/${encodeURIComponent(`claude:${a}`)}`)).status, 200)
    assert.equal(await get(`claude:${a}`), undefined)
  })

  it('默认列表隐藏 ended，all=1 才显示', async () => {
    const s = sid()
    await send([ev(s, 'ended')])
    const normal = await call('GET', '/sessions')
    assert.ok(!(normal.body.sessions as any[]).some(x => x.id === `claude:${s}`))
    assert.ok(await get(`claude:${s}`))
  })

  it('豆包事件支持状态、标题更新与提醒，拒绝远程执行和历史读取', async () => {
    const key = sid(), id = `doubao:${key}`
    const first = await send([ev(key, 'done', { agent: 'doubao', cwd: '', title: '旧标题', quiet: true })])
    assert.equal(first.status, 200)
    assert.equal((await get(id)).acked, true)
    await send([ev(key, 'running', { agent: 'doubao', cwd: '', title: '新标题' })])
    await send([ev(key, 'done', { agent: 'doubao', cwd: '' })])
    assert.equal((await get(id)).acked, false)
    assert.equal((await get(id)).title, '新标题')
    await call('POST', `/sessions/${id}/ack`)
    await send([ev(key, 'done', { agent: 'doubao', cwd: '', title: '修改标题', quiet: true })])
    assert.equal((await get(id)).acked, true)
    assert.equal((await get(id)).title, '修改标题')
    for (const [action, body] of [['messages', {text:'hello'}], ['spawn', {mode:'fresh',text:'hello'}], ['history', {}]] as const) {
      const response = await call('POST', `/sessions/${id}/${action}`, body)
      assert.equal(response.status, 409, JSON.stringify(response.body))
      assert.match(response.body.error, /豆包/)
    }
  })

  it('WorkBuddy 事件支持状态与标题，拒绝远程执行，但历史可以读', async () => {
    const key = sid(), id = `workbuddy:${key}`
    const first = await send([ev(key, 'running', { agent: 'workbuddy', cwd: 'D:\\Work2\\AgentHub', title: '分析 agenthub 能否支持 workbuddy 的消息' })])
    assert.equal(first.status, 200)
    const running = await get(id)
    assert.equal(running.state, 'running')
    assert.equal(running.title, '分析 agenthub 能否支持 workbuddy 的消息')
    assert.equal(running.project, 'AgentHub')
    await send([ev(key, 'done', { agent: 'workbuddy', cwd: 'D:\\Work2\\AgentHub', summary: '结论：可以，走只读轮询' })])
    const done = await get(id)
    assert.equal(done.state, 'done')
    assert.equal(done.acked, false, '非静默的完成要留待处理')
    assert.equal(done.summary, '结论：可以，走只读轮询')
    for (const [action, body] of [['messages', { text: 'hello' }], ['spawn', { mode: 'fresh', text: 'hello' }]] as const) {
      const response = await call('POST', `/sessions/${id}/${action}`, body)
      assert.equal(response.status, 409, JSON.stringify(response.body))
      assert.match(response.body.error, /WorkBuddy/)
    }
    // 正文在电脑端的 transcript 里，读历史和 Claude / Codex 同一条链路：只受「电脑端不在线」约束，
    // 不能再按「只读 agent」一句话拦掉，否则详情页永远停在「还没有同步到消息」。
    const history = await call('POST', `/sessions/${id}/history`, {})
    assert.equal(history.status, 409, JSON.stringify(history.body))
    assert.match(history.body.error, /电脑端不在线/)
    assert.doesNotMatch(history.body.error, /仅支持状态监听/)
  })

  it('ZCode 事件支持状态与标题，并且可以派活（不再按只读拒绝）', async () => {
    const key = sid(), id = `zcode:${key}`
    const first = await send([ev(key, 'running', { agent: 'zcode', cwd: 'D:\\Work2\\AgentHub', title: '分析 agenthub 能否支持 zcode 的消息' })])
    assert.equal(first.status, 200)
    const running = await get(id)
    assert.equal(running.state, 'running')
    assert.equal(running.title, '分析 agenthub 能否支持 zcode 的消息')
    assert.equal(running.project, 'AgentHub')
    await send([ev(key, 'done', { agent: 'zcode', cwd: 'D:\\Work2\\AgentHub', summary: '结论：可以，走 app-server' })])
    const done = await get(id)
    assert.equal(done.state, 'done')
    assert.equal(done.acked, false, '非静默的完成要留待处理')
    assert.equal(done.summary, '结论：可以，走 app-server')
    // 不再按「仅状态监听」拒绝；测试里没有执行器在线，所以落到「电脑端不在线」这一步
    for (const [action, body] of [['messages', { text: 'hello' }], ['spawn', { mode: 'fresh', text: 'hello' }], ['history', {}]] as const) {
      const response = await call('POST', `/sessions/${id}/${action}`, body)
      assert.equal(response.status, 409, JSON.stringify(response.body))
      assert.match(response.body.error, /电脑端|执行器/)
      assert.ok(!/仅支持状态监听/.test(response.body.error), `ZCode 不该再被当成只读：${response.body.error}`)
    }
    // 分叉仍然不支持，但要给出明确原因
    const fork = await call('POST', `/sessions/${id}/spawn`, { mode: 'fork', text: 'hello' })
    assert.match(fork.body.error, /暂不支持按回复分叉/)
  })

  it('非法事件返回 400', async () => {
    assert.equal((await send([{ agent: 'x' }])).status, 400)
    assert.equal((await call('POST', '/events', { events: new Array(101).fill(ev(sid(), 'idle')) })).status, 400)
  })

  it('WS 无 token 被拒绝', async () => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws?token=bad')
    const closed = await new Promise<boolean>(r => {
      ws.onerror = () => r(true)
      ws.onopen = () => r(false)
    })
    assert.equal(closed, true)
  })
})
