// 思考强度的前端静态表。强度编码在 model 字符串里：`<模型id>@<强度>`（模型 id 可为空）。
// 手机端读不到本机模型清单，所以选项只能是静态的；执行端另有白名单，非法值会被忽略。
export type EffortOption = { value: string; label: string }

const FIVE: EffortOption[] = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '很高' },
  { value: 'max', label: '最高' },
]

const OFF: EffortOption = { value: 'disabled', label: '关闭' }
const HIGH: EffortOption = { value: 'high', label: '高' }
const MAX: EffortOption = { value: 'max', label: '最高' }
const ON: EffortOption = { value: 'enabled', label: '开启' }

export function effortOptions(agent: string, modelId: string): EffortOption[] {
  if (agent === 'claude' || agent === 'codex') return FIVE
  if (agent === 'zcode') {
    const id = modelId.trim().toLowerCase()
    if (id === 'glm-5.2') return [OFF, HIGH, MAX]
    if (id === 'glm-5-turbo') return [OFF, ON]
    // 5.3 系列与未知模型：更多档位未实测，只给「高」
    return [HIGH]
  }
  return []
}

/** 拼回 model 字符串；强度为空就不带 `@` */
export function joinModel(modelId: string, effort: string): string {
  return effort ? `${modelId}@${effort}` : modelId
}

/** 在最后一个 `@` 处拆开；没有 `@` 则强度为空 */
export function splitModelEffort(raw: string): { model: string; effort: string } {
  const i = raw.lastIndexOf('@')
  return i < 0 ? { model: raw, effort: '' } : { model: raw.slice(0, i), effort: raw.slice(i + 1) }
}
