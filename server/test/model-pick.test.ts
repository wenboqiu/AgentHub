import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assessComplexity, pickDispatchModel } from '../src/model-pick.ts'
import { MODEL_CATALOG, canPickModel, modelForTier } from '../src/models.ts'

// 项目经理代挑模型：角色没写模型时按复杂度挑一档。
// 这里守两件事——挑的档要合理（重活别丢给便宜档），以及「谁定的」要说得清。

const ticket = (notes: string, extra: Partial<{ title: string; checklist: { text: string; done: boolean }[]; paths: string[]; note: string; priority: string }> = {}) => ({
  title: extra.title ?? '派活链路收尾',
  notes,
  checklist: extra.checklist ?? [],
  constraints: { paths: extra.paths ?? [], note: extra.note ?? '' },
  priority: extra.priority ?? 'medium',
})

test('一行的琐碎活走轻档', () => {
  const c = assessComplexity(ticket('把提交按钮的文案改成「保存」'))
  assert.equal(c.level, 'light')
  assert.ok(c.reasons.some(r => r.includes('文案')), '理由里要说清是小活')
})

test('常规任务单走标准档', () => {
  const c = assessComplexity(ticket('按设计稿实现设置页的通知规则，改完跑 tsc 和测试。'.repeat(6)))
  assert.equal(c.level, 'standard')
})

test('长说明 + 重构/迁移这类词走重档', () => {
  const c = assessComplexity(ticket(
    ('把派活链路从「任务直接开跑」改成「先排队再投递」，需要重构 startTaskDispatch，'
      + '把队列与在线两条路径合并；顺带迁移老的 task_dispatch_queue 数据。').repeat(6),
    { title: '重构派活链路并迁移旧队列', priority: 'high' },
  ))
  assert.equal(c.level, 'heavy')
  assert.ok(c.reasons.some(r => r.includes('重构') || r.includes('迁移')))
})

test('什么都没写不赌便宜档：按标准档起', () => {
  const c = assessComplexity({ title: '看一下登录', notes: '' })
  assert.equal(c.level, 'standard')
  assert.match(c.reasons[0] ?? '', /没写说明/)
})

test('角色写了模型就听角色的，不再按复杂度挑', () => {
  const picked = pickDispatchModel({ agent: 'claude', roleModel: 'opus', task: ticket('改个错别字') })
  assert.equal(picked.model, 'opus')
  assert.equal(picked.source, 'role')
})

test('轻活挑最便宜的一档，重活挑最强的一档', () => {
  const light = pickDispatchModel({ agent: 'claude', roleModel: null, task: ticket('改个错别字') })
  assert.equal(light.model, 'haiku')
  assert.equal(light.level, 'light')
  assert.equal(light.source, 'manager')
  assert.match(light.note, /项目经理按复杂度选了 haiku/)

  const heavy = pickDispatchModel({
    agent: 'claude',
    roleModel: null,
    task: ticket('重构派活链路，跨模块迁移队列，端到端补齐。'.repeat(20), { priority: 'high' }),
  })
  assert.equal(heavy.model, 'opus')
  assert.equal(heavy.level, 'heavy')
})

test('codex 挑自己清单里的型号，不串到 claude 的别名', () => {
  const light = pickDispatchModel({ agent: 'codex', roleModel: null, task: ticket('改个错别字') })
  assert.equal(light.model, 'gpt-5.6-luna')
  const heavy = pickDispatchModel({ agent: 'codex', roleModel: null, task: ticket('重构队列'.repeat(40)) })
  assert.equal(heavy.model, modelForTier('codex', 'heavy'))
  assert.ok(MODEL_CATALOG.codex.some(m => m.id === heavy.model))
})

test('没有清单的工具留空，交给执行端默认', () => {
  for (const agent of ['zcode', 'codebuddy', null]) {
    assert.equal(canPickModel(agent), false)
    const picked = pickDispatchModel({ agent, roleModel: null, task: ticket('重构整个派活链路') })
    assert.equal(picked.model, null)
    assert.equal(picked.source, 'none')
  }
})
