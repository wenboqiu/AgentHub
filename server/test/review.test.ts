import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/index.ts'
import { createPool } from '../src/db.ts'
import { harvestEvidence } from '../src/review.ts'
import { DATABASE_URL, makeUser } from './helpers.ts'

describe('验收检查项与证据', () => {
  const pool = createPool(DATABASE_URL)
  let app: Awaited<ReturnType<typeof buildApp>>, a: Awaited<ReturnType<typeof makeUser>>, b: typeof a
  async function call(method: string, path: string, body?: unknown, token = a.token) {
    const r = await app.inject({ method: method as any, url: path, headers: { authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { payload: body as any }) })
    return { status: r.statusCode, body: r.json() }
  }
  const newTask = async (body: Record<string, unknown> = {}) => (await call('POST', '/tasks', { title: '验收任务', ...body })).body.task
  const review = async (taskId: number, token = a.token) => (await call('GET', `/tasks/${taskId}/review`, undefined, token)).body
  const say = async (sessionId: string, text: string, role = 'assistant') => {
    await pool.query('INSERT INTO messages(user_id, session_id, role, text) VALUES($1,$2,$3,$4)', [a.id, sessionId, role, text])
  }

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

  it('从会话记录摘取证据：文件、命令、测试、截图、错误日志', () => {
    const msgs = [
      { role: 'tool', text: 'npm test -- --run', createdAt: '2026-11-04T01:00:00.000Z' },
      { role: 'tool', text: 'Tests: 12 passed, 12 total', createdAt: '2026-11-04T01:00:01.000Z' },
      { role: 'assistant', text: '改了 src/server/notify.ts 和 server/test/notify.test.ts，顺便看了 node_modules/foo/index.js', createdAt: '2026-11-04T01:00:02.000Z' },
      { role: 'assistant', text: '截图存在 docs/shots/review.png', createdAt: '2026-11-04T01:00:03.000Z' },
      { role: 'tool', text: 'Error: connect ECONNREFUSED 127.0.0.1:5432', createdAt: '2026-11-04T01:00:04.000Z' },
      { role: 'user', text: '再跑一次 npm test -- --run', createdAt: '2026-11-04T01:00:05.000Z' },
    ]
    const ev = harvestEvidence(msgs)
    const by = (kind: string) => ev.filter(e => e.kind === kind).map(e => e.value)
    assert.deepEqual(by('command'), ['npm test -- --run'])
    assert.deepEqual(by('test'), ['Tests: 12 passed, 12 total'])
    assert.deepEqual(by('file'), ['src/server/notify.ts', 'server/test/notify.test.ts'])
    assert.deepEqual(by('shot'), ['docs/shots/review.png'])
    assert.equal(by('log').length, 1)
    // node_modules 等构建产物不进证据；同一值只出现一次
    assert.ok(!by('file').some(v => v.includes('node_modules')))
    assert.equal(new Set(by('command')).size, by('command').length)
  })

  it('任务清单同步为检查项，判定结果不被重新同步覆盖', async () => {
    const t = await newTask({ checklist: [{ id: 'build', text: '跑通构建', done: false }, { id: 'test', text: '补测试', done: true }] })
    let r = await review(t.id)
    assert.equal(r.items.length, 2)
    assert.equal(r.items.find((i: any) => i.key === 'test').status, 'pass')
    assert.equal(r.items.find((i: any) => i.key === 'build').status, 'pending')
    // 判定为通过后，再拉一次（会重新同步清单）状态保持
    const item = r.items.find((i: any) => i.key === 'build')
    assert.equal((await call('PATCH', `/tasks/${t.id}/review/${item.id}`, { status: 'pass' })).status, 200)
    r = await review(t.id)
    assert.equal(r.items.find((i: any) => i.key === 'build').status, 'pass')
    // 改清单：删一项、改一项标题，检查项跟着变，人工判定保留
    await call('PATCH', `/tasks/${t.id}`, { checklist: [{ id: 'build', text: '跑通构建与类型检查', done: false }] })
    r = await review(t.id)
    assert.equal(r.items.length, 1)
    assert.equal(r.items[0].title, '跑通构建与类型检查')
    assert.equal(r.items[0].status, 'pass')
  })

  it('打回记录原因并沉淀为标准，重复原因只累加', async () => {
    const t = await newTask({ checklist: [{ id: 'ui', text: '界面无回归', done: false }] })
    const item = (await review(t.id)).items[0]
    const failed = await call('PATCH', `/tasks/${t.id}/review/${item.id}`, { status: 'fail', note: '移动端窄屏下按钮换行' })
    assert.equal(failed.body.item.status, 'fail')
    assert.equal(failed.body.item.note, '移动端窄屏下按钮换行')
    let r = await review(t.id)
    assert.ok(r.standards.includes('移动端窄屏下按钮换行'))
    // 同一原因再打回一次：标准不重复出现
    await call('PATCH', `/tasks/${t.id}/review/${item.id}`, { status: 'fail', note: '移动端窄屏下按钮换行' })
    r = await review(t.id)
    assert.equal(r.standards.filter((s: string) => s === '移动端窄屏下按钮换行').length, 1)
    // 只打回不写原因：不沉淀标准
    await call('PATCH', `/tasks/${t.id}/review/${item.id}`, { status: 'fail', note: '' })
    assert.ok(!(await review(t.id)).standards.includes(''))
  })

  it('手动补检查项，以及校验非法输入', async () => {
    const t = await newTask()
    const added = await call('POST', `/tasks/${t.id}/review`, { title: '确认文档已更新' })
    assert.equal(added.status, 200)
    assert.equal(added.body.item.manual, true)
    assert.equal((await review(t.id)).items.length, 1)
    assert.equal((await call('POST', `/tasks/${t.id}/review`, { title: '' })).status, 400)
    assert.equal((await call('PATCH', `/tasks/${t.id}/review/${added.body.item.id}`, { status: 'whatever' })).status, 400)
    assert.equal((await call('PATCH', `/tasks/${t.id}/review/999999999`, { status: 'pass' })).status, 404)
  })

  it('没有预摘要时按需抓证据；账号之间互相看不到', async () => {
    const t = await newTask()
    const sessionId = 'claude:验收会话'
    await pool.query(
      "INSERT INTO sessions(user_id,id,agent,machine,cwd,project,title,state,summary,state_since,acked,event_at,updated_at) VALUES($1,$2,'claude','验收机','','','','done','',now(),true,now(),now()) ON CONFLICT DO NOTHING",
      [a.id, sessionId],
    )
    await call('POST', `/tasks/${t.id}/sessions`, { sessionId })
    await say(sessionId, 'pnpm build 通过，输出 dist/index.js')
    await say(sessionId, 'Errors: 0')
    const r = await review(t.id)
    assert.deepEqual(r.evidence.map((e: any) => e.value), ['pnpm build 通过，输出 dist/index.js'])
    assert.equal((await call('GET', `/tasks/${t.id}/review`, undefined, b.token)).status, 404)
    // 证据来自账号自己的会话，b 的账号下没有任何标准
    assert.equal((await call('GET', '/tasks', undefined, b.token)).body.tasks.length, 0)
  })
})
