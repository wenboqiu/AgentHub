// 执行工具的模型清单：给「角色没指定模型时，项目经理按任务复杂度挑一档」用。
//
// 三条约定（改之前先看）：
//  ① id 必须是执行端真认识的别名 / 型号，写错了那一轮直接起不来，比不选还糟；
//  ② tier 只表示「这档适合多重的活」，不是模型能力排行，同一档可以有好几个；
//  ③ 这里是权威清单，前端的下拉（src/lib/models.ts）跟它对齐，
//     test/model-catalog.test.ts 守着两边不跑偏。
export type ModelTier = 'light' | 'standard' | 'heavy'

export type ModelSpec = {
  id: string
  tier: ModelTier
  /** 一句话适用场景，会显示在角色 / 任务页的提示里 */
  note: string
}

export const MODEL_CATALOG: Record<string, ModelSpec[]> = {
  claude: [
    // Claude Code 的别名会解析到当时的最新家族，换版本不用回来改
    { id: 'opus', tier: 'heavy', note: '跨模块重构、要它自己定方案' },
    { id: 'sonnet', tier: 'standard', note: '日常实现，多数任务够用' },
    { id: 'haiku', tier: 'light', note: '改文案、查错、小修补' },
    { id: 'fable', tier: 'standard', note: '长文写作与文档整理' },
  ],
  codex: [
    // 目录默认就是 gpt-6.1-sol：最重的一档也只有它，再往上没有更强的可选
    { id: 'gpt-6.1-sol', tier: 'heavy', note: '复杂改造，也是目录默认' },
    { id: 'gpt-6-sol', tier: 'standard', note: '日常实现' },
    { id: 'gpt-6-astra', tier: 'standard', note: '长上下文' },
    { id: 'gpt-5.6-sol', tier: 'standard', note: '上一代，稳定' },
    { id: 'gpt-5.6-terra', tier: 'standard', note: '上一代中档' },
    { id: 'gpt-5.6-luna', tier: 'light', note: '小改快跑' },
  ],
}

/** 每一档派谁：只挑「最像这一档」的那一个，不按清单顺序兜底 */
const TIER_PICK: Record<string, Record<ModelTier, string>> = {
  claude: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
  // codex 目录里最重的一档就是默认的 6.1-sol，重活也落在它身上
  codex: { light: 'gpt-5.6-luna', standard: 'gpt-6.1-sol', heavy: 'gpt-6.1-sol' },
}

/** 这个工具能不能由项目经理代挑模型；不能就留空，交给执行端自己的默认 */
export const canPickModel = (agent: string | null | undefined): boolean =>
  !!agent && !!TIER_PICK[agent]

export function modelForTier(agent: string | null | undefined, tier: ModelTier): string | null {
  return (agent ? TIER_PICK[agent]?.[tier] : null) ?? null
}

/** 模型 id → 一句适用场景；清单外的返回空串 */
export function modelNote(agent: string | null | undefined, id: string | null | undefined): string {
  if (!agent || !id) return ''
  return MODEL_CATALOG[agent]?.find(m => m.id === id)?.note ?? ''
}
