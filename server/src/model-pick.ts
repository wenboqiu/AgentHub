import { canPickModel, modelForTier, modelNote, type ModelTier } from './models.ts'

// 项目经理代挑模型：角色没写模型时，按任务本身的「分量」在同工具的清单里挑一档。
//
// 为什么是规则而不是再叫一次模型：派活这一步要马上给出 run.start，
// 中途再排一次 LLM 调用只会让它更慢、更贵，而且挑错了没人看得出为什么。
// 规则的好处是同一份任务每次都给同一个答案，理由写进执行记录，人能复核。
//
// 打分只看任务里已经有的东西：说明多长、有几条清单、边界有多细、优先级、关键词。
// 加起来够重就是 heavy，够轻就是 light，其余一律 standard——宁可多花一点，也别把重活丢给便宜档。

export type ComplexityInput = {
  title: string
  /** 真正会发出去的那份正文（项目经理补过骨架的，用补完的） */
  notes: string
  checklist?: { text: string; done?: boolean }[]
  constraints?: { paths?: string[]; note?: string }
  priority?: string
}

export type Complexity = {
  level: ModelTier
  score: number
  /** 打分依据，一句话一条，界面直接拼出来给人看 */
  reasons: string[]
}

export type ModelChoice = {
  model: string | null
  /** role = 角色自己写死的；manager = 项目经理按复杂度挑的；none = 没得挑，用执行端默认 */
  source: 'role' | 'manager' | 'none'
  level: ModelTier | null
  /** 给界面看的一句话：为什么是这个模型 */
  note: string
}

export const LEVEL_LABEL: Record<ModelTier, string> = {
  light: '轻活',
  standard: '常规',
  heavy: '重活',
}

/** 一刀切的词：出现一个就说明这活不只是「改一行」 */
const HEAVY_WORDS = ['重构', '迁移', '架构', '跨模块', '端到端', '并发', '性能', '兼容', '协议', '权限', '安全', '批量']
/** 反过来：这些词出现基本就是小活，别拿最贵的档去干 */
const LIGHT_WORDS = ['错别字', '文案', '注释', '重命名', '排版', '格式化', '翻译', '标点']

const HEAVY_SCORE = 5
const LIGHT_SCORE = 1

export function assessComplexity(input: ComplexityInput): Complexity {
  const notes = input.notes.trim()
  const items = input.checklist?.length ?? 0
  const paths = input.constraints?.paths?.length ?? 0
  const boundNote = input.constraints?.note?.trim().length ?? 0
  const reasons: string[] = []
  // 只要派出去一件活就值 1 分：轻档要落到「基线 + 小活词」以下，避免什么活都往下压
  let score = 1

  const text = `${input.title}\n${notes}\n${input.constraints?.note ?? ''}`
  const heavy = HEAVY_WORDS.filter(w => text.includes(w))
  const light = LIGHT_WORDS.filter(w => text.includes(w))

  // 只有标题、什么说明都没有：小活的词就当小活，其余按常规档起（信息不足时别赌便宜档）
  if (!notes && !items && !paths && !boundNote) {
    return light.length && !heavy.length
      ? { level: 'light', score: 1 - light.length, reasons: [`只是${light.slice(0, 3).join('、')}`] }
      : { level: 'standard', score, reasons: ['任务还没写说明，按常规档起'] }
  }

  if (notes.length >= 1200) {
    score += 3
    reasons.push(`说明 ${notes.length} 字，信息量不小`)
  } else if (notes.length >= 400) {
    score += 2
    reasons.push(`说明 ${notes.length} 字`)
  } else if (notes.length >= 120) {
    score += 1
  }

  if (items >= 6) {
    score += 2
    reasons.push(`清单 ${items} 条，活是成串的`)
  } else if (items >= 3) {
    score += 1
    reasons.push(`清单 ${items} 条`)
  }

  if (paths >= 3) {
    score += 1
    reasons.push(`要动 ${paths} 个目录`)
  }
  if (boundNote >= 120) {
    score += 1
    reasons.push('边界写得很细，说明涉及面广')
  }
  if (input.priority === 'high') {
    score += 1
    reasons.push('高优先级')
  }

  if (heavy.length) {
    score += Math.min(heavy.length * 2, 4)
    reasons.push(`提到${heavy.slice(0, 3).join('、')}`)
  }
  if (light.length) {
    score -= Math.min(light.length * 2, 2)
    reasons.push(`只是${light.slice(0, 3).join('、')}`)
  }

  const level: ModelTier = score >= HEAVY_SCORE ? 'heavy' : score <= LIGHT_SCORE ? 'light' : 'standard'
  return { level, score, reasons }
}

/**
 * 派活时到底用哪个模型。
 * - 角色写了模型：听角色的，人明确指定优先于规则；
 * - 角色没写、工具也没有清单（zcode / codebuddy 之类）：留空，交给执行端默认；
 * - 其余情况：按复杂度挑一档，note 里带理由，落进执行记录。
 */
export function pickDispatchModel(input: {
  agent: string | null
  /** 角色上写的模型（已解析过：null = 没指定） */
  roleModel: string | null
  task: ComplexityInput
}): ModelChoice {
  const { agent, roleModel, task } = input
  if (roleModel) {
    const hint = modelNote(agent, roleModel)
    return { model: roleModel, source: 'role', level: null, note: hint ? `角色指定 ${roleModel}（${hint}）` : `角色指定 ${roleModel}` }
  }
  if (!agent || !canPickModel(agent)) {
    return { model: null, source: 'none', level: null, note: agent ? `${agent} 没有可挑的模型清单，用执行端默认` : '' }
  }
  const c = assessComplexity(task)
  const model = modelForTier(agent, c.level)
  if (!model) return { model: null, source: 'none', level: c.level, note: '这一档没有可用的模型，用执行端默认' }
  const why = c.reasons.length ? c.reasons.join('，') : '没有更多信号'
  return {
    model,
    source: 'manager',
    level: c.level,
    note: `项目经理按复杂度选了 ${model}（${LEVEL_LABEL[c.level]}：${why}）`,
  }
}
