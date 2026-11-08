/**
 * 事件正文入库前的去重判定（纯函数，方便单测；不碰数据库）。
 *
 * 背景：WorkBuddy / CodeBuddy 是「只读监听」通道——正文由电脑端的 transcript 监听器随状态事件
 * 上报，同时用户从 AgentHub 发出去的那句话也会先落一次库。这两条路会在界面上撞成两条一样的消息：
 *
 * - 用户在 AgentHub 里发出去的正文，库里存的是原文（可能多行）；transcript 里的回显被 CLI 折成了
 *   一行，两边正文不相等，按原文比就认不出来；
 * - 回显的时间是 CLI 真正开跑的时刻，比用户点发送晚好几秒（启动 node、读配置、建会话），
 *   按「同秒」比也认不出来。
 *
 * 所以这里做两件事：正文按空白归一化后比较；本次 run 自己发出去的那几句，只按正文认、不看时间。
 */

/** 正文归一化：transcript 会把用户的多行输入折成一行，库里存的是原文 */
export function sameText(s: string) {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * 比较用的键：归一化后只取前 400 字。
 * 电脑端上报的正文有单条上限（4000 字），历史快照是全文——长消息只能按头部认。
 * 与 `replaceHistory` 的保留消息匹配同一口径。
 */
export function sameKey(s: string) {
  return sameText(s).slice(0, 400)
}

/** 事件里的时间与库里的时间允许差多少：只用来吸收「写入先后」的毫秒级抖动 */
export const EVENT_DEDUPE_MS = 2_000

export type IncomingMessage = { role: string; text: string; at: number }
export type KnownMessage = { role: string; text: string; at: number }

/**
 * 返回真正需要入库的那几条。
 *
 * - `known`：库里时间相近的消息（调用方按时间范围取，不能用「最近 N 条」窗口——
 *   重发一条很旧的消息会落到窗口外，于是同一段正文被再插一次）；
 * - `echoes`：当前这轮 run 自己发出去的正文。命中的回显直接丢掉，且用掉一次就不再参与匹配
 *   （同一句话是可以说两遍的，第二遍要照常入库）；
 * - 时间容差只吸收毫秒抖动，不用来兜「晚几秒」的回显：那由 `echoes` 负责，
 *   否则「继续」连说两遍会被误并成一条。
 */
export function mergeEventMessages(
  incoming: IncomingMessage[],
  known: KnownMessage[],
  echoes: string[],
  toleranceMs = EVENT_DEDUPE_MS,
): IncomingMessage[] {
  const seen = known.map(k => ({ role: k.role, key: sameKey(k.text), at: k.at }))

  const pendingEcho = new Map<string, number>()
  for (const e of echoes) {
    const key = sameKey(e)
    if (key) pendingEcho.set(key, (pendingEcho.get(key) ?? 0) + 1)
  }

  const fresh: IncomingMessage[] = []
  for (const m of incoming) {
    const key = sameKey(m.text)
    if (!key) continue

    // 这轮 run 自己发出去的那条回来了：正文一样就是回显，不看时间
    if (m.role === 'user') {
      const left = pendingEcho.get(key) ?? 0
      if (left > 0) {
        pendingEcho.set(key, left - 1)
        continue
      }
    }

    const hit = seen.findIndex(s => s.role === m.role && s.key === key && Math.abs(s.at - m.at) <= toleranceMs)
    if (hit >= 0) {
      // 用掉了就不再参与匹配：同一句话重复说两遍照常各自入库
      seen.splice(hit, 1)
      continue
    }

    seen.push({ role: m.role, key, at: m.at })
    fresh.push(m)
  }
  return fresh
}
