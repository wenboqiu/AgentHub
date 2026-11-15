import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effortOptions, joinModel, splitModelEffort } from '../src/lib/efforts.ts'

const values = (agent: string, model: string) => effortOptions(agent, model).map(o => o.value)

test('claude / codex 五档，其它 agent 没有强度', () => {
  assert.deepEqual(values('claude', 'opus'), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(values('codex', ''), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(values('workbuddy', ''), [])
  assert.deepEqual(values('codebuddy', 'x'), [])
})

test('zcode 按模型给档位，5.3 与未知只给高', () => {
  assert.deepEqual(values('zcode', 'GLM-5.2'), ['disabled', 'high', 'max'])
  assert.deepEqual(values('zcode', 'glm-5-turbo'), ['disabled', 'enabled'])
  assert.deepEqual(values('zcode', 'GLM-5.3'), ['high'])
  assert.deepEqual(values('zcode', ''), ['high'])
})

test('joinModel / splitModelEffort 往返', () => {
  assert.equal(joinModel('opus', 'high'), 'opus@high')
  assert.equal(joinModel('opus', ''), 'opus')
  assert.equal(joinModel('', 'high'), '@high')
  assert.deepEqual(splitModelEffort('@high'), { model: '', effort: 'high' })
  assert.deepEqual(splitModelEffort('opus'), { model: 'opus', effort: '' })
  assert.deepEqual(splitModelEffort('a@b@c'), { model: 'a@b', effort: 'c' })
})
