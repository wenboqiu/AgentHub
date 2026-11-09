import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assigneeOf, forkInfo, heuristicDraft, nextStepLine, parseRefine, planDelivery, proposalPatch, sessionKeyOf, ticketMessage, toChecklist } from '../src/proposals.ts'
import { DEFAULT_MANAGER, pickCandidates, quota } from '../src/dispatch-manager.ts'
import type { Task } from '../src/tasks.ts'

// 这些都是纯函数，不碰数据库：规则档最容易写错的是「什么时候该出意见、什么时候该闭嘴」。

const session = { title: '修登录超时', agent: 'claude' as const, project: 'AgentHub' }

const mockTask = (over: Partial<Task> = {}): Task => ({
  id: 1, title: '修登录超时', notes: '会话 30 分钟就断', status: 'doing', priority: 'medium',
  checklist: [], constraints: { paths: [], net: false, push: false, scripts: false, note: '' },
  startMode: 'fresh', forkFrom: null, autoDispatch: false,
  goalId: null, projectId: 2, roleId: 3,
  agent: 'claude', machine: 'pc', cwd: 'D:/x', sessionIds: [],
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', doneAt: null,
  timerStartedAt: null, queuedAt: null, startAt: null, dueAt: null, remindStart: true, remindDue: true,
  ...over,
})

test('收尾语里找下一步：只认明确的信号词', () => {
  assert.equal(nextStepLine('改完了。\n下一步：补一个迁移脚本'), '下一步：补一个迁移脚本')
  assert.equal(nextStepLine('- 接下来要跑一遍 e2e'), '接下来要跑一遍 e2e')
  // 没有信号词就不猜
  assert.equal(nextStepLine('改完了，测试也过了。'), '')
})

test('原任务还有未完成项：接着做，清单沿用未完成项', () => {
  const d = heuristicDraft({
    session,
    task: mockTask({ checklist: [{ id: 'a', text: '补迁移', done: false }, { id: 'b', text: '写文档', done: true }] }),
    lastReply: '改完了',
    evidence: [],
  })
  assert.ok(d)
  assert.equal(d.kind, 'continue')
  assert.equal(d.title, '继续：补迁移')
  assert.deepEqual(d.checklist, ['补迁移'])
  assert.equal(d.roleId, 3)
})

test('有失败测试：按高优先级修，标题取第一行现场', () => {
  const d = heuristicDraft({
    session, task: null, lastReply: '跑完了',
    evidence: [{ kind: 'test', label: '测试结果', value: '3 failed, 10 passed\n  ✗ login times out', at: null }],
  })
  assert.ok(d)
  assert.equal(d.kind, 'fix')
  assert.equal(d.priority, 'high')
  assert.ok(d.title.startsWith('修复：3 failed'))
})

test('明确说了下一步：用它当标题', () => {
  const d = heuristicDraft({ session, task: null, lastReply: '登录改好了。\n下一步：把刷新逻辑也补上', evidence: [] })
  assert.ok(d)
  assert.equal(d.kind, 'followup')
  assert.equal(d.title, '下一步：把刷新逻辑也补上')
})

test('回复太短或没有产出：不出意见', () => {
  assert.equal(heuristicDraft({ session, task: null, lastReply: '好', evidence: [] }), null)
  assert.equal(heuristicDraft({ session, task: null, lastReply: '   ', evidence: [] }), null)
})

test('parseRefine：认代码块包裹、认 skip、垃圾输入给 null', () => {
  const ok = parseRefine('```json\n{"kind":"fix","title":"修超时","priority":"high","checklist":["跑通登录"],"roleId":"7"}\n```')
  assert.ok(ok && !ok.skip)
  assert.equal(ok.draft.kind, 'fix')
  assert.equal(ok.draft.priority, 'high')
  assert.deepEqual(ok.draft.checklist, ['跑通登录'])
  assert.equal(ok.draft.roleId, 7)

  assert.deepEqual(parseRefine('{"skip":true}'), { skip: true })
  // 没有 title 的 JSON 不算草稿
  assert.equal(parseRefine('{"kind":"fix"}'), null)
  assert.equal(parseRefine('我觉得应该继续做'), null)
})

test('去向：接着做和回去修都续上下文，新的一段从零开始', () => {
  const cont = heuristicDraft({
    session,
    task: mockTask({ checklist: [{ id: 'a', text: '补迁移', done: false }] }),
    lastReply: '改完了',
    evidence: [],
  })
  assert.equal(cont?.delivery, 'fork')
  // 有失败现场：回去修，上下文就在刚才那个会话里
  const fix = heuristicDraft({
    session, task: null, lastReply: '跑完了',
    evidence: [{ kind: 'test', label: '测试结果', value: '1 failed', at: null }],
  })
  assert.equal(fix?.delivery, 'fork')
  // 新的一段工作：另起会话更省上下文
  const next = heuristicDraft({ session, task: null, lastReply: '登录改好了。\n下一步：把刷新逻辑也补上', evidence: [] })
  assert.equal(next?.delivery, 'fresh')
})

test('planDelivery：工具 / 电脑 / 目录任一不同就退回新会话', () => {
  const fork = forkInfo({ agent: 'claude', machine: 'pc-home', cwd: 'D:/Work2/AgentHub', state: 'done' })
  const target = { agent: 'claude', machine: 'pc-home', cwd: 'D:/Work2/AgentHub' }

  const ok = planDelivery('fork', fork, target)
  assert.equal(ok.mode, 'fork')
  assert.match(ok.reason, /接着原会话/)

  const other = planDelivery('fork', fork, { ...target, agent: 'codex' })
  assert.equal(other.mode, 'fresh')
  assert.match(other.reason, /续不上/)

  assert.equal(planDelivery('fork', fork, { ...target, machine: 'mac' }).mode, 'fresh')
  assert.equal(planDelivery('fork', fork, { ...target, cwd: 'D:/Work2/别的目录' }).mode, 'fresh')
  // 主动选从零开始：不需要任何理由
  assert.deepEqual(planDelivery('fresh', fork, target), { mode: 'fresh', reason: '新建会话，从这个任务开始' })
})

test('planDelivery：同一任务重复派发续用上次的会话，不再新开一个同名对话', () => {
  const prev = forkInfo({ agent: 'claude', machine: 'pc-home', cwd: 'D:/Work2/AgentHub', state: 'done' })
  const target = { agent: 'claude', machine: 'pc-home', cwd: 'D:/Work2/AgentHub' }

  const ok = planDelivery('resume', prev, target)
  assert.equal(ok.mode, 'resume')
  assert.match(ok.reason, /接着上次派发的会话继续/)

  // 和 fork 用同一套条件：换了工具 / 电脑 / 目录，或者上一轮还在跑，就只能新开
  assert.equal(planDelivery('resume', prev, { ...target, agent: 'codex' }).mode, 'fresh')
  assert.equal(planDelivery('resume', prev, { ...target, machine: 'mac' }).mode, 'fresh')
  assert.equal(planDelivery('resume', prev, { ...target, cwd: 'D:/Work2/别的目录' }).mode, 'fresh')
  const running = forkInfo({ agent: 'claude', machine: 'pc-home', cwd: 'D:/Work2/AgentHub', state: 'running' })
  assert.equal(planDelivery('resume', running, target).mode, 'fresh')
})

test('原会话能不能续：只做状态监听的和在跑的都不行', () => {
  const base = { machine: 'pc', cwd: 'D:/x', state: 'done' as const }
  assert.equal(forkInfo({ ...base, agent: 'claude' }).ok, true)
  assert.equal(forkInfo({ ...base, agent: 'codex' }).ok, true)
  // ZCode 能同目录新开，但没有按会话分叉的通道
  const zcode = forkInfo({ ...base, agent: 'zcode' })
  assert.equal(zcode.ok, false)
  assert.match(zcode.reason, /ZCode/)
  assert.equal(forkInfo({ ...base, agent: 'workbuddy' }).ok, false)
  // 在跑的、等授权的（进程都还活着）不能分叉，状态不明的也要拦
  const running = forkInfo({ ...base, agent: 'claude', state: 'running' })
  assert.equal(running.ok, false)
  assert.match(running.reason, /还在跑/)
  const waiting = forkInfo({ ...base, agent: 'claude', state: 'waiting' })
  assert.equal(waiting.ok, false)
  assert.match(waiting.reason, /等授权/)
  const unknown = forkInfo({ ...base, agent: 'claude', state: 'unknown' })
  assert.equal(unknown.ok, false)
  assert.match(unknown.reason, /状态不明/)
})

test('planDelivery：目录写法不同但同一目录时能续上', () => {
  const fork = forkInfo({ agent: 'claude', machine: 'PC-Home', cwd: 'D:\\Work2\\AgentHub\\', state: 'done' })
  // 盘符大小写、反斜杠、末尾斜杠都是同一目录
  const ok = planDelivery('fork', fork, { agent: 'claude', machine: 'pc-home', cwd: 'd:/Work2/AgentHub' })
  assert.equal(ok.mode, 'fork')
  // 电脑名只差大小写也是同一台（目录相同，能续上）
  const sameMachine = planDelivery('fork', fork, { agent: 'claude', machine: 'PC-HOME', cwd: 'D:\\Work2\\AgentHub' })
  assert.equal(sameMachine.mode, 'fork')
})

test('sessionKeyOf：拆 agent 前缀，拆不出来给空', () => {
  assert.equal(sessionKeyOf('claude:abc-123'), 'abc-123')
  assert.equal(sessionKeyOf('codex:xyz'), 'xyz')
  assert.equal(sessionKeyOf('no-colon'), '')
  assert.equal(sessionKeyOf(''), '')
})

test('parseRefine：认 delivery，没写就按 kind 兜底', () => {
  const fork = parseRefine('{"kind":"followup","title":"补文档","delivery":"fork"}')
  assert.ok(fork && !fork.skip)
  assert.equal(fork.draft.delivery, 'fork')
  // 没声明的：continue / fix 续上下文，followup 从零开始
  const fix = parseRefine('{"kind":"fix","title":"修超时"}')
  assert.ok(fix && !fix.skip)
  assert.equal(fix.draft.delivery, 'fork')
  const follow = parseRefine('{"kind":"followup","title":"补文档"}')
  assert.ok(follow && !follow.skip)
  assert.equal(follow.draft.delivery, 'fresh')
  // 乱写的值不采纳，按 kind 兜底
  const junk = parseRefine('{"kind":"fix","title":"修超时","delivery":"resume"}')
  assert.ok(junk && !junk.skip)
  assert.equal(junk.draft.delivery, 'fork')
})

test('清单文本转任务结构：带稳定 id、默认未完成', () => {
  assert.deepEqual(toChecklist(['跑测试', '更新文档']), [
    { id: 'p1', text: '跑测试', done: false },
    { id: 'p2', text: '更新文档', done: false },
  ])
})

test('配额：关掉时为 0，并发与频率取小', () => {
  assert.equal(quota(DEFAULT_MANAGER, 0, 0), 0)
  const on = { ...DEFAULT_MANAGER, enabled: true, maxRunning: 2, maxPerHour: 6 }
  assert.equal(quota(on, 0, 0), 2)
  assert.equal(quota(on, 2, 0), 0)
  assert.equal(quota(on, 1, 5), 1)
  assert.equal(quota(on, 0, 9), 0)
})

test('没有配额时不去查库', async () => {
  const db = { query: () => { throw new Error('不该查库') } } as any
  assert.deepEqual(await pickCandidates(db, 1, 0), [])
})

test('执行人：目录按来源会话的机器从项目目录列表里挑', () => {
  const ctx = {
    roles: new Map([[3, { id: 3, name: '老张', title: '后端', agent: 'claude' as const }]]),
    projectDirs: new Map([[2, [
      { machine: 'pc-home', cwd: 'D:/Work2/AgentHub' },
      { machine: 'mac-mini', cwd: '/Users/w/AgentHub' },
    ]]]),
  }
  const a = assigneeOf(ctx, 3, 2, 'pc-home')
  assert.equal(a.roleName, '老张')
  assert.equal(a.agent, 'claude')
  assert.equal(a.machine, 'pc-home')
  assert.equal(a.cwd, 'D:/Work2/AgentHub')
  // 来源会话在另一台电脑：目录跟着换，不会串设备
  const b = assigneeOf(ctx, 3, 2, 'mac-mini')
  assert.equal(b.machine, 'mac-mini')
  assert.equal(b.cwd, '/Users/w/AgentHub')
})

test('执行人：不绑机器的目录当通用兜底', () => {
  const ctx = {
    roles: new Map([[3, { id: 3, name: '老张', title: '', agent: 'codex' as const }]]),
    projectDirs: new Map([[2, [{ machine: null, cwd: '/Users/w' }]]]),
  }
  const a = assigneeOf(ctx, 3, 2, '某台没登记的电脑')
  assert.equal(a.agent, 'codex')
  assert.equal(a.machine, '')
  assert.equal(a.cwd, '/Users/w')
})

test('执行人：没有任何依据时留空，由人来选', () => {
  const a = assigneeOf({ roles: new Map(), projectDirs: new Map() }, null, null)
  assert.equal(a.roleId, null)
  assert.equal(a.machine, '')
})

test('执行人：发单人指定过的机器/目录以人的为准', () => {
  const ctx = {
    roles: new Map([[1, { id: 1, name: '小林', title: '', agent: 'claude' as const }]]),
    projectDirs: new Map([[2, [{ machine: 'DESKTOP-01', cwd: 'D:/x' }]]]),
  }
  const a = assigneeOf(ctx, 1, 2, '', { machine: 'mac-mini', cwd: '/Users/w/AgentHub' })
  assert.equal(a.machine, 'mac-mini')
  assert.equal(a.cwd, '/Users/w/AgentHub')
})

test('ticketMessage：带上工单原话、项目与角色清单，没写正文要明说', () => {
  const msg = ticketMessage({
    title: '给 README 补安装说明', notes: '',
    project: 'AgentHub', projectBrief: 'Tauri + React', recent: ['「修登录」已完成'],
    role: null, machine: 'DESKTOP-01', cwd: 'D:/Work2/AgentHub',
    roles: [{ id: 1, name: '小林', title: '前端', agent: 'claude' }],
    projects: [{ id: 1, name: 'AgentHub' }],
  })
  assert.match(msg, /给 README 补安装说明/)
  assert.match(msg, /没写正文/)
  assert.match(msg, /AgentHub/)
  assert.match(msg, /1=小林 \/ 前端 \/ claude/)
  assert.match(msg, /电脑 DESKTOP-01/)
  // 契约必须先出现：模型先看到格式要求，再看材料
  assert.ok(msg.indexOf('JSON') < msg.indexOf('【人发来的工单】'))
})

test('proposalPatch：保留执行边界，丢掉白名单外的键', () => {
  const c = { paths: ['src'], net: false, push: false, scripts: false, note: '' }
  const out = proposalPatch({ constraints: c, title: 'x', foo: 1 })
  assert.deepEqual(out, { constraints: c, title: 'x' })
  assert.ok(!('foo' in out))
})
