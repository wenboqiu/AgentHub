import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assigneeOf, heuristicDraft, nextStepLine, parseRefine, toChecklist } from '../src/proposals.ts'
import { DEFAULT_MANAGER, pickCandidates, quota } from '../src/dispatch-manager.ts'
import type { Task } from '../src/tasks.ts'

// 这些都是纯函数，不碰数据库：规则档最容易写错的是「什么时候该出意见、什么时候该闭嘴」。

const session = { title: '修登录超时', agent: 'claude' as const, project: 'AgentHub' }

const mockTask = (over: Partial<Task> = {}): Task => ({
  id: 1, title: '修登录超时', notes: '会话 30 分钟就断', status: 'doing', priority: 'medium',
  checklist: [], constraints: { paths: [], net: false, push: false, scripts: false, note: '' },
  goalId: null, projectId: 2, profileId: null, roleId: 3,
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

test('执行人：角色的默认配置优先，机器与目录跟着角色走', () => {
  const ctx = {
    roles: new Map([[3, { id: 3, name: '老张', title: '后端', agent: 'claude' as const, profileId: 11 }]]),
    profiles: new Map([[11, { id: 11, name: '家里台式', agent: 'claude', machine: 'pc-home', cwd: 'D:/Work2/AgentHub' }]]),
    projectProfiles: new Map([[2, 12]]),
  }
  const a = assigneeOf(ctx, 3, null, 2)
  assert.equal(a.roleName, '老张')
  assert.equal(a.profileId, 11)
  assert.equal(a.machine, 'pc-home')
  assert.equal(a.cwd, 'D:/Work2/AgentHub')
})

test('执行人：只有项目兜底配置时也能落到电脑和目录', () => {
  const ctx = {
    roles: new Map([[3, { id: 3, name: '老张', title: '', agent: 'codex' as const, profileId: null }]]),
    profiles: new Map([[12, { id: 12, name: 'Mac', agent: 'codex', machine: 'mac-mini', cwd: '/Users/w' }]]),
    projectProfiles: new Map([[2, 12]]),
  }
  const a = assigneeOf(ctx, 3, null, 2)
  assert.equal(a.profileId, 12)
  assert.equal(a.agent, 'codex')
  assert.equal(a.machine, 'mac-mini')
})

test('执行人：没有任何依据时留空，由人来选', () => {
  const a = assigneeOf({ roles: new Map(), profiles: new Map(), projectProfiles: new Map() }, null, null, null)
  assert.equal(a.roleId, null)
  assert.equal(a.machine, '')
})
