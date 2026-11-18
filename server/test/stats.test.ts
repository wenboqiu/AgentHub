import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { buildApp } from '../src/index.ts'
import { DATABASE_URL, makeUser } from './helpers.ts'
import { createPendingSession, purgeOld, renamePendingSession } from '../src/db.ts'
import { backfillStats, rollupStats } from '../src/stats.ts'

const TZ = 'Asia/Shanghai'

describe('数据统计', () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 })
  let app: Awaited<ReturnType<typeof buildApp>>
  const prefix = `st-${Date.now()}`
  let n = 0

  before(async () => { app = await buildApp(DATABASE_URL, 'silent', {}) })
  after(async () => { await app.close(); await pool.end() })

  // 统计时区下「今天 - daysAgo」这一天的 hour 点，返回 Date
  async function at(daysAgo: number, hour = 12): Promise<Date> {
    const r = await pool.query<{ t: Date }>(
      `SELECT (((now() AT TIME ZONE $1)::date - $2::int)::timestamp + $3::int * interval '1 hour') AT TIME ZONE $1 AS t`, [TZ, daysAgo, hour])
    return r.rows[0].t
  }
  async function dayStr(daysAgo: number): Promise<string> {
    return (await pool.query<{ d: string }>(`SELECT ((now() AT TIME ZONE $1)::date - $2::int)::text AS d`, [TZ, daysAgo])).rows[0].d
  }
  const get = async (token: string, qs: string) =>
    app.inject({ method: 'GET', url: `/stats?${qs}`, headers: { authorization: `Bearer ${token}` } })
  async function newSession(userId: number, id: string, agent: string, project: string, firstSeen: Date) {
    await pool.query(
      `INSERT INTO sessions (user_id, id, agent, machine, cwd, project, state, state_since, event_at, first_seen_at)
       VALUES ($1,$2,$3,'pc','',$4,'idle',$5,$5,$5)`, [userId, id, agent, project, firstSeen])
  }
  const bucket = (userId: number, sid: string, t: Date, count: number) =>
    pool.query('INSERT INTO session_activity (user_id, session_id, bucket, count) VALUES ($1,$2,$3,$4)', [userId, sid, t, count])
  async function newRun(userId: number, o: { sid?: string | null; taskId?: number | null; status: string; created: Date; secs?: number; usage?: unknown; model?: string | null }) {
    await pool.query(
      `INSERT INTO runs (id, user_id, session_id, task_id, machine, status, created_at, updated_at, usage, model)
       VALUES ($1,$2,$3,$4,'pc',$5,$6,$7,$8,$9)`,
      [`${prefix}-r${n++}`, userId, o.sid ?? null, o.taskId ?? null, o.status, o.created, new Date(o.created.getTime() + (o.secs ?? 60) * 1000),
        o.usage === undefined ? null : JSON.stringify(o.usage), o.model ?? null])
  }
  async function newTask(userId: number, o: { status?: string; created: Date; done?: Date | null; projectId?: number | null; agent?: string | null }): Promise<number> {
    const r = await pool.query(
      `INSERT INTO tasks (user_id, title, status, created_at, updated_at, done_at, project_id, agent) VALUES ($1,'t',$2,$3,$3,$4,$5,$6) RETURNING id`,
      [userId, o.status ?? 'todo', o.created, o.done ?? null, o.projectId ?? null, o.agent ?? null])
    return Number(r.rows[0].id)
  }
  const rowsOf = async (userId: number) => (await pool.query(
    `SELECT day::text, agent, project, sessions_new, sessions_active, messages, runs, runs_done, runs_failed, runs_stopped, run_seconds,
       tokens_in, tokens_out, cost_usd::text, credits::text, tasks_created, tasks_done, task_done_seconds, review_rejects
     FROM daily_stats WHERE user_id = $1 ORDER BY day, agent, project`, [userId])).rows
  const modelRowsOf = async (userId: number) => (await pool.query(
    'SELECT day::text, model, runs, tokens_in, tokens_out, cost_usd::text, credits::text FROM daily_model_stats WHERE user_id = $1 ORDER BY day, model', [userId])).rows

  // 主数据集：day-3 / day-2 / day-4
  let main: { id: number; token: string }
  before(async () => {
    main = await makeUser(pool)
    const u = main.id
    const d3 = await at(3, 10), d2 = await at(2, 10), d4 = await at(4, 10)
    await newSession(u, 'claude:s1', 'claude', 'alpha', d3)
    await newSession(u, 'codex:s2', 'codex', 'beta', d3)
    await newSession(u, 'claude:s3', 'claude', 'alpha', d2)
    await bucket(u, 'claude:s1', d3, 3)
    await bucket(u, 'claude:s1', new Date(d3.getTime() + 3600_000), 2)
    await bucket(u, 'codex:s2', d3, 4)
    await bucket(u, 'claude:s1', d2, 1)
    await bucket(u, 'claude:gone', d2, 7) // 会话已被清理
    const pj = Number((await pool.query(`INSERT INTO projects (user_id, name) VALUES ($1,'X') RETURNING id`, [u])).rows[0].id)
    const t1 = await newTask(u, { created: d3, projectId: pj })
    await newTask(u, { status: 'done', created: d4, done: d3 })
    await pool.query(`INSERT INTO review_items (user_id, task_id, item_key, title, status, updated_at) VALUES ($1,$2,'a','a','fail',$3),($1,$2,'b','b','pass',$3)`, [u, t1, d3])
    await newRun(u, { sid: 'claude:s1', status: 'done', created: d3, secs: 600, usage: { input: 100, output: 50, total: 150, costUsd: 0.5 }, model: 'm1' })
    await newRun(u, { sid: 'claude:s1', status: 'failed', created: d3, secs: 300, usage: null })
    await newRun(u, { sid: 'codex:s2', status: 'stopped', created: d3, secs: 60, usage: { input: 10, output: 5, total: 15, credits: 3 }, model: 'm1' })
    await newRun(u, { taskId: t1, status: 'running', created: d3, secs: 999 })
    await rollupStats(pool, { userId: u, tz: TZ })
  })

  it('聚合正确：日粒度各指标、usage 为 null 不报错', async () => {
    const d4 = await dayStr(4), d3 = await dayStr(3), d2 = await dayStr(2)
    const res = await get(main.token, `from=${d4}&to=${d2}&granularity=day`)
    assert.equal(res.statusCode, 200, res.body)
    const j = res.json()
    assert.equal(j.tz, TZ)
    assert.deepEqual(j.series.map((s: any) => s.period), [d4, d3, d2])
    const [s4, s3, s2] = j.series
    assert.equal(s4.tasksCreated, 1)
    assert.equal(s3.sessionsNew, 2)
    assert.equal(s3.sessionsActive, 2)
    assert.equal(s3.messages, 9)
    assert.equal(s3.runs, 4)
    assert.equal(s3.runsDone, 1)
    assert.equal(s3.runsFailed, 1)
    assert.equal(s3.runsStopped, 1)
    assert.equal(s3.runSeconds, 960) // running 的不计
    assert.equal(s3.tokensIn, 110)
    assert.equal(s3.tokensOut, 55)
    assert.equal(s3.costUsd, 0.5)
    assert.equal(s3.credits, 3)
    assert.equal(s3.tasksCreated, 1)
    assert.equal(s3.tasksDone, 1)
    assert.equal(s3.taskDoneSeconds, 86400)
    assert.equal(s3.reviewRejects, 1)
    assert.equal(s2.sessionsNew, 1)
    assert.equal(s2.sessionsActive, 2)
    assert.equal(s2.messages, 8)
    assert.equal(j.totals.runs, 4)
    assert.deepEqual(j.snapshot, { todo: 1, doing: 0, review: 0, done: 1 })
    assert.deepEqual(j.breakdown, { by: 'none', rows: [] })
  })

  it('拆分：agent / project / model', async () => {
    const d3 = await dayStr(3), d2 = await dayStr(2)
    const by = async (k: string) => (await get(main.token, `from=${d3}&to=${d2}&by=${k}`)).json().breakdown.rows as any[]
    const agent = Object.fromEntries((await by('agent')).map(r => [r.key, r]))
    assert.equal(agent.claude.runs, 2)
    assert.equal(agent.codex.runs, 1)
    assert.equal(agent[''].runs, 1) // 只有任务、任务没指定 agent
    assert.equal(agent.claude.sessionsNew, 2)
    const project = Object.fromEntries((await by('project')).map(r => [r.key, r]))
    assert.equal(project.alpha.runs, 2)
    assert.equal(project.beta.runs, 1)
    assert.equal(project.X.runs, 1, '无会话的运行取任务的项目名')
    assert.equal(project.X.tasksCreated, 1)
    const model = await by('model')
    const m = Object.fromEntries(model.map(r => [r.key, r]))
    assert.equal(m.m1.runs, 2)
    assert.equal(m.m1.tokensIn, 110)
    assert.equal(m.m1.costUsd, 0.5)
    assert.equal(m[''].runs, 2)
    assert.equal(m.m1.sessionsNew, 0)
  })

  it('幂等：连跑两次 daily_stats / daily_model_stats 内容不变', async () => {
    const a = await rowsOf(main.id), am = await modelRowsOf(main.id)
    assert.ok(a.length > 0)
    await rollupStats(pool, { userId: main.id, tz: TZ })
    await rollupStats(pool, { userId: main.id, tz: TZ })
    assert.deepEqual(await rowsOf(main.id), a)
    assert.deepEqual(await modelRowsOf(main.id), am)
  })

  it('时区边界：北京时间 23:30 与次日 00:30 分属两天', async () => {
    const u = await makeUser(pool)
    await newTask(u.id, { created: new Date('2026-11-03T15:30:00Z') })
    await newTask(u.id, { created: new Date('2026-11-03T16:30:00Z') })
    await rollupStats(pool, { userId: u.id, tz: TZ })
    const j = (await get(u.token, 'from=2026-11-03&to=2026-11-04')).json()
    assert.deepEqual(j.series.map((s: any) => [s.period, s.tasksCreated]), [['2026-11-03', 1], ['2026-11-04', 1]])
  })

  it('封存：窗口外的历史行不动，窗口内的行被重算', async () => {
    const u = await makeUser(pool)
    const old = await dayStr(40), recent = await dayStr(1)
    await pool.query(`INSERT INTO daily_stats (user_id, day, agent, project, runs, tasks_created) VALUES ($1,$2,'zz','p',5,2)`, [u.id, old])
    await pool.query(`INSERT INTO daily_stats (user_id, day, agent, project, runs) VALUES ($1,$2,'fake','',9)`, [u.id, recent])
    await rollupStats(pool, { userId: u.id, tz: TZ })
    await purgeOld(pool)
    const rows = await rowsOf(u.id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].day, old)
    assert.equal(rows[0].runs, 5)
    assert.equal(rows[0].tasks_created, 2)
  })

  it('周 / 月合并：period 对齐周一 / 1 号，缺数据补 0 且连续', async () => {
    const u = await makeUser(pool)
    for (const d of ['2026-09-15', '2026-10-31', '2026-11-02', '2026-11-09']) await newTask(u.id, { created: new Date(`${d}T04:00:00Z`) })
    await rollupStats(pool, { userId: u.id, tz: TZ })
    const w = (await get(u.token, 'from=2026-09-15&to=2026-11-09&granularity=week')).json()
    assert.equal(w.from, '2026-09-14', 'from 向下对齐到周一')
    assert.deepEqual(w.series.map((s: any) => s.period), ['2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09'])
    assert.deepEqual(w.series.map((s: any) => s.tasksCreated), [1, 0, 0, 0, 0, 0, 1, 1, 1])
    const m = (await get(u.token, 'from=2026-09-20&to=2026-11-09&granularity=month')).json()
    assert.equal(m.from, '2026-09-01')
    assert.deepEqual(m.series.map((s: any) => [s.period, s.tasksCreated]), [['2026-09-01', 1], ['2026-10-01', 1], ['2026-11-01', 2]])
    assert.equal(m.totals.tasksCreated, 4)
  })

  it('previous：紧邻 from 之前、等长的一段', async () => {
    const u = await makeUser(pool)
    await newTask(u.id, { created: new Date('2026-10-31T04:00:00Z') })
    await newTask(u.id, { created: new Date('2026-11-02T04:00:00Z') })
    await newTask(u.id, { created: new Date('2026-11-03T04:00:00Z') })
    await rollupStats(pool, { userId: u.id, tz: TZ })
    const j = (await get(u.token, 'from=2026-11-02&to=2026-11-04')).json()
    assert.equal(j.totals.tasksCreated, 2)
    assert.equal(j.previous.from, '2026-10-30')
    assert.equal(j.previous.to, '2026-11-01')
    assert.equal(j.previous.totals.tasksCreated, 1)
  })

  it('参数校验：非法返回 400', async () => {
    for (const qs of [
      'from=2026-13-01', 'from=abc', 'to=2026-02-30', 'from=2026-11-05&to=2026-11-01',
      'from=2024-01-01&to=2026-11-09&granularity=day',
      'from=2020-01-01&to=2026-11-09&granularity=week',
      'from=2020-01-01&to=2026-11-09&granularity=month',
      'granularity=year', 'by=foo',
    ]) {
      const r = await get(main.token, qs)
      assert.equal(r.statusCode, 400, qs)
      assert.ok(r.json().error, qs)
    }
    assert.equal((await get(main.token, '')).statusCode, 200)
    assert.equal((await app.inject({ method: 'GET', url: '/stats' })).statusCode, 401)
  })

  it('first_seen_at：事件新建会话后有值，再来事件不变', async () => {
    const u = await makeUser(pool)
    const send = (iso: string) => app.inject({ method: 'POST', url: '/events', headers: { authorization: `Bearer ${u.token}` },
      payload: { events: [{ agent: 'claude', sessionId: `${prefix}-ev`, machine: 'pc', cwd: 'D:/x', state: 'running', at: iso }] } })
    assert.equal((await send(new Date(Date.now() - 5000).toISOString())).json().accepted, 1)
    const first = (await pool.query('SELECT first_seen_at FROM sessions WHERE user_id = $1', [u.id])).rows[0].first_seen_at
    assert.ok(first instanceof Date)
    assert.equal((await send(new Date().toISOString())).json().accepted, 1)
    const again = (await pool.query('SELECT first_seen_at FROM sessions WHERE user_id = $1', [u.id])).rows[0].first_seen_at
    assert.equal(again.getTime(), first.getTime())
  })

  it('renamePendingSession 合并分支：first_seen_at 取较早者', async () => {
    const u = await makeUser(pool)
    const early = new Date(Date.now() - 5 * 86400_000), late = new Date(Date.now() - 1 * 86400_000)
    // 临时行较早
    await createPendingSession(pool, u.id, 'claude:pending-a', { agent: 'claude', machine: 'pc', cwd: 'D:/x' }, 'pt')
    await pool.query(`UPDATE sessions SET first_seen_at = $3 WHERE user_id = $1 AND id = $2`, [u.id, 'claude:pending-a', early])
    await newSession(u.id, 'claude:real-a', 'claude', 'x', late)
    await renamePendingSession(pool, u.id, 'claude:pending-a', 'claude:real-a')
    const a = (await pool.query(`SELECT first_seen_at FROM sessions WHERE user_id = $1 AND id = 'claude:real-a'`, [u.id])).rows[0].first_seen_at
    assert.equal(a.getTime(), early.getTime())
    // 真实行较早
    await createPendingSession(pool, u.id, 'claude:pending-b', { agent: 'claude', machine: 'pc', cwd: 'D:/x' }, 'pt')
    await newSession(u.id, 'claude:real-b', 'claude', 'x', early)
    await renamePendingSession(pool, u.id, 'claude:pending-b', 'claude:real-b')
    const b = (await pool.query(`SELECT first_seen_at FROM sessions WHERE user_id = $1 AND id = 'claude:real-b'`, [u.id])).rows[0].first_seen_at
    assert.equal(b.getTime(), early.getTime())
    assert.equal((await pool.query('SELECT 1 FROM sessions WHERE user_id = $1', [u.id])).rowCount, 2)
  })

  it('回填：新用户第一次 rollup 把 60 天前的任务、45 天前的运行补进对应的天', async () => {
    const u = await makeUser(pool)
    await newTask(u.id, { created: await at(60) })
    await newRun(u.id, { status: 'done', created: await at(45), secs: 120, usage: { input: 7, output: 3, total: 10 } })
    assert.equal((await rowsOf(u.id)).length, 0)
    await rollupStats(pool, { userId: u.id, tz: TZ })
    const rows = await rowsOf(u.id)
    const d60 = await dayStr(60), d45 = await dayStr(45)
    assert.equal(rows.find(r => r.day === d60)?.tasks_created, 1)
    const r45 = rows.find(r => r.day === d45)
    assert.equal(r45?.runs, 1)
    assert.equal(r45?.tokens_in, '7')
    assert.equal(await backfillStats(pool, u.id, TZ), false, '已有数据不再回填')
  })
})
