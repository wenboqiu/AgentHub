import type pg from 'pg'

// 派活看板：把「排队中 / 在跑 / 卡住」的活聚到一张板上，全部现场推导，不落新表。
// - 排队来自 task_dispatch_queue（0.8.2）
// - 在跑来自 runs：既认挂在任务上的（task_id），也认只挂在关联会话上的（在会话里续聊时
//   新建的 run 没有 task_id，只靠 task_sessions 才能找到）
// - 「进行中无运行」= 任务是 doing、没排队、且两条路都找不到活跃 run：
//   通常是电脑掉线把 run 打断后没人接手，或人为把状态改成了 doing
type DB = Pick<pg.Pool, 'query'>

export type BoardRun = { id: string; sessionId: string | null; status: 'queued' | 'running'; startedAt: string }
export type BoardEntry = {
  taskId: number
  title: string
  status: 'todo' | 'doing' | 'review'
  agent: string | null
  machine: string | null
  cwd: string | null
  priority: 'high' | 'medium' | 'low'
  queued: boolean
  attempts: number
  queuedAt: string | null
  run: BoardRun | null
  waitingApproval: boolean
  lastActivityAt: string | null
  machineOnline: boolean
  stuck: boolean
  updatedAt: string
}
export type Board = { entries: BoardEntry[]; agents: string[]; generatedAt: string }

export async function dispatchBoard(db: DB, userId: number, online: string[], mandateMode: 'off' | 'observe' | 'auto' = 'off'): Promise<Board> {
  const [queuedRows, doingRows] = await Promise.all([
    db.query(
      `SELECT q.task_id, q.machine, q.agent, q.attempts, q.created_at,
              t.title, t.status, t.agent AS task_agent, t.cwd, t.priority, t.updated_at
         FROM task_dispatch_queue q
         JOIN tasks t ON t.user_id = q.user_id AND t.id = q.task_id
        WHERE q.user_id = $1
        ORDER BY q.created_at, q.task_id`,
      [userId],
    ),
    db.query(
      `SELECT id, status, title, agent, machine, cwd, priority, updated_at FROM tasks
        WHERE user_id = $1 AND status = 'doing'
        ORDER BY updated_at DESC, id DESC`,
      [userId],
    ),
  ])
  const ids = doingRows.rows.map(r => Number(r.id))
  // 做完上面两查再做下面三查：ANY($2) 需要先知道有哪些 doing 任务
  type Rows = { rows: any[] }
  const empty: Rows = { rows: [] }
  const [runRows, sessionRows, approvalRows]: Rows[] = ids.length
    ? await Promise.all([
        // 两条路合并取每个任务最新的活跃 run：task_id 直挂 或 经关联会话找到
        db.query(
          `SELECT u.* FROM (
             SELECT r.id, r.session_id, r.status, r.created_at, ts.task_id FROM runs r
               JOIN task_sessions ts ON ts.user_id = r.user_id AND ts.session_id = r.session_id
              WHERE ts.user_id = $1 AND ts.task_id = ANY($2) AND r.status IN ('queued','running')
             UNION ALL
             SELECT r.id, r.session_id, r.status, r.created_at, r.task_id FROM runs r
              WHERE r.user_id = $1 AND r.task_id = ANY($2) AND r.status IN ('queued','running')
           ) u ORDER BY u.created_at DESC`,
          [userId, ids],
        ),
        db.query(
          `SELECT ts.task_id, max(s.event_at) AS last_at
             FROM task_sessions ts
             JOIN sessions s ON s.user_id = ts.user_id AND s.id = ts.session_id
            WHERE ts.user_id = $1 AND ts.task_id = ANY($2)
            GROUP BY ts.task_id`,
          [userId, ids],
        ),
        db.query(
          `SELECT ts.task_id FROM approvals a
             JOIN task_sessions ts ON ts.user_id = a.user_id AND ts.session_id = a.session_id
            WHERE a.user_id = $1 AND a.status = 'pending' AND ts.task_id = ANY($2)
            GROUP BY ts.task_id`,
          [userId, ids],
        ),
      ])
    : [empty, empty, empty]
  const runs = new Map<number, BoardRun>()
  for (const r of runRows.rows) {
    const taskId = Number(r.task_id)
    if (!runs.has(taskId)) runs.set(taskId, { id: r.id, sessionId: r.session_id, status: r.status, startedAt: new Date(r.created_at).toISOString() })
  }
  const activity = new Map<number, string>()
  for (const r of sessionRows.rows) activity.set(Number(r.task_id), new Date(r.last_at).toISOString())
  const waiting = new Set(approvalRows.rows.map(r => Number(r.task_id)))
  const isOnline = (machine: string | null) => !machine || online.includes(machine)
  const queuedIds = new Set(queuedRows.rows.map(r => Number(r.task_id)))
  const entries: BoardEntry[] = queuedRows.rows.map(r => ({
    taskId: Number(r.task_id),
    title: r.title,
    status: r.status,
    agent: r.agent,
    machine: r.machine,
    cwd: r.cwd,
    priority: r.priority ?? 'medium',
    queued: true,
    attempts: Number(r.attempts),
    queuedAt: new Date(r.created_at).toISOString(),
    run: null,
    waitingApproval: false,
    lastActivityAt: null,
    machineOnline: isOnline(r.machine),
    stuck: false,
    updatedAt: new Date(r.updated_at).toISOString(),
  }))
  for (const r of doingRows.rows) {
    const taskId = Number(r.id)
    entries.push({
      taskId,
      title: r.title,
      status: r.status,
      agent: r.agent,
      machine: r.machine,
      cwd: r.cwd,
      priority: r.priority ?? 'medium',
      queued: queuedIds.has(taskId),
      attempts: 0,
      queuedAt: null,
      run: runs.get(taskId) ?? null,
      waitingApproval: waiting.has(taskId),
      lastActivityAt: activity.get(taskId) ?? null,
      machineOnline: isOnline(r.machine),
      stuck: !queuedIds.has(taskId) && !runs.has(taskId),
      updatedAt: new Date(r.updated_at).toISOString(),
    })
  }
  // 开了 Mandate（observe / auto）：板上只留「需要人」的项——范围外等人决定的审批、卡住的、
  // 离线排队的，以及待验收的任务；在正常跑的健康任务不出现。mode=off 时保持原样。
  if (mandateMode !== 'off') {
    const needsHuman = entries.filter(e => e.waitingApproval || e.stuck || (e.queued && !e.machineOnline))
    const review = await db.query(
      `SELECT id, title, agent, machine, cwd, priority, updated_at FROM tasks
        WHERE user_id = $1 AND status = 'review' AND mandate_id IS NOT NULL
        ORDER BY updated_at DESC, id DESC`,
      [userId],
    )
    for (const r of review.rows) {
      needsHuman.push({
        taskId: Number(r.id), title: r.title, status: 'review', agent: r.agent, machine: r.machine, cwd: r.cwd,
        priority: r.priority ?? 'medium', queued: false, attempts: 0, queuedAt: null, run: null, waitingApproval: false,
        lastActivityAt: null, machineOnline: isOnline(r.machine), stuck: false, updatedAt: new Date(r.updated_at).toISOString(),
      })
    }
    return { entries: needsHuman, agents: online, generatedAt: new Date().toISOString() }
  }
  return { entries, agents: online, generatedAt: new Date().toISOString() }
}
