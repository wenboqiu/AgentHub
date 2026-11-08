import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../src/index.ts'
import { createPool } from '../src/db.ts'
import { createTicket } from '../src/proposals.ts'
import { RULESET_VERSION, normalizeScope } from '../src/referee.ts'
import { DATABASE_URL, makeUser } from './helpers.ts'

// Mandate：一次授权 + 不可变范围 + 结果验收。
// 每个测试用自己的电脑名与任务，账号级的 mandate_mode 在用例开头显式设置。
describe('Mandate', () => {
  const pool = createPool(DATABASE_URL)
  let app: Awaited<ReturnType<typeof buildApp>>, base: string, a: Awaited<ReturnType<typeof makeUser>>
  const peers: WebSocket[] = []
  async function call(method: string, path: string, body?: unknown) {
    const r = await app.inject({ method: method as any, url: path, headers: { authorization: `Bearer ${a.token}` }, ...(body === undefined ? {} : { payload: body as any }) })
    return { status: r.statusCode, body: r.json() }
  }
  async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 4000): Promise<T> {
    const end = Date.now() + ms
    for (;;) {
      const r = await fn()
      if (r) return r as T
      if (Date.now() > end) throw new Error('等待超时')
      await new Promise(r => setTimeout(r, 15))
    }
  }
  async function connect(query: string) {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${a.token}&${query}`), msgs: any[] = []
    ws.onmessage = e => msgs.push(JSON.parse(String(e.data)))
    peers.push(ws)
    await new Promise<void>((ok, fail) => { ws.onopen = () => ok(); ws.onerror = () => fail(new Error('连接失败')) })
    if (!query) await until(() => msgs.find(m => m.type === 'snapshot'))
    else {
      const machine = new URLSearchParams(query).get('machine')
      await until(async () => (await call('GET', '/control/status')).body.agents.includes(machine))
    }
    return { ws, msgs, send: (m: unknown) => ws.send(JSON.stringify(m)) }
  }
  let n = 0
  const setMode = async (mode: string) => assert.equal((await call('PUT', '/mandate/settings', { mode })).status, 200)
  const newTask = async (body: Record<string, unknown> = {}) => (await call('POST', '/tasks', { title: '授权测试', agent: 'claude', cwd: 'D:\\TaskTest', ...body })).body.task
  const getTask = async (id: number) => (await call('GET', '/tasks')).body.tasks.find((t: any) => t.id === id)
  const approvals = async (sessionId: string) => (await pool.query('SELECT * FROM approvals WHERE user_id=$1 AND session_id=$2 ORDER BY created_at', [a.id, sessionId])).rows
  const decisions = async (taskId: number) => (await pool.query('SELECT * FROM mandate_decisions WHERE user_id=$1 AND task_id=$2 ORDER BY id', [a.id, taskId])).rows
  // 起一台执行器、派一个任务，返回执行器与 run.start
  async function dispatch(body: Record<string, unknown> = {}, caps = 'mandate-v1') {
    const machine = `授权测试机${++n}`
    const ex = await connect(`role=agent&machine=${encodeURIComponent(machine)}&capabilities=${caps}`)
    const task = await newTask({ machine, ...body })
    const started = await call('POST', `/tasks/${task.id}/start`, {})
    assert.equal(started.status, 200, JSON.stringify(started.body))
    const start = await until(() => ex.msgs.find(m => m.type === 'run.start' && m.runId === started.body.runId))
    return { ex, task, start, sessionId: started.body.sessionId as string, runId: started.body.runId as string }
  }
  const ask = (ex: Awaited<ReturnType<typeof connect>>, runId: string, tool: string, detail: string, localId: number) =>
    ex.send({ type: 'run.approval', runId, localId, tool, detail })

  before(async () => {
    app = await buildApp(DATABASE_URL, 'silent', { reminderIntervalMs: 60000 })
    base = await app.listen({ port: 0, host: '127.0.0.1' })
    a = await makeUser(pool)
  })
  after(async () => {
    for (const ws of peers) ws.close()
    await app.close()
    await pool.query('DELETE FROM users WHERE id=$1', [a.id])
    await pool.end()
  })

  it('normalizeScope：看不懂当没声明，maxRuntimeMin 默认 30，net/push/scripts 默认 false', () => {
    const s = normalizeScope({ paths: ['../x', 'src/'], commands: ['test', 'rm', 3], allowedTools: ['Read', 5], maxRuntimeMin: -1 })
    assert.deepEqual(s.paths, ['src'])
    assert.deepEqual(s.commands, ['test'])
    assert.deepEqual(s.allowedTools, ['Read'])
    assert.equal(s.maxRuntimeMin, 30)
    assert.deepEqual([s.net, s.push, s.scripts], [false, false, false])
    assert.equal(normalizeScope(null).maxRuntimeMin, 30)
  })

  it('授权模式默认 off，可切三档，非法值 400', async () => {
    assert.equal((await call('GET', '/mandate/settings')).body.mode, 'off')
    await setMode('observe')
    assert.equal((await call('GET', '/mandate/settings')).body.mode, 'observe')
    assert.equal((await call('PUT', '/mandate/settings', { mode: 'bypass' })).status, 400)
    await setMode('off')
  })

  it('开工即签署：version 从 1 开始、写入规则表版本；冻结后改 constraints 409，原样回传不算改；重复开工不重复签署', async () => {
    await setMode('off')
    const { task } = await dispatch({ constraints: { paths: ['src'], net: false } })
    const m = (await call('GET', `/tasks/${task.id}/mandate`)).body
    assert.equal(m.mandate.version, 1)
    assert.equal(m.mandate.rulesetVersion, RULESET_VERSION)
    assert.deepEqual(m.mandate.scope.paths, ['src'])
    assert.equal(m.mandate.scope.maxRuntimeMin, 30)
    const changed = await call('PATCH', `/tasks/${task.id}`, { constraints: { paths: ['src', 'docs'], net: true } })
    assert.equal(changed.status, 409)
    assert.match(changed.body.error, /范围已冻结/)
    assert.deepEqual((await getTask(task.id)).constraints.paths, ['src'])
    assert.equal((await call('PATCH', `/tasks/${task.id}`, { constraints: { paths: ['src'] }, notes: '改备注' })).status, 200)
    // 再点开始：同一份快照，不产生 version 2
    await call('POST', `/tasks/${task.id}/start`, {}).catch(() => null)
    const rows = (await pool.query('SELECT version FROM task_mandates WHERE user_id=$1 AND task_id=$2', [a.id, task.id])).rows
    assert.deepEqual(rows.map(r => r.version), [1])
    // 新任务的 version 重新从 1 开始
    const other = await dispatch()
    assert.equal((await call('GET', `/tasks/${other.task.id}/mandate`)).body.mandate.version, 1)
  })

  it('确认任务单即签署：confirm 之后范围冻结', async () => {
    const p = await createTicket(pool, a.id, { title: '确认即签署', notes: '', projectId: null, projectName: '', roleId: null, machine: '', cwd: '' })
    const r = await call('POST', `/proposals/${p.id}/confirm`, { dispatch: false })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const id = r.body.task.id
    assert.equal((await call('GET', `/tasks/${id}/mandate`)).body.mandate.version, 1)
    assert.equal((await call('PATCH', `/tasks/${id}`, { constraints: { net: true } })).status, 409)
  })

  it('手工 PATCH done：有 mandate / 有会话的任务 409，纯人工任务仍可', async () => {
    const manual = await newTask()
    const ok = await call('PATCH', `/tasks/${manual.id}`, { status: 'done' })
    assert.equal(ok.status, 200)
    assert.ok(ok.body.task.doneAt)
    const { task } = await dispatch()
    assert.equal((await call('PATCH', `/tasks/${task.id}`, { status: 'done' })).status, 409)
    assert.equal((await getTask(task.id)).status, 'doing')
  })

  it('mode=off：审批照旧推给人，不留任何 Mandate 决策', async () => {
    await setMode('off')
    const v = await connect('')
    const { ex, task, runId, sessionId, start } = await dispatch({ constraints: { paths: ['src'] } }, 'mandate-v1')
    assert.equal(start.mandate, undefined, 'off 档不下发 mandate')
    ask(ex, runId, 'Write', 'src/a.ts\nhi', 1)
    await until(() => ex.msgs.find(m => m.type === 'approval.created'))
    const pushed = await until(() => v.msgs.find(m => m.type === 'approval' && m.approval.sessionId === sessionId))
    assert.equal(pushed.approval.status, 'pending')
    assert.equal((await approvals(sessionId)).length, 1)
    assert.equal((await decisions(task.id)).length, 0)
    assert.equal(ex.msgs.find(m => m.type === 'approval.decide'), undefined)
  })

  it('mode=observe：每条审批落一条决策、审批流程不变、不下发 mandate', async () => {
    await setMode('observe')
    const v = await connect('')
    const { ex, task, runId, sessionId, start } = await dispatch({ constraints: { paths: ['src'] } })
    assert.equal(start.mandate, undefined, 'observe 档不下发 mandate')
    ask(ex, runId, 'Write', 'src/a.ts\nhi', 1) // 范围内
    ask(ex, runId, 'Write', 'docs/b.md\nhi', 2) // 范围外
    ask(ex, runId, 'Bash', 'rm -rf build', 3) // danger
    await until(async () => (await approvals(sessionId)).length === 3)
    const rows = await until(async () => { const r = await decisions(task.id); return r.length === 3 ? r : undefined })
    assert.equal((await approvals(sessionId)).length, rows.length)
    assert.deepEqual(rows.map(r => r.in_scope), [true, false, false])
    assert.deepEqual(rows.map(r => r.would_allow), [true, false, false])
    assert.equal(rows[2].tier, 'danger')
    assert.ok(rows.every(r => r.mode === 'observe' && r.rule && r.approval_id))
    // 流程不变：三条都是 pending 并推给了人（代批没开），执行器没收到任何放行
    assert.equal((await approvals(sessionId)).filter(r => r.status === 'pending').length, 3)
    assert.equal(v.msgs.filter(m => m.type === 'approval' && m.approval.sessionId === sessionId).length, 3)
    assert.equal(ex.msgs.find(m => m.type === 'approval.decide'), undefined)
    const stats = (await call('GET', `/tasks/${task.id}/mandate`)).body.stats
    assert.deepEqual(stats, { total: 3, wouldAllow: 1, wouldAsk: 2 })
  })

  it('mode=auto + mandate-v1：run.start 带 mandate；范围内零审批，范围外与 danger 交人并标 in_scope=false', async () => {
    await setMode('auto')
    const v = await connect('')
    const { ex, task, runId, sessionId, start } = await dispatch({ constraints: { paths: ['src'] } })
    assert.equal(start.mandate.mode, 'auto')
    assert.equal(start.mandate.version, 1)
    assert.equal(start.mandate.rulesetVersion, RULESET_VERSION)
    assert.deepEqual(start.mandate.scope.paths, ['src'])
    assert.equal(start.mandate.scope.maxRuntimeMin, 30)
    assert.equal(start.mandate.scope.net, false)
    const before = v.msgs.length
    ask(ex, runId, 'Write', 'src/a.ts\nhi', 10)
    const created = await until(() => ex.msgs.find(m => m.type === 'approval.created' && m.localId === 10))
    const decide = await until(() => ex.msgs.find(m => m.type === 'approval.decide' && m.approvalId === created.approvalId))
    assert.equal(decide.decision, 'allow')
    // 范围内：没有审批行、没有 approval 消息、没有 approval 广播
    assert.equal((await approvals(sessionId)).length, 0)
    assert.equal((await pool.query("SELECT 1 FROM messages WHERE user_id=$1 AND session_id=$2 AND role='approval'", [a.id, sessionId])).rowCount, 0)
    assert.equal(v.msgs.slice(before).filter(m => m.type === 'approval').length, 0)
    assert.equal((await decisions(task.id)).length, 1)
    // 范围外 / danger：照旧建审批行，带 in_scope=false，并推给人
    ask(ex, runId, 'Write', 'docs/b.md\nhi', 11)
    ask(ex, runId, 'Bash', 'rm -rf build', 12)
    // 审批行先建、再打标：等两条都打完标
    const rows = await until(async () => { const r = await approvals(sessionId); return r.length === 2 && r.every(x => x.in_scope === false) ? r : undefined })
    assert.ok(rows.every(r => r.status === 'pending' && r.in_scope === false && r.mandate_id !== null), JSON.stringify(rows))
    assert.deepEqual(rows.map(r => r.decision_tier).sort(), ['danger', 'gray'])
    await until(() => v.msgs.filter(m => m.type === 'approval' && m.approval.sessionId === sessionId).length === 2)
    assert.equal(ex.msgs.filter(m => m.type === 'approval.decide').length, 1)
    const all = await decisions(task.id)
    assert.deepEqual(all.map(r => r.mode), ['auto', 'auto', 'auto'])
  })

  it('mode=auto 但执行器没有 mandate-v1：不下发 mandate，也不自动放行（降级到逐条审批）', async () => {
    await setMode('auto')
    const { ex, task, runId, sessionId, start } = await dispatch({ constraints: { paths: ['src'] } }, 'role-v1')
    assert.equal(start.mandate, undefined)
    ask(ex, runId, 'Write', 'src/a.ts\nhi', 20)
    await until(async () => (await approvals(sessionId)).length === 1)
    assert.equal((await approvals(sessionId))[0].status, 'pending')
    assert.equal(ex.msgs.find(m => m.type === 'approval.decide'), undefined)
    const rows = await until(async () => { const r = await decisions(task.id); return r.length ? r : undefined })
    assert.equal(rows[0].mode, 'observe')
  })

  // 让任务走到待验收：关联一个真实会话，再用事件把它推成 done（run.status 只管 pending 会话，不会推任务状态）
  let tick = 0
  const finish = async (taskId: number, machine: string, key: string) => {
    const ev = (state: string) => call('POST', '/events', { events: [{ agent: 'claude', sessionId: key, machine, cwd: 'D:\\TaskTest', state, at: new Date(Date.now() + 1000 * ++tick).toISOString() }] })
    assert.equal((await ev('running')).status, 200)
    assert.equal((await call('POST', `/tasks/${taskId}/sessions`, { sessionId: `claude:${key}` })).status, 200)
    assert.equal((await ev('done')).status, 200)
    await until(async () => (await getTask(taskId)).status === 'review')
  }
  async function toReview(extra: Record<string, unknown> = {}) {
    await setMode('off')
    const d = await dispatch(extra)
    const key = randomUUID()
    await finish(d.task.id, d.task.machine, key)
    return { ...d, key }
  }

  it('进入待验收写交付物；accept 门禁：检查项未全 pass、有待处理审批都 409；通过后 done 并盖章', async () => {
    const d = await toReview({ checklist: [{ id: 'c1', text: '跑通测试', done: false }] })
    const delivery = (await call('GET', `/tasks/${d.task.id}/mandate`)).body.delivery
    assert.ok(delivery, '进入 review 时应有交付物')
    assert.equal(delivery.acceptedAt, null)
    assert.ok(delivery.sessions.length >= 1)
    // 检查项没过
    const blocked = await call('POST', `/tasks/${d.task.id}/accept`, {})
    assert.equal(blocked.status, 409)
    assert.match(blocked.body.error, /检查项/)
    const items = (await call('GET', `/tasks/${d.task.id}/review`)).body.items
    assert.equal((await call('PATCH', `/tasks/${d.task.id}/review/${items[0].id}`, { status: 'pass' })).status, 200)
    // 有待处理审批
    await pool.query("INSERT INTO approvals(id,user_id,run_id,session_id,tool,detail,status) VALUES($1,$2,$3,$4,'Bash','ls','pending')", [`t-${d.runId}`, a.id, d.runId, d.sessionId])
    const pending = await call('POST', `/tasks/${d.task.id}/accept`, {})
    assert.equal(pending.status, 409)
    assert.match(pending.body.error, /审批/)
    await pool.query('DELETE FROM approvals WHERE user_id=$1 AND session_id=$2', [a.id, d.sessionId])
    const ok = await call('POST', `/tasks/${d.task.id}/accept`, {})
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.equal(ok.body.task.status, 'done')
    assert.ok(ok.body.task.doneAt)
    assert.ok(ok.body.delivery.acceptedAt)
    assert.equal(ok.body.delivery.acceptedBy, 'user')
    // 不在 review 的任务不能验收
    assert.equal((await call('POST', `/tasks/${d.task.id}/accept`, {})).status, 409)
  })

  it('重跑再进 review：未验收的交付物被覆盖，已验收的不动', async () => {
    const d = await toReview()
    const first = (await call('GET', `/tasks/${d.task.id}/mandate`)).body.delivery
    // 重新开跑再完成：同一个真实会话再跑一轮（running 把任务拉回 doing，done 再进 review）
    const again = await call('POST', `/tasks/${d.task.id}/start`, {})
    assert.equal(again.status, 200)
    await finish(d.task.id, d.task.machine, d.key)
    const second = await until(async () => {
      const x = (await call('GET', `/tasks/${d.task.id}/mandate`)).body.delivery
      return x && x.runs.length >= 2 ? x : undefined
    })
    assert.equal((await pool.query('SELECT count(*)::int n FROM task_deliveries WHERE user_id=$1 AND task_id=$2', [a.id, d.task.id])).rows[0].n, 1)
    assert.ok(second.createdAt >= first.createdAt)
    assert.equal((await call('POST', `/tasks/${d.task.id}/accept`, {})).status, 200)
    // 已验收：再写入不覆盖
    const accepted = (await call('GET', `/tasks/${d.task.id}/mandate`)).body.delivery
    await pool.query('UPDATE tasks SET status=$3 WHERE user_id=$1 AND id=$2', [a.id, d.task.id, 'review'])
    const { createDelivery } = await import('../src/mandate.ts')
    await createDelivery(pool, a.id, d.task.id, { marker: 'overwrite' })
    const after = (await call('GET', `/tasks/${d.task.id}/mandate`)).body.delivery
    assert.equal(after.acceptedAt, accepted.acceptedAt)
    assert.notDeepEqual(after.digest, { marker: 'overwrite' })
  })

  it('打回：生成新的待确认提案，原任务保持 review，新提案确认后是新任务 + 新 Mandate', async () => {
    const d = await toReview({ checklist: [{ id: 'c1', text: '补测试', done: false }], constraints: { paths: ['src'] } })
    const items = (await call('GET', `/tasks/${d.task.id}/review`)).body.items
    const r = await call('PATCH', `/tasks/${d.task.id}/review/${items[0].id}`, { status: 'fail', note: '没有补测试' })
    assert.equal(r.status, 200)
    assert.equal((await getTask(d.task.id)).status, 'review')
    const rows = (await pool.query("SELECT * FROM session_proposals WHERE user_id=$1 AND task_id=$2 AND status='pending'", [a.id, d.task.id])).rows
    assert.equal(rows.length, 1)
    assert.match(rows[0].title, /打回重做/)
    assert.match(rows[0].notes, /没有补测试/)
    assert.match(rows[0].notes, /v1/)
    const confirmed = await call('POST', `/proposals/${rows[0].id}/confirm`, { dispatch: false })
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))
    assert.notEqual(confirmed.body.task.id, d.task.id)
    assert.equal((await call('GET', `/tasks/${confirmed.body.task.id}/mandate`)).body.mandate.version, 1)
    assert.equal((await getTask(d.task.id)).status, 'review')
  })

  it('没有 Mandate 的任务打回仍只沉淀经验，不生成提案', async () => {
    const t = await newTask({ checklist: [{ id: 'c1', text: '检查', done: false }] })
    await call('PATCH', `/tasks/${t.id}`, { status: 'review' })
    const items = (await call('GET', `/tasks/${t.id}/review`)).body.items
    assert.equal((await call('PATCH', `/tasks/${t.id}/review/${items[0].id}`, { status: 'fail', note: '不行' })).status, 200)
    assert.equal((await pool.query('SELECT 1 FROM session_proposals WHERE user_id=$1 AND task_id=$2', [a.id, t.id])).rowCount, 0)
  })

  it('看板：mode=off 保持原样；开了 Mandate 只留需要人的项（待验收 / 等审批）', async () => {
    await setMode('off')
    const healthy = await dispatch()
    const review = await toReview()
    const entries = async () => (await call('GET', '/dispatch/board')).body.entries as any[]
    assert.ok((await entries()).some(e => e.taskId === healthy.task.id), 'off：健康任务在板上')
    await setMode('observe')
    const list = await entries()
    assert.equal(list.some(e => e.taskId === healthy.task.id), false, '健康任务不出现')
    assert.ok(list.some(e => e.taskId === review.task.id && e.status === 'review'), '待验收出现')
    ask(healthy.ex, healthy.runId, 'Write', 'x.ts\nhi', 30)
    await until(async () => (await entries()).some(e => e.taskId === healthy.task.id && e.waitingApproval))
    await setMode('off')
  })
})
