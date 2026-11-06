import type pg from 'pg'
import { TaskError, object } from './tasks.ts'
import { DEFAULT_POLICY, type RefereePolicy } from './referee.ts'

// 项目经理：一个账号一个，负责三件事——把处理意见「细化」成人话、在开关打开时把
// 人已经确认过的任务派出去、以及在会话卡在等授权时按规则代批（judgeApproval）。
//
// 代批与自动派发是两个独立开关：可以只代批不派活，也可以只派活不代批。
//
// 自动化边界（重要，改这里之前先想清楚）：
//   ① 只派「由处理意见确认生成」的任务（created_task_id 指向它），历史 todo 一律不动；
//   ② 只派还没派过的：没有活跃 run、不在排队里、也没被自动派发成功过——
//      确认时会挂上来源会话，所以不能拿「有没有关联会话」当作派过的判据；
//      派发失败退回待办后仍可重试；
//   ③ 同一任务 24 小时内自动派发失败 3 次就停手，不会每分钟重试同一个坏任务；
//   ④ 并发上限按账号算（机器是同一台），每小时上限按自动派发次数算；
//   ⑤ 没有「无人确认」的路径：任务必须由人在处理意见卡片上点过「生成任务」。
//
// 挑任务与限额都是纯查询，真正的派发动作由调用方注入（routes 里的 startTaskDispatch），
// 这样这层可以单测，也不会把 startSession 的一大坨闭包拖进来。

type DB = Pick<pg.Pool, 'query'>

export type DispatchManager = {
  roleId: number | null
  enabled: boolean
  /** 同时允许在跑的 run 数（含排队） */
  maxRunning: number
  /** 每小时最多自动派几次 */
  maxPerHour: number
  /** 代批策略：waiting 时哪些操作可以不让真人点 */
  approve: RefereePolicy
  updatedAt: string | null
}

export const DEFAULT_MANAGER: DispatchManager = {
  roleId: null, enabled: false, maxRunning: 2, maxPerHour: 6,
  approve: { ...DEFAULT_POLICY }, updatedAt: null,
}
const MAX_RUNNING_CAP = 10
const MAX_PER_HOUR_CAP = 60
const FAIL_LIMIT = 3

export async function migrateDispatchManager(db: DB) {
  await db.query(`CREATE TABLE IF NOT EXISTS dispatch_manager (
    user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    role_id bigint REFERENCES roles(id) ON DELETE SET NULL,
    enabled boolean NOT NULL DEFAULT false,
    max_running integer NOT NULL DEFAULT 2,
    max_per_hour integer NOT NULL DEFAULT 6,
    approve_enabled boolean NOT NULL DEFAULT false,
    approve_read boolean NOT NULL DEFAULT true,
    approve_write boolean NOT NULL DEFAULT true,
    approve_tests boolean NOT NULL DEFAULT true,
    approve_network boolean NOT NULL DEFAULT false,
    approve_per_hour integer NOT NULL DEFAULT 60,
    updated_at timestamptz NOT NULL DEFAULT now())`)
  // 自动派发留痕：谁派的、结果如何、为什么没派成。任务卡上要能回答「这是谁派给我的」
  await db.query(`CREATE TABLE IF NOT EXISTS dispatch_auto_log (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id bigint NOT NULL,
    run_id text,
    result text NOT NULL CHECK (result IN ('dispatched','queued','failed')),
    error text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now())`)
  await db.query('CREATE INDEX IF NOT EXISTS idx_dispatch_auto_task ON dispatch_auto_log(user_id,task_id,created_at DESC)')
  // 老库补列：代批是后加的，CREATE TABLE IF NOT EXISTS 不会给已有表加字段
  for (const col of [
    'approve_enabled boolean NOT NULL DEFAULT false',
    'approve_read boolean NOT NULL DEFAULT true',
    'approve_write boolean NOT NULL DEFAULT true',
    'approve_tests boolean NOT NULL DEFAULT true',
    'approve_network boolean NOT NULL DEFAULT false',
    'approve_per_hour integer NOT NULL DEFAULT 60',
  ]) await db.query(`ALTER TABLE dispatch_manager ADD COLUMN IF NOT EXISTS ${col}`)
}

const row = (r: any): DispatchManager => ({
  roleId: r.role_id === null || r.role_id === undefined ? null : Number(r.role_id),
  enabled: !!r.enabled,
  maxRunning: Number(r.max_running ?? 2),
  maxPerHour: Number(r.max_per_hour ?? 6),
  approve: {
    enabled: !!r.approve_enabled,
    allowRead: r.approve_read !== false,
    allowWrite: r.approve_write !== false,
    allowTests: r.approve_tests !== false,
    allowNetwork: !!r.approve_network,
    maxPerHour: Number(r.approve_per_hour ?? 60),
  },
  updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
})

export async function getManager(db: DB, user: number): Promise<DispatchManager> {
  const r = await db.query('SELECT * FROM dispatch_manager WHERE user_id=$1', [user])
  return r.rows[0] ? row(r.rows[0]) : { ...DEFAULT_MANAGER }
}

const int = (v: unknown, label: string, min: number, max: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN
  if (!Number.isInteger(n) || n < min || n > max) throw new TaskError(`${label}须为 ${min}–${max} 的整数`)
  return n
}

export async function saveManager(db: DB, user: number, raw: unknown): Promise<DispatchManager> {
  const b = object(raw ?? {})
  const cur = await getManager(db, user)
  let roleId = cur.roleId
  if ('roleId' in b) {
    if (b.roleId === null || b.roleId === '') roleId = null
    else {
      const id = Number(b.roleId)
      if (!Number.isSafeInteger(id) || id < 1) throw new TaskError('角色编号不合法')
      if (!(await db.query('SELECT id FROM roles WHERE user_id=$1 AND id=$2', [user, id])).rowCount) throw new TaskError('角色不存在', 404)
      roleId = id
    }
  }
  let enabled = cur.enabled
  if ('enabled' in b) {
    if (typeof b.enabled !== 'boolean') throw new TaskError('开关必须是布尔值')
    enabled = b.enabled
  }
  const maxRunning = 'maxRunning' in b ? int(b.maxRunning, '并发上限', 1, MAX_RUNNING_CAP) : cur.maxRunning
  const maxPerHour = 'maxPerHour' in b ? int(b.maxPerHour, '每小时上限', 1, MAX_PER_HOUR_CAP) : cur.maxPerHour
  const approve = { ...cur.approve }
  if ('approve' in b) {
    const a = object(b.approve ?? {})
    for (const k of ['enabled', 'allowRead', 'allowWrite', 'allowTests', 'allowNetwork'] as const) {
      if (k in a) {
        if (typeof a[k] !== 'boolean') throw new TaskError(`${k} 必须是布尔值`)
        approve[k] = a[k] as boolean
      }
    }
    if ('maxPerHour' in a) approve.maxPerHour = int(a.maxPerHour, '每小时代批上限', 1, 600)
  }
  // 开着自动派发或代批却没有项目经理：等于「没人负责还自动放行」，直接拒绝
  if ((enabled || approve.enabled) && roleId === null) throw new TaskError('先选一个项目经理角色，再开启自动派发或代批')
  const r = await db.query(
    `INSERT INTO dispatch_manager(user_id,role_id,enabled,max_running,max_per_hour,
       approve_enabled,approve_read,approve_write,approve_tests,approve_network,approve_per_hour,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
     ON CONFLICT (user_id) DO UPDATE SET role_id=$2, enabled=$3, max_running=$4, max_per_hour=$5,
       approve_enabled=$6, approve_read=$7, approve_write=$8, approve_tests=$9, approve_network=$10,
       approve_per_hour=$11, updated_at=now()
     RETURNING *`,
    [user, roleId, enabled, maxRunning, maxPerHour,
      approve.enabled, approve.allowRead, approve.allowWrite, approve.allowTests, approve.allowNetwork, approve.maxPerHour],
  )
  return row(r.rows[0])
}

/** 当前占用的并发：排队中 + 运行中的 run（不分来源，机器是同一台） */
export async function runningCount(db: DB, user: number): Promise<number> {
  const r = await db.query("SELECT count(*) c FROM runs WHERE user_id=$1 AND status IN ('queued','running')", [user])
  return Number(r.rows[0]?.c ?? 0)
}

/** 最近一小时已经代批了几次：超上限就全部交回给人 */
export async function recentApproveCount(db: DB, user: number): Promise<number> {
  const r = await db.query(
    "SELECT count(*) c FROM approvals WHERE user_id=$1 AND decided_by='manager' AND decided_at > now() - interval '1 hour'",
    [user],
  )
  return Number(r.rows[0]?.c ?? 0)
}

/** 最近一小时已经自动派了几次 */
export async function recentAutoCount(db: DB, user: number): Promise<number> {
  const r = await db.query(
    "SELECT count(*) c FROM dispatch_auto_log WHERE user_id=$1 AND result IN ('dispatched','queued') AND created_at > now() - interval '1 hour'",
    [user],
  )
  return Number(r.rows[0]?.c ?? 0)
}

export type Candidate = { id: number; title: string; priority: string }

/**
 * 可自动派发的任务：人已经确认的处理意见生成的，或者人直接「发新单」交给它的；
 * 还没派过、失败次数没超限。按优先级再按生成顺序，先派要紧的、先提出的。
 */
export async function pickCandidates(db: DB, user: number, limit: number): Promise<Candidate[]> {
  if (limit <= 0) return []
  const r = await db.query<Candidate>(
    `SELECT t.id, t.title, t.priority FROM tasks t
     WHERE t.user_id = $1
       AND t.status = 'todo'
       AND (t.auto_dispatch OR EXISTS (
         SELECT 1 FROM session_proposals p
         WHERE p.user_id = t.user_id AND p.created_task_id = t.id AND p.status = 'accepted'))
       AND NOT EXISTS (
         SELECT 1 FROM runs r WHERE r.user_id = t.user_id AND r.task_id = t.id AND r.status IN ('queued','running'))
       AND NOT EXISTS (
         SELECT 1 FROM task_dispatch_queue q WHERE q.user_id = t.user_id AND q.task_id = t.id)
       AND NOT EXISTS (
         SELECT 1 FROM dispatch_auto_log l
         WHERE l.user_id = t.user_id AND l.task_id = t.id AND l.result IN ('dispatched','queued'))
       AND (SELECT count(*) FROM dispatch_auto_log l
            WHERE l.user_id = t.user_id AND l.task_id = t.id AND l.result = 'failed'
              AND l.created_at > now() - interval '24 hours') < $2
     ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, t.created_at ASC, t.id ASC
     LIMIT $3`,
    [user, FAIL_LIMIT, limit],
  )
  return r.rows.map(v => ({ id: Number(v.id), title: v.title, priority: v.priority }))
}

/**
 * 发单时正文可以留空：项目经理按手里已有的事实补一份能直接开工的骨架。
 * 只拼已知信息，不替人猜业务细节——拼不出来的部分写成「先问再做」，比编一段更像样。
 */
export function composeTicket(input: {
  title: string; project: string; brief: string; recent: string[]; role: string; cwd: string;
}): string {
  const lines = ['## 目标', input.title.trim()]
  const bg: string[] = []
  if (input.project) bg.push(`项目：${input.project}${input.cwd ? `（${input.cwd}）` : ''}`)
  if (input.brief) bg.push(`项目说明：${input.brief}`)
  if (input.role) bg.push(`执行角色：${input.role}`)
  if (input.recent.length) bg.push(`最近进展：\n${input.recent.slice(-3).map(r => `- ${r}`).join('\n')}`)
  if (bg.length) lines.push('', '## 背景', ...bg)
  lines.push('', '## 交付', '- 做完说清改了哪些文件、怎么验证（构建 / 类型检查 / 测试）', '- 拿不准的先问，别自己猜业务规则')
  return lines.join('\n').slice(0, 4000)
}

export async function logAuto(db: DB, user: number, taskId: number, result: 'dispatched' | 'queued' | 'failed', runId: string | null = null, error = ''): Promise<void> {  await db.query(
    'INSERT INTO dispatch_auto_log(user_id,task_id,run_id,result,error) VALUES($1,$2,$3,$4,$5)',
    [user, taskId, runId, result, error.slice(0, 500)],
  )
}

/** 一个账号这一轮能派几个：并发余量与每小时余量取小 */
export function quota(manager: DispatchManager, running: number, recent: number): number {
  if (!manager.enabled) return 0
  return Math.max(0, Math.min(manager.maxRunning - running, manager.maxPerHour - recent))
}

export type TickDeps = {
  pool: pg.Pool
  /** 真正派发一个任务；由 routes 注入，内部会走在线直派 / 离线入队 */
  dispatch: (userId: number, taskId: number, fallbackRoleId: number | null) => Promise<{ queued: boolean; runId?: string }>
}

export type TickResult = { users: number; dispatched: number; failed: number }

/**
 * 跑一轮：把所有开着自动派发的账号过一遍。单个任务失败不中断其他人。
 * 派发失败也会留痕，连续失败到上限后 pickCandidates 会自动跳过它。
 */
export async function runDispatchTick(deps: TickDeps): Promise<TickResult> {
  const { pool } = deps
  const managers = (await pool.query("SELECT * FROM dispatch_manager WHERE enabled = true")).rows
  let dispatched = 0, failed = 0
  for (const m of managers) {
    const userId = Number(m.user_id)
    const manager = row(m)
    try {
      const room = quota(manager, await runningCount(pool, userId), await recentAutoCount(pool, userId))
      if (room <= 0) continue
      for (const c of await pickCandidates(pool, userId, room)) {
        try {
          const res = await deps.dispatch(userId, c.id, manager.roleId)
          await logAuto(pool, userId, c.id, res.queued ? 'queued' : 'dispatched', res.runId ?? null)
          dispatched++
        } catch (e: any) {
          await logAuto(pool, userId, c.id, 'failed', null, String(e?.message ?? e))
          failed++
        }
      }
    } catch {
      // 一个账号出问题不影响其他账号
    }
  }
  return { users: managers.length, dispatched, failed }
}
