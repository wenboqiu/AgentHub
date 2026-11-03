import type pg from 'pg'
import { listMessages } from './db.ts'

// Thread 模型（思路来自 DeepSeek Super-agent：Session 应当是系统实现细节而非用户
// 认知负担）。把「任务」升级为 Thread——一条按时间排序的统一事件流：关联会话的
// 消息、执行记录、时间提醒、投机摘要全部收进同一个视图。v1 只做聚合读（不迁移
// 数据、不破坏现有 API），客户端任务详情页以「时间线」呈现。

export type ThreadEvent =
  | { type: 'message'; at: string; sessionId: string; role: string; text: string; sourceId?: string }
  | { type: 'run'; at: string; runId: string; status: string; error: string; title: string }
  | { type: 'reminder'; at: string; kind: 'start' | 'due'; title: string; acked: boolean }
  | { type: 'digest'; at: string; kind: 'review' | 'failure'; text: string }

const at = (d: Date) => d.toISOString()

export async function taskThread(pool: pg.Pool, userId: number, taskId: number, limit = 200): Promise<ThreadEvent[]> {
  if (!(await pool.query('SELECT id FROM tasks WHERE user_id=$1 AND id=$2', [userId, taskId])).rowCount) return []
  const events: ThreadEvent[] = []
  // 关联会话的消息（每会话独立留痕，合并成一条流）
  const sessionRows = (
    await pool.query<{ session_id: string }>('SELECT session_id FROM task_sessions WHERE user_id=$1 AND task_id=$2 ORDER BY created_at, session_id', [userId, taskId])
  ).rows
  for (const s of sessionRows) {
    for (const m of await listMessages(pool, userId, s.session_id, Math.min(limit, 100))) {
      events.push({ type: 'message', at: m.createdAt, sessionId: s.session_id, role: m.role, text: m.text, ...(m.sourceId ? { sourceId: m.sourceId } : {}) })
    }
  }
  // 执行记录：挂在任务上的 + 发到关联会话的
  const sessionIds = sessionRows.map(r => r.session_id)
  const runRows = (
    await pool.query<{ id: string; status: string; error: string; title: string; created_at: Date; updated_at: Date }>(
      `SELECT id, status, error, title, created_at, updated_at FROM runs
       WHERE user_id=$1 AND (task_id=$2 OR session_id = ANY($3::text[])) ORDER BY created_at DESC, id DESC LIMIT 20`,
      [userId, taskId, sessionIds.length ? sessionIds : ['__none__']],
    )
  ).rows
  for (const r of runRows) events.push({ type: 'run', at: at(r.updated_at), runId: r.id, status: r.status, error: r.error, title: r.title })
  // 时间提醒（含已处理状态）
  const reminderRows = (
    await pool.query<{ kind: string; scheduled_at: Date; acked: boolean }>(
      'SELECT kind, scheduled_at, acked FROM entity_reminders WHERE user_id=$1 AND task_id=$2 ORDER BY scheduled_at DESC',
      [userId, taskId],
    )
  ).rows
  for (const r of reminderRows) events.push({ type: 'reminder', at: at(r.scheduled_at), kind: r.kind as 'start' | 'due', title: r.kind === 'start' ? '开始时间提醒' : '截止时间提醒', acked: r.acked })
  // 投机摘要（验收摘要取最后回复节选，失败取错误信息）
  const digestRows = (await pool.query<{ kind: string; digest: any; created_at: Date }>('SELECT kind, digest, created_at FROM task_digests WHERE user_id=$1 AND task_id=$2', [userId, taskId])).rows
  for (const d of digestRows) {
    const text = d.kind === 'failure' ? (d.digest?.error ?? '') : (d.digest?.lastReply ?? '')
    events.push({ type: 'digest', at: at(d.created_at), kind: d.kind as 'review' | 'failure', text: String(text).slice(0, 300) })
  }
  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  return events.slice(0, limit)
}
