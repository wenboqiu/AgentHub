// 邀请码注册：生成 / 核销 / 限次 / 过期 / 停用，以及 /register 页面公开可访问。
// 注意 /auth/register 和 /auth/login 共享每 IP 每分钟 10 次的限流，这里的调用数要留余量。
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { FastifyInstance } from 'fastify'
import pg from 'pg'
import { buildApp } from '../src/index.ts'
import { DATABASE_URL } from './helpers.ts'

const ADMIN_TOKEN = 'test-admin-token'
// 库是持久的，邮箱要每次运行都唯一
const runStamp = String(Date.now())

describe('邀请码注册', () => {
  let app: FastifyInstance
  let base = ''
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 })

  async function call(method: string, path: string, body?: unknown, token?: string) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let parsed: any = text
    try { parsed = JSON.parse(text) } catch { /* 不是 JSON */ }
    return { status: res.status, body: parsed, headers: res.headers }
  }
  const invite = async (opts: Record<string, unknown> = {}) =>
    (await call('POST', '/admin/invites', opts, ADMIN_TOKEN)).body as { id: number; code: string; maxUses: number }

  before(async () => {
    app = await buildApp(DATABASE_URL, 'silent', { adminToken: ADMIN_TOKEN, authRatePerMin: 1000 })
    base = await app.listen({ port: 0, host: '127.0.0.1' })
  })
  after(async () => {
    await app.close()
    await pool.end()
  })

  it('/register 页面公开可访问，管理接口要管理员令牌', async () => {
    const page = await call('GET', '/register')
    assert.equal(page.status, 200)
    assert.match(String(page.headers.get('content-type') ?? ''), /text\/html/)
    assert.equal((await call('POST', '/admin/invites', {}, undefined)).status, 401)
    assert.equal((await call('POST', '/admin/invites', {}, 'wrong')).status, 401)
  })

  it('无效邀请码 / 缺字段返回 400，不泄露原因', async () => {
    assert.equal((await call('POST', '/auth/register', { code: 'AAAAA-BBBBB', email: 'nope1@test.dev', password: 'password123' })).status, 400)
    assert.equal((await call('POST', '/auth/register', { email: 'nope2@test.dev', password: 'password123' })).status, 400)
    assert.equal((await call('POST', '/auth/register', { code: 'x', email: 'bad-email', password: 'short' })).status, 400)
  })

  it('有效邀请码注册成功并直接拿到会话 token，格式归一化（大小写 / 空格 / 横线）', async () => {
    const inv = await invite({ note: '给小明' })
    const r = await call('POST', '/auth/register', { code: ` ${inv.code.toLowerCase().replace('-', '')} `, email: `friend-${runStamp}@Test.Dev`, password: 'password123' })
    assert.equal(r.status, 200)
    assert.equal(r.body.email, `friend-${runStamp}@test.dev`)
    assert.ok(typeof r.body.token === 'string' && r.body.token.length > 20)
    const me = await call('GET', '/auth/me', undefined, r.body.token)
    assert.equal(me.status, 200)
    assert.equal(me.body.email, `friend-${runStamp}@test.dev`)
  })

  it('一次码用完即失效；重复邮箱 409', async () => {
    const inv = await invite()
    const email = `dup-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.dev`
    assert.equal((await call('POST', '/auth/register', { code: inv.code, email, password: 'password123' })).status, 200)
    assert.equal((await call('POST', '/auth/register', { code: inv.code, email: `other-${email}`, password: 'password123' })).status, 400)
    assert.equal((await call('POST', '/auth/register', { code: (await invite()).code, email, password: 'password123' })).status, 409)
  })

  it('多次码按上限核销，管理列表能看到使用数', async () => {
    const inv = await invite({ maxUses: 2 })
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    assert.equal((await call('POST', '/auth/register', { code: inv.code, email: `m1-${stamp}@test.dev`, password: 'password123' })).status, 200)
    assert.equal((await call('POST', '/auth/register', { code: inv.code, email: `m2-${stamp}@test.dev`, password: 'password123' })).status, 200)
    assert.equal((await call('POST', '/auth/register', { code: inv.code, email: `m3-${stamp}@test.dev`, password: 'password123' })).status, 400)
    const list = (await call('GET', '/admin/invites', undefined, ADMIN_TOKEN)).body as { id: number; usedCount: number; maxUses: number }[]
    const row = list.find(i => i.id === inv.id)
    assert.ok(row)
    assert.equal(row.usedCount, 2)
    assert.equal(row.maxUses, 2)
  })

  it('过期与停用的邀请码都不能注册', async () => {
    const expired = await invite({ expiresInDays: 1 })
    await pool.query('UPDATE invites SET expires_at = now() - interval \'1 day\' WHERE id = $1', [expired.id])
    assert.equal((await call('POST', '/auth/register', { code: expired.code, email: `exp-${Date.now()}@test.dev`, password: 'password123' })).status, 400)
    const revoked = await invite()
    assert.equal((await call('DELETE', `/admin/invites/${revoked.id}`, undefined, ADMIN_TOKEN)).status, 200)
    assert.equal((await call('POST', '/auth/register', { code: revoked.code, email: `rev-${Date.now()}@test.dev`, password: 'password123' })).status, 400)
    // 已注册的账号不受停用影响
    const ok = await call('POST', '/auth/register', { code: (await invite()).code, email: `keep-${Date.now()}@test.dev`, password: 'password123' })
    assert.equal(ok.status, 200)
    assert.equal((await call('GET', '/auth/me', undefined, ok.body.token)).status, 200)
  })

  it('注册的账号可以直接登录', async () => {
    const inv = await invite()
    const email = `login-${Date.now()}@test.dev`
    assert.equal((await call('POST', '/auth/register', { code: inv.code, email, password: 'password123', device: 'test' })).status, 200)
    const r = await call('POST', '/auth/login', { email, password: 'password123', device: 'test' })
    assert.equal(r.status, 200)
    assert.equal(r.body.email, email)
  })
})
