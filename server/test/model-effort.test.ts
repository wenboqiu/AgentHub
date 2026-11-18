import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modelNote, splitModel } from '../src/models.ts'
import { pickDispatchModel } from '../src/model-pick.ts'

test('splitModel：空、无 @、只有强度、模型加强度、多个 @', () => {
  assert.deepEqual(splitModel(null), { model: '', effort: '' })
  assert.deepEqual(splitModel(''), { model: '', effort: '' })
  assert.deepEqual(splitModel('opus'), { model: 'opus', effort: '' })
  assert.deepEqual(splitModel('@high'), { model: '', effort: 'high' })
  assert.deepEqual(splitModel('GLM-5.2@max'), { model: 'GLM-5.2', effort: 'max' })
  assert.deepEqual(splitModel('a@b@c'), { model: 'a@b', effort: 'c' })
})

test('modelNote：带强度的角色模型不报未知，并追加强度说明', () => {
  const base = modelNote('claude', 'opus')
  assert.ok(base)
  assert.equal(modelNote('claude', 'opus@high'), `${base}，思考强度 high`)
  assert.equal(modelNote('claude', '@max'), '思考强度 max')
  assert.equal(modelNote('claude', 'unknown@max'), '思考强度 max')
  assert.equal(modelNote('claude', 'opus'), base)
})

test('pickDispatchModel：角色模型带强度时原样透传，提示里有强度', () => {
  const c = pickDispatchModel({ agent: 'claude', roleModel: 'opus@high', task: { title: 't', notes: '' } })
  assert.equal(c.model, 'opus@high')
  assert.equal(c.source, 'role')
  assert.ok(c.note.includes('思考强度 high'))
})
