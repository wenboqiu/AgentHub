import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../src/index.ts'
import { createPool } from '../src/db.ts'
import { DATABASE_URL, makeUser } from './helpers.ts'

describe('Thread 统一事件流', () => {
  const pool = createPool(DATABASE_URL)
  let app: Awaited<ReturnType<typeof buildApp>>, a: Awaited<ReturnType<typeof makeUser>>, b: typeof a
  async function call(method: string, path: string, body?: unknown, token = a.token) {
    const r = await app.inject({ method: method as any, url: path, headers: { authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { payload: body as any }) })
    return { status: r.statusCode, body: r.json() }
  }
  const event = async (key: string, state: 'running' | 'done') => {
    assert.equal((await call('POST', '/events', { events: [{ agent: 'claude', sessionId: key, machine: 'thread机', cwd: 'D:\\ThreadTest', state, at: new Date().toISOString() }] })).status, 200)
  }
  const say = async (sessionId: string, text: string, role = 'assistant') => {
    await pool.query('INSERT INTO messages(user_id, session_id, role, text) VALUES($1,$2,$3,$4)', [a.id, sessionId, role, text])
  }

  before(async () => {
    app = await buildApp(DATABASE_URL, 'silent', { reminderIntervalMs: 30 })
    a = await makeUser(pool)
    b = await makeUser(pool)
  })
  after(async () => {
    await app.close()
    await pool.query('DELETE FROM users WHERE id=ANY($1::bigint[])', [[a.id, b.id]])
    await pool.end()
  })

  it('任务 = 统一事件流：消息 + 执行记录 + 提醒 + 摘要，按时间倒序', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const t = (await call('POST', '/tasks', { title: '线程任务', dueAt: past, remindDue: true })).body.task
    await call('PATCH', `/tasks/${t.id}`, { status: 'doing' })
    const key = randomUUID()
    await event(key, 'running')
    await call('POST', `/tasks/${t.id}/sessions`, { sessionId: `claude:${key}` })
    await say(`claude:${key}`, '改了配置文件', 'user')
    await say(`claude:${key}`, '已完成修改并通过测试')
    // 执行记录挂在关联会话上（远程发消息产生的 run）
    await pool.query("INSERT INTO runs(id, user_id, session_id, task_id, machine, status, error) VALUES($1,$2,$3,NULL,'thread机','failed','命令退出码 1')", [randomUUID(), a.id, `claude:${key}`])
    await event(key, 'done') // → review + 验收摘要
    const r = await call('GET', `/threads/task/${t.id}`)
    assert.equal(r.status, 200)
    const events = r.body.events as any[]
    const types = new Set(events.map(e => e.type))
    for (const want of ['message', 'run', 'reminder', 'digest']) assert.ok(types.has(want), `缺少 ${want} 事件`)
    const digest = events.find(e => e.type === 'digest')!
    assert.equal(digest.kind, 'review')
    assert.ok(digest.text.includes('已完成修改'))
    const run = events.find(e => e.type === 'run')!
    assert.equal(run.status, 'failed')
    const reminder = events.find(e => e.type === 'reminder')!
    assert.equal(reminder.kind, 'due')
    assert.equal(reminder.acked, false)
    // 倒序
    for (let i = 1; i < events.length; i++) assert.ok(events[i - 1].at >= events[i].at)
  })

  it('空任务返回空事件流；账号隔离 404', async () => {
    const t = (await call('POST', '/tasks', { title: '空任务' })).body.task
    assert.deepEqual((await call('GET', `/threads/task/${t.id}`)).body.events, [])
    assert.equal((await call('GET', `/threads/task/${t.id}`, undefined, b.token)).status, 404)
  })
})
