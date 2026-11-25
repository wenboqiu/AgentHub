import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../src/index.ts'
import { createPool } from '../src/db.ts'
import { DEFAULT_SETTINGS, evaluateNotify, inQuietWindow, normalizeSettings } from '../src/notify.ts'
import { DATABASE_URL, makeUser } from './helpers.ts'

describe('通知两级过滤管线', () => {
  const pool = createPool(DATABASE_URL)
  let app: Awaited<ReturnType<typeof buildApp>>, base: string, a: Awaited<ReturnType<typeof makeUser>>, b: typeof a
  const peers: WebSocket[] = []
  async function call(method: string, path: string, body?: unknown, token = a.token) {
    const r = await app.inject({ method: method as any, url: path, headers: { authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { payload: body as any }) })
    return { status: r.statusCode, body: r.json() }
  }
  // 等一条满足条件的 WS 消息（最多 30 秒；全量并行时定时器测试会被资源竞争拖慢——
  // 几个套件共用一条到远程测试库的连接，watchdog 扫残留会话时隧道会被打满）
  async function waitFor<T>(msgs: any[], pred: (m: any) => boolean): Promise<T> {
    const until = Date.now() + 30_000
    for (;;) {
      const found = msgs.findLast(pred)
      if (found) return found as T
      if (Date.now() > until) throw new Error('等待广播超时')
      await new Promise(r => setTimeout(r, 10))
    }
  }
  async function connect(token = a.token) {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${token}`)
    const msgs: any[] = []
    ws.onmessage = e => msgs.push(JSON.parse(String(e.data)))
    peers.push(ws)
    await new Promise<void>((ok, fail) => { ws.onopen = () => ok(); ws.onerror = () => fail(new Error('连接失败')) })
    await waitFor(msgs, (m: any) => m.type === 'snapshot')
    return msgs
  }
  // 上报一个会话事件并等 WS 广播，返回 notify 值
  async function eventNotify(agent: 'claude' | 'codex', state: 'done' | 'aborted' | 'waiting', msgs: any[], key = randomUUID()) {
    const id = `${agent}:${key}`
    assert.equal((await call('POST', '/events', { events: [{ agent, sessionId: key, machine: '过滤测试机', cwd: 'D:\\NotifyTest', state, at: new Date().toISOString() }] })).status, 200)
    const m = await waitFor<any>(msgs, (m: any) => m.type === 'session' && m.session.id === id)
    return { notify: m.notify as boolean, key }
  }
  const newTask = async (body: Record<string, unknown> = {}) => (await call('POST', '/tasks', { title: '过滤测试任务', ...body })).body.task

  before(async () => {
    app = await buildApp(DATABASE_URL, process.env.DIAG ? 'info' : 'silent', { reminderIntervalMs: 30 })
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

  it('免打扰时段判断：普通窗口、跨午夜、全天', () => {
    const tz = 480
    const at = (utcHour: number) => new Date(Date.UTC(2026, 0, 1, utcHour, 0))
    // 22:00–08:00（跨午夜）：本地 23:00 在窗口内，12:00 不在
    const q = { enabled: true, start: '22:00', end: '08:00', tzOffsetMinutes: tz, muteKinds: ['done' as const] }
    assert.equal(inQuietWindow(at(15), q), true)   // UTC 15:00 = 本地 23:00
    assert.equal(inQuietWindow(at(14), q), true)   // UTC 14:00 = 本地 22:00，窗口含头
    assert.equal(inQuietWindow(at(0), q), false)   // UTC 00:00 = 本地 08:00，窗口不含尾
    assert.equal(inQuietWindow(at(5), q), false)   // UTC 05:00 = 本地 13:00
    // 普通窗口 09:00–12:00：12:00 是开区间外
    const day = { ...q, start: '09:00', end: '12:00' }
    assert.equal(inQuietWindow(at(2), day), true)  // 本地 10:00
    assert.equal(inQuietWindow(at(4), day), false) // 本地 12:00
    // start === end 视为全天
    assert.equal(inQuietWindow(at(5), { ...q, start: '00:00', end: '00:00' }), true)
  })

  it('设置规范化：合并、去重、拒绝非法值与未知字段', () => {
    const s = normalizeSettings({ agents: { claude: false }, quiet: { enabled: true, muteKinds: ['done', 'done'] } }, DEFAULT_SETTINGS)
    assert.equal(s.agents.claude, false)
    assert.equal(s.agents.codex, true)
    assert.equal(s.minPriority, 'low')
    assert.deepEqual(s.quiet.muteKinds, ['done'])
    for (const bad of [
      { agents: { nope: true } }, { agents: { claude: 'yes' } }, { minPriority: 'urgent' },
      { quiet: { start: '25:00' } }, { quiet: { tzOffsetMinutes: 9999 } }, { quiet: { muteKinds: ['waiting'] } },
      { unknown: 1 }, { quiet: { whatever: 1 } }, 'x', 5,
    ]) assert.throws(() => normalizeSettings(bad, DEFAULT_SETTINGS))
  })

  it('设置接口：默认值、保存、账号隔离、非法值 400', async () => {
    const d = (await call('GET', '/notify/settings')).body.settings
    assert.equal(d.minPriority, 'low')
    assert.equal(d.agents.claude, true)
    const saved = (await call('PATCH', '/notify/settings', { agents: { codex: false }, minPriority: 'high' })).body.settings
    assert.equal(saved.agents.codex, false)
    assert.equal(saved.minPriority, 'high')
    assert.equal((await call('GET', '/notify/settings')).body.settings.agents.codex, false)
    // 另一个账号不受影响；恢复 a 的设置
    assert.equal((await call('GET', '/notify/settings', undefined, b.token)).body.settings.agents.codex, true)
    for (const bad of [{ agents: { claude: 1 } }, { minPriority: 'bad' }, { quiet: { start: '9:00' } }])
      assert.equal((await call('PATCH', '/notify/settings', bad)).status, 400)
    await call('PATCH', '/notify/settings', { agents: { codex: true }, minPriority: 'low' })
  })

  it('事件过滤：agent 静音、等待授权放行、免打扰只静音配置的类型', async () => {
    const msgs = await connect()
    await call('PATCH', '/notify/settings', { agents: { claude: false } })
    assert.equal((await eventNotify('claude', 'done', msgs)).notify, false)
    // 等待授权永远放行（审批 30 分钟无人处理按拒绝处理，不能静音）
    assert.equal((await eventNotify('claude', 'waiting', msgs)).notify, true)
    // 没静音的 agent 正常通知
    assert.equal((await eventNotify('codex', 'done', msgs)).notify, true)
    // 全天免打扰只静音 done，aborted（失败）仍要提醒
    await call('PATCH', '/notify/settings', { agents: { claude: true }, quiet: { enabled: true, start: '00:00', end: '00:00', muteKinds: ['done'] } })
    assert.equal((await eventNotify('claude', 'done', msgs)).notify, false)
    assert.equal((await eventNotify('claude', 'aborted', msgs)).notify, true)
    await call('PATCH', '/notify/settings', { quiet: { enabled: false } })
  })

  it('优先级门槛：未关联会话按中优先级，关联高优先级任务后放行', async () => {
    const msgs = await connect()
    await call('PATCH', '/notify/settings', { minPriority: 'high' })
    // 未关联任务的会话按 medium，达不到 high
    assert.equal((await eventNotify('claude', 'done', msgs)).notify, false)
    // 关联 low 任务的会话同样被拦
    const low = await newTask({ priority: 'low' })
    const { key } = await eventNotify('claude', 'done', msgs)
    await call('POST', `/tasks/${low.id}/sessions`, { sessionId: `claude:${key}` })
    assert.equal((await eventNotify('claude', 'done', msgs, key)).notify, false)
    // 关联 high 任务后放行
    const high = await newTask({ priority: 'high' })
    const k2 = (await eventNotify('claude', 'done', msgs)).key
    await call('POST', `/tasks/${high.id}/sessions`, { sessionId: `claude:${k2}` })
    assert.equal((await eventNotify('claude', 'done', msgs, k2)).notify, true)
    await call('PATCH', '/notify/settings', { minPriority: 'low' })
  })

  it('时间提醒过滤与审批放行', async () => {
    const msgs = await connect()
    await call('PATCH', '/notify/settings', { minPriority: 'high' })
    const past = new Date(Date.now() - 60_000).toISOString()
    await newTask({ priority: 'low', dueAt: past, remindDue: true })
    const lowMsg = await waitFor<any>(msgs, (m: any) => m.type === 'reminder' && m.reminder.notify === false)
    assert.equal(lowMsg.reminder.title, '过滤测试任务')
    await newTask({ priority: 'high', title: '高优任务', dueAt: past, remindDue: true })
    try {
      await waitFor(msgs, (m: any) => m.type === 'reminder' && m.reminder.notify === true)
    } catch (e) {
      const reminders = msgs.filter((m: any) => m.type === 'reminder').map((m: any) => `${m.reminder.title}:${m.reminder.notify}`)
      throw new Error(`超时。已收到的 reminder 广播：[${reminders.join(', ')}]`)
    }
    // 审批事件直接放行（不走任何规则）
    assert.equal(await evaluateNotify(pool, a.id, { kind: 'approval' }), true)
    await call('PATCH', '/notify/settings', { minPriority: 'low' })
  })
})
