import test from 'node:test'
import assert from 'node:assert/strict'
import { harvestDecisions } from '../src/review.ts'

const at = '2026-11-11T00:00:00Z'
test('摘出决定，难逆的排前面，忽略用户消息和重复', () => {
  const out = harvestDecisions([
    { role: 'user', text: '决定：用户自己写的不算；原因：x；可逆性：易', createdAt: at },
    { role: 'assistant', text: '做完了\n- 决定：用 sqlite；原因：零依赖；可逆性：易\n**决定**：删除旧表；原因：已迁移；可逆性：难\n决定：用 sqlite；原因：重复；可逆性：易', createdAt: at },
  ])
  assert.deepEqual(out.map(d => [d.text, d.reason, d.reversible]), [['删除旧表', '已迁移', 'hard'], ['用 sqlite', '零依赖', 'easy']])
})
test('缺字段按 unknown，没有决定行返回空', () => {
  assert.equal(harvestDecisions([{ role: 'assistant', text: '决定：先跑测试', createdAt: at }])[0].reversible, 'unknown')
  assert.deepEqual(harvestDecisions([{ role: 'assistant', text: '没有岔路', createdAt: at }]), [])
})
