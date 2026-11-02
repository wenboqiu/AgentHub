import type pg from 'pg'
import { missing } from './tasks.ts'

type DB = Pick<pg.Pool, 'query'>
// Join against the current schedule so changing dates, disabling alerts, completing
// or deleting an entity immediately invalidates any previous pending reminder.
const active = `SELECT r.*, t.title, 'task' AS entity_type, t.id AS entity_id FROM entity_reminders r
  JOIN tasks t ON t.id=r.task_id AND t.user_id=r.user_id WHERE t.status <> 'done'
    AND ((r.kind='start' AND t.remind_start AND r.scheduled_at=t.start_at) OR (r.kind='due' AND t.remind_due AND r.scheduled_at=t.due_at))
  UNION ALL SELECT r.*, g.title, 'goal' AS entity_type, g.id AS entity_id FROM entity_reminders r
  JOIN goals g ON g.id=r.goal_id AND g.user_id=r.user_id WHERE g.status='active'
    AND ((r.kind='start' AND g.remind_start AND r.scheduled_at=g.start_at) OR (r.kind='due' AND g.remind_due AND r.scheduled_at=g.due_at))`
const toReminder = (r: any) => ({ id: Number(r.id), entityType: r.entity_type as 'task'|'goal', entityId: Number(r.entity_id), title: r.title, kind: r.kind as 'start'|'due', scheduledAt: r.scheduled_at.toISOString() })

export async function collectReminders(db: DB, user?: number) {
  const ids: number[] = []
  for (const table of ['tasks','goals'] as const) for (const kind of ['start','due'] as const) {
    const column = kind === 'start' ? 'start_at' : 'due_at', toggle = kind === 'start' ? 'remind_start' : 'remind_due'
    const fk = table === 'tasks' ? 'task_id' : 'goal_id', state = table === 'tasks' ? "status <> 'done'" : "status='active'"
    const r = await db.query(`INSERT INTO entity_reminders(user_id,${fk},kind,scheduled_at)
      SELECT user_id,id,'${kind}',${column} FROM ${table} WHERE ${state} AND ${toggle} AND ${column} <= now()
      ${user === undefined ? '' : 'AND user_id=$1'} ON CONFLICT DO NOTHING RETURNING id`, user === undefined ? [] : [user])
    ids.push(...r.rows.map(r => Number(r.id)))
  }
  if (!ids.length) return []
  const r = await db.query(`SELECT * FROM (${active}) a WHERE id=ANY($1::bigint[]) AND NOT acked ORDER BY scheduled_at,id`, [ids])
  return r.rows.map(r => ({ userId: Number(r.user_id), reminder: toReminder(r) }))
}
export async function listReminders(db: DB, user: number) {
  const r = await db.query(`SELECT * FROM (${active}) a WHERE user_id=$1 AND NOT acked ORDER BY scheduled_at,id`, [user])
  return r.rows.map(toReminder)
}
export async function ackReminder(db: DB, user: number, id: number) {
  if (!(await db.query('UPDATE entity_reminders SET acked=true WHERE user_id=$1 AND id=$2 RETURNING id', [user,id])).rowCount) throw missing()
}
