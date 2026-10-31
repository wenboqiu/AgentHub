import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/index.ts'
import { DATABASE_URL, PASSWORD, makeUser } from './helpers.ts'

const ADMIN = 'devadmin'
const stamp = Date.now()
let n = 0
const uniq = (p: string) => `${p}${stamp}-${n++}`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function waitFor<T>(fn: () => T | undefined | null | false, ms = 4000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error('waitFor 超时')
    await sleep(20)
  }
}

type Peer = { ws: WebSocket; msgs: any[]; closed: { code: number } | null }

function client(base: string) {
  const peers: Peer[] = []
  async function call(method: string, path: string, body?: unknown, token: string | null = null) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    return { status: res.status, body: (text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text) as any, headers: res.headers }
  }
  async function connect(token: string, query = ''): Promise<Peer> {
    const ws = new WebSocket(base.replace('http', 'ws') + `/ws?token=${token}${query ? '&' + query : ''}`)
    const p: Peer = { ws, msgs: [], closed: null }
    ws.onmessage = e => p.msgs.push(JSON.parse(String(e.data)))
    ws.onclose = e => (p.closed = { code: e.code })
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('ws error'))
    })
    peers.push(p)
    return p
  }
  const viewer = async (token: string) => {
    const v = await connect(token)
    await waitFor(() => v.msgs.find(m => m.type === 'snapshot'))
    return v
  }
  const executor = async (token: string, machine: string) => {
    const e = await connect(token, `role=agent&machine=${machine}`)
    for (let i = 0; i < 100; i++) {
      if ((await call('GET', '/control/status', undefined, token)).body.agents.includes(machine)) return e
      await sleep(20)
    }
    throw new Error('执行器没有登记')
  }
  const closeAll = () => peers.forEach(p => p.ws.close())
  return { call, connect, viewer, executor, closeAll }
}

const find = (p: Peer, type: string, pred: (m: any) => boolean = () => true) => p.msgs.find(m => m.type === type && pred(m))

async function start(config: { adminToken?: string; historyTimeoutMs?: number }) {
  const app = await buildApp(DATABASE_URL, 'silent', config)
  const base = await app.listen({ port: 0, host: '127.0.0.1' })
  return { app, base, ...client(base) }
}

describe('账号：登录、设备、改密码', () => {
  let s: Awaited<ReturnType<typeof start>>
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 })
  before(async () => {
    s = await start({ adminToken: ADMIN })
  })
  after(async () => {
    s.closeAll()
    await s.app.close()
    await pool.end()
  })

  it('没 token / 错 token / 过期 token 返回 401，/health 免登录', async () => {
    const u = await makeUser(pool)
    assert.equal((await s.call('GET', '/health')).status, 200)
    const none = await s.call('GET', '/sessions')
    assert.equal(none.status, 401)
    assert.equal(none.body.error, '请先登录')
    const wrong = await s.call('GET', '/sessions', undefined, 'nope')
    assert.equal(wrong.status, 401)
    assert.equal(wrong.body.error, '登录已过期，请重新登录')
    assert.equal((await s.call('GET', '/sessions', undefined, u.token)).status, 200)
    await pool.query("UPDATE auth_sessions SET last_used_at = now() - interval '181 days' WHERE user_id = $1", [u.id])
    const old = await s.call('GET', '/sessions', undefined, u.token)
    assert.equal(old.status, 401)
    assert.equal(old.body.error, '登录已过期，请重新登录')
  })

  it('登录：正确返回 token；错密码和不存在的邮箱 401 且文案相同；没有注册接口', async () => {
    const u = await makeUser(pool)
    const ok = await s.call('POST', '/auth/login', { email: u.email.toUpperCase(), password: PASSWORD, device: 'LAPTOP（电脑）' })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.email, u.email)
    assert.ok(ok.body.token.length > 20)
    assert.equal((await s.call('GET', '/auth/me', undefined, ok.body.token)).body.email, u.email)
    const bad = await s.call('POST', '/auth/login', { email: u.email, password: 'wrong-password' })
    const none = await s.call('POST', '/auth/login', { email: 'nobody@test.dev', password: 'wrong-password' })
    assert.equal(bad.status, 401)
    assert.equal(none.status, 401)
    assert.equal(bad.body.error, '邮箱或密码不对')
    assert.equal(none.body.error, bad.body.error)
    // 库里只存哈希，不存原 token
    const rows = await pool.query('SELECT token_hash FROM auth_sessions WHERE user_id = $1', [u.id])
    assert.ok(rows.rows.every(r => r.token_hash !== ok.body.token))
    assert.equal((await s.call('POST', '/auth/register', { email: 'x@test.dev', password: 'password123' })).status, 404)
    assert.equal((await s.call('POST', '/auth/register', { email: 'x@test.dev', password: 'password123' }, u.token)).status, 404)
  })

  it('登录限流：同一 IP 每分钟 10 次，之后 429', async () => {
    const t = await start({ adminToken: ADMIN })
    try {
      const codes: number[] = []
      for (let i = 0; i < 12; i++) codes.push((await t.call('POST', '/auth/login', { email: 'nobody@test.dev', password: 'whatever-pw' })).status)
      assert.deepEqual(codes.slice(0, 10), new Array(10).fill(401))
      assert.deepEqual(codes.slice(10), [429, 429])
    } finally {
      await t.app.close()
    }
  })

  it('设备：只列自己的并标出 current；踢掉另一个设备后 token 失效、WS 以 4401 关闭；不能踢别人的设备', async () => {
    const a = await makeUser(pool, '电脑')
    const b = await makeUser(pool, 'B 的电脑')
    const phone = await s.call('POST', '/auth/login', { email: a.email, password: PASSWORD, device: '手机'.padEnd(80, 'x') })
    const list = await s.call('GET', '/auth/devices', undefined, a.token)
    assert.equal(list.body.length, 2)
    assert.equal(list.body.filter((d: any) => d.current).length, 1)
    const me = list.body.find((d: any) => d.current)
    assert.equal(me.device, '电脑')
    const other = list.body.find((d: any) => !d.current)
    assert.equal(other.device.length, 50)
    assert.ok(other.createdAt && other.lastUsedAt)
    const fromPhone = await s.call('GET', '/auth/devices', undefined, phone.body.token)
    assert.equal(fromPhone.body.find((d: any) => d.current).id, other.id)

    // 别人的设备不能踢
    const bDev = (await s.call('GET', '/auth/devices', undefined, b.token)).body[0]
    assert.equal((await s.call('DELETE', `/auth/devices/${bDev.id}`, undefined, a.token)).status, 404)
    assert.equal((await s.call('GET', '/sessions', undefined, b.token)).status, 200)

    const ws = await s.viewer(phone.body.token)
    const ex = await s.executor(phone.body.token, uniq('phone-pc'))
    assert.equal((await s.call('DELETE', `/auth/devices/${other.id}`, undefined, a.token)).status, 200)
    await waitFor(() => ws.closed)
    await waitFor(() => ex.closed)
    assert.equal(ws.closed!.code, 4401)
    assert.equal(ex.closed!.code, 4401)
    assert.equal((await s.call('GET', '/sessions', undefined, phone.body.token)).status, 401)
    assert.equal((await s.call('GET', '/sessions', undefined, a.token)).status, 200)
    assert.equal((await s.call('DELETE', `/auth/devices/${other.id}`, undefined, a.token)).status, 404)
  })

  it('退出登录：删当前设备会话并关闭它的 WS', async () => {
    const u = await makeUser(pool)
    const ws = await s.viewer(u.token)
    assert.equal((await s.call('POST', '/auth/logout', {}, u.token)).status, 200)
    await waitFor(() => ws.closed)
    assert.equal(ws.closed!.code, 4401)
    assert.equal((await s.call('GET', '/sessions', undefined, u.token)).status, 401)
  })

  it('改密码：旧密码错 403；成功后其它设备失效、当前仍有效，新密码可登录', async () => {
    const u = await makeUser(pool)
    const phone = (await s.call('POST', '/auth/login', { email: u.email, password: PASSWORD, device: '手机' })).body.token
    const phoneWs = await s.viewer(phone)
    assert.equal((await s.call('POST', '/auth/password', { oldPassword: 'wrong', newPassword: 'newpassword1' }, u.token)).status, 403)
    assert.equal((await s.call('POST', '/auth/password', { oldPassword: PASSWORD, newPassword: 'short' }, u.token)).status, 400)
    assert.equal((await s.call('POST', '/auth/password', { oldPassword: PASSWORD, newPassword: 'newpassword1' }, u.token)).status, 200)
    assert.equal((await s.call('GET', '/sessions', undefined, u.token)).status, 200)
    assert.equal((await s.call('GET', '/sessions', undefined, phone)).status, 401)
    await waitFor(() => phoneWs.closed)
    assert.equal(phoneWs.closed!.code, 4401)
    assert.equal((await s.call('POST', '/auth/login', { email: u.email, password: PASSWORD })).status, 401)
    assert.equal((await s.call('POST', '/auth/login', { email: u.email, password: 'newpassword1' })).status, 200)
  })
})

describe('管理接口', () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 })
  after(async () => {
    await pool.end()
  })

  it('没设 ADMIN_TOKEN 时 /admin 和 /admin/users 都是 404', async () => {
    const t = await start({})
    try {
      assert.equal((await t.call('GET', '/admin')).status, 404)
      assert.equal((await t.call('GET', '/admin/users', undefined, ADMIN)).status, 404)
      assert.equal((await t.call('POST', '/admin/users', { email: 'a@test.dev', password: PASSWORD }, ADMIN)).status, 404)
    } finally {
      await t.app.close()
    }
  })

  it('/admin 返回 HTML；错令牌 401，错 10 次后 429', async () => {
    const t = await start({ adminToken: ADMIN })
    try {
      const page = await t.call('GET', '/admin')
      assert.equal(page.status, 200)
      assert.match(page.headers.get('content-type') ?? '', /text\/html/)
      assert.match(page.body, /<!doctype html>/i)
      assert.equal((await t.call('GET', '/admin/users')).status, 401)
      const codes: number[] = []
      for (let i = 0; i < 11; i++) codes.push((await t.call('GET', '/admin/users', undefined, 'wrong')).status)
      // 上面没带令牌的那次也算一次错误
      assert.deepEqual(codes.slice(0, 8), new Array(8).fill(401))
      assert.equal(codes[10], 429)
      // 封禁期间连正确的令牌也先拒绝
      assert.equal((await t.call('GET', '/admin/users', undefined, ADMIN)).status, 429)
    } finally {
      await t.app.close()
    }
  })

  it('建账号、重复 409、校验、列表、重置密码使旧 token 失效、删账号级联删数据', async () => {
    const t = await start({ adminToken: ADMIN })
    try {
      const email = `${uniq('adm')}@test.dev`
      assert.equal((await t.call('POST', '/admin/users', { email: 'bad', password: PASSWORD }, ADMIN)).status, 400)
      assert.equal((await t.call('POST', '/admin/users', { email, password: 'short' }, ADMIN)).status, 400)
      const created = await t.call('POST', '/admin/users', { email: email.toUpperCase(), password: PASSWORD }, ADMIN)
      assert.equal(created.status, 200)
      const id = created.body.id
      assert.equal((await t.call('POST', '/admin/users', { email, password: PASSWORD }, ADMIN)).status, 409)

      const login = await t.call('POST', '/auth/login', { email, password: PASSWORD, device: '电脑' })
      assert.equal(login.status, 200)
      const list = await t.call('GET', '/admin/users', undefined, ADMIN)
      const row = list.body.find((u: any) => u.id === id)
      assert.equal(row.email, email)
      assert.equal(row.devices, 1)
      assert.ok(row.lastUsedAt)
      const devs = await t.call('GET', `/admin/users/${id}/devices`, undefined, ADMIN)
      assert.equal(devs.body.length, 1)

      // 重置密码：旧 token 失效，新密码可登录
      const ws = await t.viewer(login.body.token)
      assert.equal((await t.call('POST', `/admin/users/${id}/password`, { password: 'short' }, ADMIN)).status, 400)
      assert.equal((await t.call('POST', `/admin/users/${id}/password`, { password: 'resetpass1' }, ADMIN)).status, 200)
      assert.equal((await t.call('GET', '/sessions', undefined, login.body.token)).status, 401)
      await waitFor(() => ws.closed)
      assert.equal(ws.closed!.code, 4401)
      assert.equal((await t.call('POST', '/auth/login', { email, password: PASSWORD })).status, 401)
      const again = await t.call('POST', '/auth/login', { email, password: 'resetpass1', device: '手机' })
      assert.equal(again.status, 200)
      assert.equal((await t.call('POST', '/admin/users/999999999/password', { password: 'resetpass1' }, ADMIN)).status, 404)

      // 踢掉单个设备
      const devId = (await t.call('GET', `/admin/users/${id}/devices`, undefined, ADMIN)).body[0].id
      assert.equal((await t.call('DELETE', `/admin/devices/${devId}`, undefined, ADMIN)).status, 200)
      assert.equal((await t.call('GET', '/sessions', undefined, again.body.token)).status, 401)
      assert.equal((await t.call('DELETE', `/admin/devices/${devId}`, undefined, ADMIN)).status, 404)

      // 删账号：级联删数据
      const fresh = (await t.call('POST', '/auth/login', { email, password: 'resetpass1' })).body.token
      await t.call('POST', '/events', { events: [{ agent: 'claude', sessionId: uniq('del'), machine: 'pc', cwd: 'D:\\x', state: 'done', at: new Date().toISOString() }] }, fresh)
      const count = async () => Number((await pool.query('SELECT count(*) FROM sessions WHERE user_id = $1', [id])).rows[0].count)
      assert.equal(await count(), 1)
      const ws2 = await t.viewer(fresh)
      assert.equal((await t.call('DELETE', `/admin/users/${id}`, undefined, ADMIN)).status, 200)
      assert.equal(await count(), 0)
      await waitFor(() => ws2.closed)
      assert.equal((await t.call('GET', '/sessions', undefined, fresh)).status, 401)
      assert.equal((await t.call('DELETE', `/admin/users/${id}`, undefined, ADMIN)).status, 404)
    } finally {
      t.closeAll()
      await t.app.close()
    }
  })
})

describe('数据隔离', () => {
  let s: Awaited<ReturnType<typeof start>>
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 })
  let A: Awaited<ReturnType<typeof makeUser>>
  let B: Awaited<ReturnType<typeof makeUser>>
  before(async () => {
    s = await start({ adminToken: ADMIN, historyTimeoutMs: 600 })
    A = await makeUser(pool)
    B = await makeUser(pool)
  })
  after(async () => {
    s.closeAll()
    await s.app.close()
    await pool.end()
  })
  const ev = (sessionId: string, machine: string, state = 'done', extra: Record<string, unknown> = {}) => ({
    agent: 'claude',
    sessionId,
    machine,
    cwd: 'D:\\Work2\\Demo',
    state,
    at: new Date().toISOString(),
    ...extra,
  })
  const enc = encodeURIComponent

  it('两个账号上报同名会话 id 互不覆盖；列表、快照只含自己的；A 的 viewer 收不到 B 的广播', async () => {
    const same = uniq('same')
    const vA = await s.viewer(A.token)
    const vB = await s.viewer(B.token)
    await s.call('POST', '/events', { events: [ev(same, 'pcA', 'done', { title: 'A 的会话', summary: 'A' })] }, A.token)
    await s.call('POST', '/events', { events: [ev(same, 'pcB', 'waiting', { title: 'B 的会话', summary: 'B' })] }, B.token)
    const la = (await s.call('GET', '/sessions?all=1', undefined, A.token)).body.sessions.filter((x: any) => x.id === `claude:${same}`)
    const lb = (await s.call('GET', '/sessions?all=1', undefined, B.token)).body.sessions.filter((x: any) => x.id === `claude:${same}`)
    assert.equal(la.length, 1)
    assert.equal(lb.length, 1)
    assert.deepEqual([la[0].machine, la[0].state, la[0].title], ['pcA', 'done', 'A 的会话'])
    assert.deepEqual([lb[0].machine, lb[0].state, lb[0].title], ['pcB', 'waiting', 'B 的会话'])
    await waitFor(() => find(vA, 'session', m => m.session.id === `claude:${same}`))
    await waitFor(() => find(vB, 'session', m => m.session.id === `claude:${same}`))
    assert.equal(vA.msgs.filter(m => m.type === 'session' && m.session.machine === 'pcB').length, 0)
    assert.equal(vB.msgs.filter(m => m.type === 'session' && m.session.machine === 'pcA').length, 0)
    // 新连上的 viewer 的快照也只有自己的
    const snapB = find(await s.viewer(B.token), 'snapshot')
    assert.ok(snapB.sessions.every((x: any) => x.machine !== 'pcA'))
  })

  it('A 不能 ack / 删除 / 读消息 / 发消息 / 取历史 B 的会话（404），B 的数据不受影响', async () => {
    const id = uniq('priv')
    await s.call('POST', '/events', { events: [ev(id, 'pcB', 'waiting')] }, B.token)
    const sid = enc(`claude:${id}`)
    assert.equal((await s.call('POST', `/sessions/${sid}/ack`, undefined, A.token)).status, 404)
    assert.equal((await s.call('GET', `/sessions/${sid}/messages`, undefined, A.token)).status, 404)
    assert.equal((await s.call('POST', `/sessions/${sid}/messages`, { text: 'hi' }, A.token)).status, 404)
    assert.equal((await s.call('POST', `/sessions/${sid}/history`, {}, A.token)).status, 404)
    assert.equal((await s.call('DELETE', `/sessions/${sid}`, undefined, A.token)).status, 404)
    const b = (await s.call('GET', '/sessions?all=1', undefined, B.token)).body.sessions.find((x: any) => x.id === `claude:${id}`)
    assert.equal(b.acked, false)
    assert.equal((await s.call('GET', `/sessions/${sid}/messages`, undefined, B.token)).status, 200)
    // ack-all 只动自己的
    const idA = uniq('priv-a')
    await s.call('POST', '/events', { events: [ev(idA, 'pcA', 'done')] }, A.token)
    assert.equal((await s.call('POST', '/sessions/ack-all', undefined, A.token)).status, 200)
    const b2 = (await s.call('GET', '/sessions?all=1', undefined, B.token)).body.sessions.find((x: any) => x.id === `claude:${id}`)
    assert.equal(b2.acked, false)
    assert.equal((await s.call('DELETE', `/sessions/${sid}`, undefined, B.token)).status, 200)
  })

  it('A 的发消息不会发到 B 的同名 machine 执行器；B 不能批 / 停 A 的授权和运行', async () => {
    const machine = uniq('shared-pc')
    const exA = await s.executor(A.token, machine)
    const exB = await s.executor(B.token, machine)
    // 同名 machine 在两个账号下各自在线，不互相顶掉
    assert.equal(exA.closed, null)
    assert.equal(exB.closed, null)
    const vB = await s.viewer(B.token)
    const id = uniq('run')
    await s.call('POST', '/events', { events: [ev(id, machine)] }, A.token)
    const r = await s.call('POST', `/sessions/${enc(`claude:${id}`)}/messages`, { text: '给 A 的' }, A.token)
    assert.equal(r.status, 200)
    const runId = r.body.runId
    await waitFor(() => find(exA, 'run.start'))
    await sleep(150)
    assert.equal(find(exB, 'run.start'), undefined)
    assert.equal(find(vB, 'run'), undefined)

    // B 的执行器冒充改 A 的 run：无效
    exB.ws.send(JSON.stringify({ type: 'run.status', runId, status: 'failed', error: 'hack' }))
    exB.ws.send(JSON.stringify({ type: 'run.message', runId, role: 'assistant', text: 'hacked' }))
    exB.ws.send(JSON.stringify({ type: 'run.approval', runId, localId: 1, tool: 'Bash', detail: 'rm' }))
    exA.ws.send(JSON.stringify({ type: 'run.status', runId, status: 'running' }))
    exA.ws.send(JSON.stringify({ type: 'run.approval', runId, localId: 2, tool: 'Write', detail: 'a.txt' }))
    const created = await waitFor(() => find(exA, 'approval.created'))
    const q = (await s.call('GET', `/sessions/${enc(`claude:${id}`)}/messages`, undefined, A.token)).body
    assert.equal(q.run.status, 'running')
    assert.equal(q.run.error, '')
    assert.ok(!q.messages.some((m: any) => m.text === 'hacked'))
    assert.equal(q.approvals.length, 1)
    assert.equal(find(exB, 'approval.created'), undefined)

    // B 批不了 A 的授权、停不了 A 的运行
    assert.equal((await s.call('POST', `/approvals/${created.approvalId}`, { decision: 'allow' }, B.token)).status, 404)
    assert.equal((await s.call('POST', `/runs/${runId}/stop`, {}, B.token)).status, 404)
    assert.equal(find(exA, 'approval.decide'), undefined)
    assert.equal((await s.call('POST', `/approvals/${created.approvalId}`, { decision: 'allow' }, A.token)).status, 200)

    // B 的 history.result 不能完成 A 的请求
    const pending = s.call('POST', `/sessions/${enc(`claude:${id}`)}/history`, {}, A.token)
    const req = await waitFor(() => find(exA, 'history.request'))
    exB.ws.send(JSON.stringify({ type: 'history.result', requestId: req.requestId, messages: [{ role: 'user', text: 'evil' }] }))
    assert.equal((await pending).status, 504)
  })
})

describe('迁移', () => {
  it('旧结构（sessions 没有 user_id）的库启动后被重建且可用', async () => {
    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 2 })
    const schema = `migrate_${Date.now()}`
    await admin.query(`CREATE SCHEMA ${schema}`)
    const url = new URL(DATABASE_URL)
    url.searchParams.set('options', `-c search_path=${schema}`)
    const old = new pg.Pool({ connectionString: url.toString(), max: 2 })
    let app: FastifyInstance | null = null
    try {
      await old.query(`CREATE TABLE sessions (id text primary key, agent text not null, machine text not null, cwd text not null default '', project text not null default '',
        title text not null default '', state text not null, summary text not null default '', state_since timestamptz not null, acked boolean not null default true,
        pid integer, event_at timestamptz not null, updated_at timestamptz not null default now())`)
      await old.query(`CREATE TABLE runs (id text primary key, session_id text not null, machine text not null, status text not null, error text not null default '', created_at timestamptz not null default now(), updated_at timestamptz not null default now())`)
      await old.query(`INSERT INTO sessions (id, agent, machine, state, state_since, event_at) VALUES ('claude:old', 'claude', 'pc', 'done', now(), now())`)
      app = await buildApp(url.toString(), 'silent', { adminToken: ADMIN })
      const base = await app.listen({ port: 0, host: '127.0.0.1' })
      const cols = await old.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'sessions'`, [schema])
      assert.ok(cols.rows.some(r => r.column_name === 'user_id'))
      assert.equal(Number((await old.query('SELECT count(*) FROM sessions')).rows[0].count), 0)
      for (const t of ['runs', 'messages', 'approvals']) {
        const c = await old.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = 'user_id'`, [schema, t])
        assert.equal(c.rowCount, 1, t)
      }
      const c = client(base)
      const created = await c.call('POST', '/admin/users', { email: 'm@test.dev', password: PASSWORD }, ADMIN)
      assert.equal(created.status, 200)
      const login = await c.call('POST', '/auth/login', { email: 'm@test.dev', password: PASSWORD, device: 't' })
      assert.equal(login.status, 200)
      const r = await c.call('POST', '/events', { events: [{ agent: 'claude', sessionId: 'x', machine: 'pc', cwd: 'D:\\x', state: 'done', at: new Date().toISOString() }] }, login.body.token)
      assert.equal(r.body.accepted, 1)
      assert.equal((await c.call('GET', '/sessions', undefined, login.body.token)).body.sessions.length, 1)
      // 再启动一次不会再清空
      await app.close()
      app = await buildApp(url.toString(), 'silent', { adminToken: ADMIN })
      assert.equal(Number((await old.query('SELECT count(*) FROM sessions')).rows[0].count), 1)
    } finally {
      await app?.close()
      await old.end()
      await admin.query(`DROP SCHEMA ${schema} CASCADE`)
      await admin.end()
    }
  })
})
