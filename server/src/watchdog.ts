import type pg from 'pg'

// Watchdog（独立于事件流的检测回路，思路来自 DeepSeek Super-agent 的看门狗）：
// 1. 卡死检测：会话长时间处于 running 且没有任何新事件 → 升级提醒（不自动干预，
//    因为执行不在 AgentHub 手里）；
// 2. 反复失败：同一会话短窗口内多次 aborted → 提醒用户介入。
// 服务重启会清零失败计数（内存态）；卡死提醒的幂等标记落库，重启后不会重复轰炸。

export type WatchdogIssue = 'stall' | 'abort-spree'

export async function migrateWatchdog(db: Pick<pg.Pool, 'query'>) {
  await db.query(`CREATE TABLE IF NOT EXISTS watchdog_state (
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('stall')),
    arm_key text NOT NULL DEFAULT '',
    notified_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, session_id, kind))`)
  // arm_key 需要与 sessions.event_at 精确比对以排除已领取的会话（迁移可重入：已是 timestamptz 就跳过）
  const col = await db.query<{ data_type: string }>(
    "SELECT data_type FROM information_schema.columns WHERE table_name = 'watchdog_state' AND column_name = 'arm_key'",
  )
  if (col.rows[0]?.data_type !== 'timestamp with time zone') {
    await db.query('ALTER TABLE watchdog_state ALTER COLUMN arm_key DROP DEFAULT')
    await db.query("ALTER TABLE watchdog_state ALTER COLUMN arm_key TYPE timestamptz USING NULLIF(arm_key,'')::timestamptz")
  }
}

export type Stalled = { userId: number; sessionId: string; eventKey: string }

// 疑似卡死：state=running 且最后事件早于阈值。event_at 作为「武装键」：
// 会话一旦有新事件（键变化）就重新武装，长时间任务分多段跑时每段只提醒一次。
// 排除本轮已领取的（反连接 watchdog_state），只看最近 7 天、每批最多 50 条：
// 首次上线时遗留的陈年 running 会话分批消化，且不会把新会话挤出窗口
export async function stalledSessions(db: Pick<pg.Pool, 'query'>, stallAfterMs: number): Promise<Stalled[]> {
  const cutoff = new Date(Date.now() - stallAfterMs).toISOString()
  const r = await db.query<{ user_id: string; id: string; event_at: Date }>(
    `SELECT s.user_id, s.id, s.event_at FROM sessions s
     WHERE s.state = 'running' AND s.event_at < $1 AND s.event_at > now() - interval '7 days'
       AND NOT EXISTS (SELECT 1 FROM watchdog_state w WHERE w.user_id = s.user_id AND w.session_id = s.id AND w.kind = 'stall' AND w.arm_key = s.event_at)
     ORDER BY s.event_at LIMIT 50`,
    [cutoff],
  )
  return r.rows.map(row => ({ userId: Number(row.user_id), sessionId: row.id, eventKey: row.event_at.toISOString() }))
}

// 幂等领取：同一 (会话, event_at) 只提醒一次；event_at 变化（有新事件）时重新武装
export async function claimStalled(db: Pick<pg.Pool, 'query'>, userId: number, sessionId: string, eventKey: string): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO watchdog_state(user_id, session_id, kind, arm_key) VALUES($1,$2,'stall',$3)
     ON CONFLICT (user_id, session_id, kind) DO UPDATE SET arm_key=$3, notified_at=now()
     WHERE watchdog_state.arm_key <> $3
     RETURNING arm_key`,
    [userId, sessionId, eventKey],
  )
  return (r.rowCount ?? 0) > 0
}

export async function cleanupWatchdog(db: Pick<pg.Pool, 'query'>) {
  await db.query("DELETE FROM watchdog_state WHERE notified_at < now() - interval '2 days'")
}

// 反复失败计数器（内存态）：窗口内第 N 次 aborted 触发一次提醒，running 清零，
// 达到阈值后同窗口内不再重复报
export class AbortSpreeTracker {
  private hits = new Map<string, { count: number; resetAt: number }>()
  private readonly threshold: number
  private readonly windowMs: number
  constructor(threshold: number, windowMs: number) {
    this.threshold = threshold
    this.windowMs = windowMs
  }
  record(userId: number, sessionId: string, state: 'aborted' | 'running', now = Date.now()): boolean {
    const key = `${userId}:${sessionId}`
    if (state === 'running') {
      this.hits.delete(key)
      return false
    }
    let h = this.hits.get(key)
    if (!h || now > h.resetAt) {
      h = { count: 0, resetAt: now + this.windowMs }
      this.hits.set(key, h)
    }
    if (h.count >= this.threshold) return false
    h.count++
    return h.count === this.threshold
  }
}
