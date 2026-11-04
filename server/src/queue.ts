import type pg from 'pg'

// 派活排队：目标电脑离线时不直接失败，先把「派给谁、发什么」存下来，
// 等那台电脑的执行器上线再自动派发。只存必要字段，任务的 agent/machine/cwd
// 也同步落到 tasks 上（界面据此显示排队态），队列本身是「待投递的一次快照」。
type DB = Pick<pg.Pool, 'query'>

export type QueuedDispatch = {
  userId: number
  taskId: number
  title: string
  machine: string
  agent: string
  cwd: string
  text: string
  attempts: number
  createdAt: string
}

export async function migrateQueue(db: DB) {
  await db.query(`CREATE TABLE IF NOT EXISTS task_dispatch_queue (
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id bigint NOT NULL,
    machine text NOT NULL,
    agent text NOT NULL,
    cwd text NOT NULL DEFAULT '',
    text text NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, task_id),
    FOREIGN KEY (user_id, task_id) REFERENCES tasks(user_id, id) ON DELETE CASCADE)`)
  await db.query('CREATE INDEX IF NOT EXISTS idx_dispatch_queue_machine ON task_dispatch_queue(user_id, machine, created_at)')
}

const toQueued = (r: any): QueuedDispatch => ({
  userId: Number(r.user_id),
  taskId: Number(r.task_id),
  title: r.title ?? '',
  machine: r.machine,
  agent: r.agent,
  cwd: r.cwd,
  text: r.text,
  attempts: Number(r.attempts),
  createdAt: new Date(r.created_at).toISOString(),
})

// 同一任务重复排队时覆盖旧的那次（用户改了第一条消息或换了电脑，以最新为准）
export async function enqueueDispatch(db: DB, userId: number, taskId: number, d: { machine: string; agent: string; cwd: string; text: string }) {
  await db.query(
    `INSERT INTO task_dispatch_queue(user_id,task_id,machine,agent,cwd,text)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id,task_id) DO UPDATE
       SET machine=excluded.machine,agent=excluded.agent,cwd=excluded.cwd,text=excluded.text,
           attempts=0,created_at=now()`,
    [userId, taskId, d.machine, d.agent, d.cwd, d.text],
  )
}

export async function dequeueDispatch(db: DB, userId: number, taskId: number): Promise<boolean> {
  const r = await db.query('DELETE FROM task_dispatch_queue WHERE user_id=$1 AND task_id=$2', [userId, taskId])
  return (r.rowCount ?? 0) > 0
}

// 按入队顺序取这台电脑待投递的活；带上 title，派发时要建会话标题
export async function queuedFor(db: DB, userId: number, machine: string, limit: number): Promise<QueuedDispatch[]> {
  const r = await db.query(
    `SELECT q.*, t.title FROM task_dispatch_queue q
       JOIN tasks t ON t.user_id=q.user_id AND t.id=q.task_id
      WHERE q.user_id=$1 AND q.machine=$2
      ORDER BY q.created_at, q.task_id LIMIT $3`,
    [userId, machine, limit],
  )
  return r.rows.map(toQueued)
}

export async function bumpAttempts(db: DB, userId: number, taskId: number): Promise<number> {
  const r = await db.query(
    'UPDATE task_dispatch_queue SET attempts=attempts+1 WHERE user_id=$1 AND task_id=$2 RETURNING attempts',
    [userId, taskId],
  )
  return Number(r.rows[0]?.attempts ?? 0)
}

// 过期的排队项直接丢掉：电脑一直不上线时，不能让一周后的一次上线喷出几十个会话
export async function expireQueued(db: DB, ttlMs: number): Promise<{ userId: number; taskId: number }[]> {
  const r = await db.query(
    `DELETE FROM task_dispatch_queue WHERE created_at < now() - make_interval(secs => $1) RETURNING user_id, task_id`,
    [ttlMs / 1000],
  )
  return r.rows.map(row => ({ userId: Number(row.user_id), taskId: Number(row.task_id) }))
}
