import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../src/index.ts'
import { createPool } from '../src/db.ts'
import { buildFailureDigest } from '../src/digest.ts'
import { DATABASE_URL, makeUser } from './helpers.ts'

describe('预摘要', () => {
  const pool = createPool(DATABASE_URL)
  let app: Awaited<ReturnType<typeof buildApp>>, a: Awaited<ReturnType<typeof makeUser>>, b: typeof a
  async function call(method: string, path: string, body?: unknown, token = a.token) {
    const r = await app.inject({ method: method as any, url: path, headers: { authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { payload: body as any }) })
    return { status: r.statusCode, body: r.json() }
  }
  const newTask = async (body: Record<string, unknown> = {}) => (await call('POST', '/tasks', { title: '摘要任务', ...body })).body.task
  const event = async (key: string, state: 'running' | 'done') => {
    assert.equal((await call('POST', '/events', { events: [{ agent: 'claude', sessionId: key, machine: '摘要测试机', cwd: 'D:\\DigestTest', state, at: new Date().toISOString() }] })).status, 200)
  }
  const say = async (sessionId: string, text: string, role = 'assistant') => {
    await pool.query('INSERT INTO messages(user_id, session_id, role, text) VALUES($1,$2,$3,$4)', [a.id, sessionId, role, text])
  }
  const digest = async (taskId: number, token = a.token) => (await call('GET', `/tasks/${taskId}/digest`, undefined, token)).body

  before(async () => {
    app = await buildApp(DATABASE_URL, 'silent')
    a = await makeUser(pool)
    b = await makeUser(pool)
  })
  after(async () => {
    await app.close()
    await pool.query('DELETE FROM users WHERE id=ANY($1::bigint[])', [[a.id, b.id]])
    await pool.end()
  })

  it('任务进入待验收时自动生成验收摘要，重新进入时更新', async () => {
    const t = await newTask()
    assert.deepEqual(await digest(t.id), { review: null, failure: null })
    await call('PATCH', `/tasks/${t.id}`, { status: 'doing' })
    const key = randomUUID()
    await event(key, 'running')
    await call('POST', `/tasks/${t.id}/sessions`, { sessionId: `claude:${key}` })
    await say(`claude:${key}`, '第一步：重构了通知模块')
    await say(`claude:${key}`, '已完成全部修改并通过测试')
    await event(key, 'done')
    const d = await digest(t.id)
    assert.equal(d.review.sessionId, `claude:${key}`)
    assert.equal(d.review.lastReply, '已完成全部修改并通过测试')
    assert.equal(d.review.messages, 2)
    // 任务回进行中再完成：摘要随之更新
    await call('PATCH', `/tasks/${t.id}`, { status: 'doing' })
    await say(`claude:${key}`, '补充：又修了一个边界情况')
    await event(key, 'running')
    await event(key, 'done')
    const d2 = await digest(t.id)
    assert.equal(d2.review.messages, 3)
    assert.equal(d2.review.lastReply, '补充：又修了一个边界情况')
  })

  it('run 失败时预收集错误上下文', async () => {
    const t = await newTask()
    const runId = randomUUID()
    await pool.query(
      "INSERT INTO runs(id, user_id, session_id, task_id, machine, status, error) VALUES($1,$2,$3,$4,'摘要测试机','failed','命令退出码 1')",
      [runId, a.id, 'claude:失败会话', t.id],
    )
    await say('claude:失败会话', 'cargo build', 'tool')
    await say('claude:失败会话', '编译失败：缺少依赖', 'assistant')
    const built = await buildFailureDigest(pool, a.id, t.id, { id: runId, sessionId: 'claude:失败会话', error: '命令退出码 1' })
    assert.equal(built?.error, '命令退出码 1')
    assert.equal(built?.tail.length, 2)
    const d = await digest(t.id)
    assert.equal(d.failure.error, '命令退出码 1')
    assert.equal(d.failure.tail[1].text, '编译失败：缺少依赖')
    // 任务不存在时不生成
    assert.equal(await buildFailureDigest(pool, a.id, 999999999, { id: runId, sessionId: null, error: 'x' }), null)
  })

  it('账号隔离：别人的任务读不到摘要', async () => {
    const t = await newTask()
    assert.equal((await call('GET', `/tasks/${t.id}/digest`, undefined, b.token)).status, 404)
  })
})
