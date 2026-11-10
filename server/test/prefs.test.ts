import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/index.ts'
import { createPool } from '../src/db.ts'
import { AVATAR_IMAGE_MAX } from '../src/prefs.ts'
import { DATABASE_URL, makeUser } from './helpers.ts'

describe('账号偏好：agent 头像', () => {
  const pool = createPool(DATABASE_URL)
  let app: Awaited<ReturnType<typeof buildApp>>, base: string, a: Awaited<ReturnType<typeof makeUser>>, b: typeof a
  const peers: WebSocket[] = []
  async function call(method: string, path: string, body?: unknown, token = a.token) {
    const r = await app.inject({ method: method as any, url: path, headers: { authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { payload: body as any }) })
    return { status: r.statusCode, body: r.json() }
  }
  async function waitFor(msgs: any[], pred: (m: any) => boolean) {
    const until = Date.now() + 8000
    for (;;) {
      const found = msgs.findLast(pred)
      if (found) return found
      if (Date.now() > until) throw new Error('等待广播超时')
      await new Promise(r => setTimeout(r, 10))
    }
  }
  async function connect(token: string) {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${token}`)
    const msgs: any[] = []
    ws.onmessage = e => msgs.push(JSON.parse(String(e.data)))
    peers.push(ws)
    await new Promise<void>((ok, fail) => { ws.onopen = () => ok(); ws.onerror = () => fail(new Error('连接失败')) })
    await waitFor(msgs, m => m.type === 'snapshot')
    return msgs
  }
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

  before(async () => {
    app = await buildApp(DATABASE_URL, 'silent', { reminderIntervalMs: 60000 })
    base = await app.listen({ port: 0, host: '127.0.0.1' })
    a = await makeUser(pool)
    b = await makeUser(pool)
  })
  after(async () => {
    for (const ws of peers) ws.close()
    await app.close()
    await pool.query('DELETE FROM users WHERE id=ANY($1::bigint[])', [[a.id, b.id]])
    await pool.end()
  })

  it('默认没有自定义头像', async () => {
    const r = await call('GET', '/prefs')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.prefs, { avatars: {} })
  })

  it('设内置 / 图片头像，按 agent 合并；null 恢复默认；改了推给同账号、不推别人', async () => {
    const mine = await connect(a.token), other = await connect(b.token)
    let r = await call('PATCH', '/prefs', { avatars: { claude: { kind: 'preset', id: 'fox' } } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    r = await call('PATCH', '/prefs', { avatars: { codex: { kind: 'image', data: png } } })
    assert.deepEqual(r.body.prefs.avatars, { claude: { kind: 'preset', id: 'fox' }, codex: { kind: 'image', data: png } })
    const pushed = await waitFor(mine, m => m.type === 'prefs' && m.prefs.avatars.codex)
    assert.equal(pushed.prefs.avatars.claude.id, 'fox')
    assert.equal(other.some(m => m.type === 'prefs'), false)
    assert.deepEqual((await call('GET', '/prefs', undefined, b.token)).body.prefs.avatars, {})

    r = await call('PATCH', '/prefs', { avatars: { claude: null } })
    assert.deepEqual(r.body.prefs.avatars, { codex: { kind: 'image', data: png } })
    assert.deepEqual((await call('GET', '/prefs')).body.prefs.avatars, { codex: { kind: 'image', data: png } })
  })

  it('角色、项目的自定义头像：默认 null，可设内置 / 图片，null 清掉，非法 400', async () => {
    let r = await call('POST', '/roles', { name: '头像测试角色', agent: 'claude' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const role = r.body.role
    assert.equal(role.avatar, null)
    r = await call('PATCH', `/roles/${role.id}`, { avatar: { kind: 'preset', id: 'lobster' } })
    assert.deepEqual(r.body.role.avatar, { kind: 'preset', id: 'lobster' })
    assert.equal(r.body.role.agent, 'claude', '只改头像不动别的字段')
    assert.deepEqual((await call('GET', '/roles')).body.roles.find((x: any) => x.id === role.id).avatar, { kind: 'preset', id: 'lobster' })
    r = await call('PATCH', `/roles/${role.id}`, { avatar: null })
    assert.equal(r.body.role.avatar, null)
    assert.equal((await call('PATCH', `/roles/${role.id}`, { avatar: { kind: 'image', data: 'javascript:alert(1)' } })).status, 400)

    r = await call('POST', '/projects', { name: '头像测试项目', avatar: { kind: 'image', data: png } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.project.avatar, { kind: 'image', data: png })
    r = await call('PATCH', `/projects/${r.body.project.id}`, { avatar: null })
    assert.equal(r.body.project.avatar, null)
    assert.equal((await call('POST', '/projects', { name: '坏头像项目', avatar: { kind: 'preset', id: 'A B' } })).status, 400)
  })

  it('非法输入 400：未知字段 / agent、坏 id、非图片 data URL、太大', async () => {
    const bad = [
      { theme: 'dark' },
      { avatars: { gpt: { kind: 'preset', id: 'fox' } } },
      { avatars: { claude: { kind: 'preset', id: '../x' } } },
      { avatars: { claude: { kind: 'image', data: 'data:text/html;base64,PHNjcmlwdD4=' } } },
      { avatars: { claude: { kind: 'image', data: 'https://example.com/a.png' } } },
      { avatars: { claude: { kind: 'image', data: 'data:image/png;base64,' + 'A'.repeat(AVATAR_IMAGE_MAX) } } },
      { avatars: { claude: { kind: 'emoji' } } },
      { avatars: [] },
    ]
    for (const body of bad) assert.equal((await call('PATCH', '/prefs', body)).status, 400, JSON.stringify(body).slice(0, 80))
  })
})
