import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { FastifyInstance } from 'fastify'
import pg from 'pg'
import { buildApp } from '../src/index.ts'
import { expirePending } from '../src/db.ts'
import { DATABASE_URL, makeUser } from './helpers.ts'

let TOKEN = ''
let USER_ID = 0
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
    const u = await makeUser(pool)
    TOKEN = u.token
    USER_ID = u.id
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

  it('完成态挂太久自动转入已处理；waiting 与新完成的不受影响', async () => {
    const old1 = sid(), old2 = sid(), fresh = sid(), waiting = sid()
    await send([
      ev(old1, 'running', { at: iso(-9000) }), ev(old1, 'done', { at: iso(-8000) }),
      ev(old2, 'running', { at: iso(-9000) }), ev(old2, 'aborted', { at: iso(-8000) }),
      ev(fresh, 'running', { at: iso(-3000) }), ev(fresh, 'done', { at: iso(-2000) }),
      ev(waiting, 'waiting', { at: iso(-8000) }),
    ])
    // 把 old1/old2/waiting 的状态起点拨回 3 小时前（waiting 用来验证它不过期）
    await pool.query(
      `UPDATE sessions SET state_since = now() - interval '3 hours'
       WHERE user_id = $1 AND id = ANY($2)`,
      [USER_ID, [`claude:${old1}`, `claude:${old2}`, `claude:${waiting}`]],
    )
    const expired = await expirePending(pool, 2 * 60 * 60_000)
    const ids = expired.map(e => e.session.id)
    assert.ok(ids.includes(`claude:${old1}`) && ids.includes(`claude:${old2}`))
    assert.ok(!ids.includes(`claude:${fresh}`) && !ids.includes(`claude:${waiting}`))
    assert.equal((await get(`claude:${old1}`)).acked, true)
    assert.equal((await get(`claude:${old2}`)).acked, true)
    assert.equal((await get(`claude:${fresh}`)).acked, false)
    assert.equal((await get(`claude:${waiting}`)).acked, false)
  })

  it('乱序的旧事件被丢弃', async () => {    const s = sid()
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

  it('Codex 改名不受采集器并发推进事件版本影响，且不改状态与事件时间', async () => {
    const s = sid(), at = iso(-5000), newer = iso(-1000)
    await send([ev(s, 'done', { agent: 'codex', title: '原名', at })])
    // 本机核对读到的是旧版本；期间采集器推来新的完成事件，expectedAt 已经不匹配
    await send([ev(s, 'done', { agent: 'codex', at: newer })])
    const r = await send([ev(s, 'done', { agent: 'codex', title: '调试复盘', at, expectedAt: at, quiet: true })])
    assert.equal(r.body.accepted, 1)
    const got = await get(`codex:${s}`)
    assert.equal(got.title, '调试复盘')
    assert.equal(got.state, 'done')
    assert.equal(Date.parse(got.eventAt), Date.parse(newer))
    assert.equal(got.acked, false)
    // 同名时不再写库，也不制造重复广播
    const again = await send([ev(s, 'done', { agent: 'codex', title: '调试复盘', at, expectedAt: at, quiet: true })])
    assert.equal(again.body.accepted, 0)
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

  it('默认列表隐藏 ended，all=1 才显示，单查接口还能拿到', async () => {
    const s = sid()
    await send([ev(s, 'ended')])
    const normal = await call('GET', '/sessions')
    assert.ok(!(normal.body.sessions as any[]).some(x => x.id === `claude:${s}`))
    assert.ok(await get(`claude:${s}`))
    // 快照里没有的会话（已结束 / 超过 24 小时）可以按 id 补查：任务详情靠这个才点得开
    const one = await call('GET', `/sessions/${encodeURIComponent(`claude:${s}`)}`)
    assert.equal(one.status, 200)
    assert.equal(one.body.session.state, 'ended')
    assert.equal((await call('GET', '/sessions/claude:nope')).status, 404)
    assert.equal((await call('GET', `/sessions/${encodeURIComponent(`claude:${s}`)}`, undefined, null)).status, 401)
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

  it('内部会话的标题由服务端钉住，不被本机 transcript 的契约原文顶掉', async () => {
    const key = sid(), id = `codebuddy:${key}`
    await send([ev(key, 'running', { agent: 'codebuddy', at: iso(-3000), title: '意见细化：把会话列表里的提示词原文收起来' })])
    assert.equal((await get(id)).title, '意见细化：把会话列表里的提示词原文收起来')
    // 电脑端报上来的标题是「首条用户消息截 40 字」，而这类会话的首条正是 AgentHub 写的契约：不许覆盖
    await send([ev(key, 'done', {
      agent: 'codebuddy', at: iso(-2000),
      title: '你在 AgentHub 里当项目经理，读完一段刚结束的会话，写一张能直接开工的任',
    })])
    const done = await get(id)
    assert.equal(done.state, 'done')
    assert.equal(done.title, '意见细化：把会话列表里的提示词原文收起来')
    // 普通的活照旧跟着 transcript 走，这条规矩不能外溢
    const plain = sid()
    await send([ev(plain, 'running', { agent: 'codebuddy', at: iso(-3000), title: '第一句' })])
    await send([ev(plain, 'done', { agent: 'codebuddy', at: iso(-2000), title: '第二句' })])
    assert.equal((await get(`codebuddy:${plain}`)).title, '第二句')
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
      // 远程已把 WorkBuddy 从「仅监听」特判改为统一的执行器在线检查：无执行器时报「电脑端不在线」
      assert.match(response.body.error, /电脑端不在线/)
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
