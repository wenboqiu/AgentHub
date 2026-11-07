import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MODEL_CATALOG, modelForTier, type ModelTier } from '../server/src/models.ts'
import { MODEL_HINTS, MODEL_PICKS, modelHints } from '../src/lib/models.ts'

// 模型清单是服务端说了算（它要拿来挑模型），前端只负责显示。
// 两边各存一份是为了服务端镜像能只 COPY server/src 也跑得起来，这里守住它们不跑偏。

test('前端下拉与服务端清单是同一批模型、同一个顺序', () => {
  for (const agent of Object.keys(MODEL_CATALOG)) {
    assert.deepEqual(modelHints(agent), MODEL_CATALOG[agent].map(m => m.id), `${agent} 的清单跑偏了`)
  }
  for (const agent of Object.keys(MODEL_HINTS)) {
    assert.ok(MODEL_CATALOG[agent], `前端有 ${agent}，服务端没有`)
  }
})

test('每一档挑出来的模型都在清单里', () => {
  for (const agent of Object.keys(MODEL_PICKS)) {
    for (const tier of ['light', 'standard', 'heavy'] as ModelTier[]) {
      const id = modelForTier(agent, tier)
      assert.ok(id, `${agent} 的 ${tier} 档没有模型`)
      assert.equal(MODEL_PICKS[agent][tier], id, `${agent} 的 ${tier} 档两边不一致`)
      assert.ok(MODEL_CATALOG[agent].some(m => m.id === id), `${agent} 的 ${tier} 档挑到了清单外的 ${id}`)
    }
  }
})
