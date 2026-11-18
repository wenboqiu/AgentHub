import pg from 'pg'

// 数据统计：按天汇总表 daily_stats / daily_model_stats。
// 源表保留期很短（会话 30 天、runs 90 天），所以定时把最近几天重算进汇总表，窗口之外的行一律不碰（封存）。
// 口径与限制见 docs/stats-design.md。

type DB = Pick<pg.Pool, 'query'>

export const DEFAULT_STATS_TZ = 'Asia/Shanghai'
/** 重算窗口（天）：必须小于会话保留期 30 天，否则会话被清理后窗口最老几天的数字会往下掉 */
export const ROLLUP_DAYS = 28

export async function migrateStats(db: DB) {
  await db.query('ALTER TABLE sessions ADD COLUMN IF NOT EXISTS first_seen_at timestamptz')
  await db.query('UPDATE sessions SET first_seen_at = state_since WHERE first_seen_at IS NULL')
  await db.query('ALTER TABLE sessions ALTER COLUMN first_seen_at SET DEFAULT now()')
  await db.query(`CREATE TABLE IF NOT EXISTS daily_stats (
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day date NOT NULL,
    agent text NOT NULL DEFAULT '',
    project text NOT NULL DEFAULT '',
    sessions_new int NOT NULL DEFAULT 0,
    sessions_active int NOT NULL DEFAULT 0,
    messages int NOT NULL DEFAULT 0,
    runs int NOT NULL DEFAULT 0,
    runs_done int NOT NULL DEFAULT 0,
    runs_failed int NOT NULL DEFAULT 0,
    runs_stopped int NOT NULL DEFAULT 0,
    run_seconds bigint NOT NULL DEFAULT 0,
    tokens_in bigint NOT NULL DEFAULT 0,
    tokens_out bigint NOT NULL DEFAULT 0,
    cost_usd numeric(14,4) NOT NULL DEFAULT 0,
    credits numeric(14,2) NOT NULL DEFAULT 0,
    tasks_created int NOT NULL DEFAULT 0,
    tasks_done int NOT NULL DEFAULT 0,
    task_done_seconds bigint NOT NULL DEFAULT 0,
    review_rejects int NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, day, agent, project))`)
  await db.query('CREATE INDEX IF NOT EXISTS idx_daily_stats_day ON daily_stats(user_id, day)')
  await db.query(`CREATE TABLE IF NOT EXISTS daily_model_stats (
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day date NOT NULL,
    model text NOT NULL DEFAULT '',
    runs int NOT NULL DEFAULT 0,
    tokens_in bigint NOT NULL DEFAULT 0,
    tokens_out bigint NOT NULL DEFAULT 0,
    cost_usd numeric(14,4) NOT NULL DEFAULT 0,
    credits numeric(14,2) NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day, model))`)
  await db.query('CREATE INDEX IF NOT EXISTS idx_daily_model_stats_day ON daily_model_stats(user_id, day)')
}

// ---------- 时区 ----------

type Warn = (msg: string) => void
let resolvedTz: string | null = null

/** 统计时区：环境变量 STATS_TZ，默认 Asia/Shanghai；用 Postgres 校验，不合法退回默认并 warn。结果缓存。 */
export async function resolveStatsTz(db: DB, warn?: Warn): Promise<string> {
  if (resolvedTz) return resolvedTz
  const want = process.env.STATS_TZ?.trim() || DEFAULT_STATS_TZ
  let tz = want
  try {
    await db.query('SELECT now() AT TIME ZONE $1', [want])
  } catch {
    warn?.(`STATS_TZ=${want} 不是合法时区，退回 ${DEFAULT_STATS_TZ}`)
    tz = DEFAULT_STATS_TZ
  }
  resolvedTz = tz
  return tz
}

// ---------- 汇总 ----------

const METRICS = [
  ['sessionsNew', 'sessions_new'], ['sessionsActive', 'sessions_active'], ['messages', 'messages'],
  ['runs', 'runs'], ['runsDone', 'runs_done'], ['runsFailed', 'runs_failed'], ['runsStopped', 'runs_stopped'],
  ['runSeconds', 'run_seconds'], ['tokensIn', 'tokens_in'], ['tokensOut', 'tokens_out'],
  ['costUsd', 'cost_usd'], ['credits', 'credits'],
  ['tasksCreated', 'tasks_created'], ['tasksDone', 'tasks_done'], ['taskDoneSeconds', 'task_done_seconds'],
  ['reviewRejects', 'review_rejects'],
] as const
const MODEL_METRICS = ['runs', 'tokensIn', 'tokensOut', 'costUsd', 'credits'] as const

export type StatsMetrics = Record<(typeof METRICS)[number][0], number>
const zeroMetrics = (): StatsMetrics => Object.fromEntries(METRICS.map(([k]) => [k, 0])) as StatsMetrics

// 一天按统计时区切：($2 = tz)
const dayOf = (col: string) => `(${col} AT TIME ZONE $2)::date`

/** 重算 [fromDay, 今天] 这段（单用户，调用方已持锁并在事务里）。fromDay 是统计时区下的 YYYY-MM-DD */
async function recompute(c: DB, userId: number, tz: string, fromDay: string) {
  const p = [userId, tz, fromDay]
  await c.query('DELETE FROM daily_stats WHERE user_id = $1 AND day >= $2::date', [userId, fromDay])
  await c.query('DELETE FROM daily_model_stats WHERE user_id = $1 AND day >= $2::date', [userId, fromDay])
  // 几条 INSERT ... SELECT 按主键累加，比 FULL OUTER JOIN 简单
  const ins = (cols: string[], select: string) => {
    const set = cols.map(col => `${col} = daily_stats.${col} + EXCLUDED.${col}`).join(', ')
    return c.query(
      `INSERT INTO daily_stats (user_id, day, agent, project, ${cols.join(', ')}) ${select}
       ON CONFLICT (user_id, day, agent, project) DO UPDATE SET ${set}, updated_at = now()`, p)
  }
  // 会话新建
  await ins(['sessions_new'], `SELECT $1::bigint, ${dayOf('first_seen_at')}, agent, project, count(*)::int
    FROM sessions WHERE user_id = $1 AND first_seen_at IS NOT NULL AND ${dayOf('first_seen_at')} >= $3::date GROUP BY 2, 3, 4`)
  // 活跃会话 + 消息数（会话已不存在的行归 ''）
  await ins(['sessions_active', 'messages'], `SELECT $1::bigint, ${dayOf('a.bucket')}, COALESCE(s.agent, ''), COALESCE(s.project, ''),
      count(DISTINCT a.session_id)::int, COALESCE(sum(a.count), 0)::int
    FROM session_activity a LEFT JOIN sessions s ON s.user_id = a.user_id AND s.id = a.session_id
    WHERE a.user_id = $1 AND ${dayOf('a.bucket')} >= $3::date GROUP BY 2, 3, 4`)
  // 运行：agent / project 先取会话，没有会话再取任务
  const runJoin = `FROM runs r
    LEFT JOIN sessions s ON s.user_id = r.user_id AND s.id = r.session_id
    LEFT JOIN tasks t ON t.user_id = r.user_id AND t.id = r.task_id
    LEFT JOIN projects pr ON pr.user_id = t.user_id AND pr.id = t.project_id
    WHERE r.user_id = $1 AND ${dayOf('r.created_at')} >= $3::date`
  const tokIn = "COALESCE((r.usage->>'input')::numeric, 0)"
  const tokOut = "COALESCE((r.usage->>'output')::numeric, 0)"
  const cost = "COALESCE((r.usage->>'costUsd')::numeric, 0)"
  const credits = "COALESCE((r.usage->>'credits')::numeric, 0)"
  await ins(['runs', 'runs_done', 'runs_failed', 'runs_stopped', 'run_seconds', 'tokens_in', 'tokens_out', 'cost_usd', 'credits'],
    `SELECT $1::bigint, ${dayOf('r.created_at')}, COALESCE(s.agent, t.agent, ''),
      CASE WHEN s.id IS NOT NULL THEN s.project ELSE COALESCE(pr.name, '') END,
      count(*)::int,
      count(*) FILTER (WHERE r.status = 'done')::int,
      count(*) FILTER (WHERE r.status = 'failed')::int,
      count(*) FILTER (WHERE r.status = 'stopped')::int,
      COALESCE(sum(extract(epoch FROM r.updated_at - r.created_at)) FILTER (WHERE r.status IN ('done','failed','stopped')), 0)::bigint,
      sum(${tokIn})::bigint, sum(${tokOut})::bigint, sum(${cost}), sum(${credits})
    ${runJoin} GROUP BY 2, 3, 4`)
  await c.query(
    `INSERT INTO daily_model_stats (user_id, day, model, runs, tokens_in, tokens_out, cost_usd, credits)
     SELECT $1::bigint, ${dayOf('r.created_at')}, COALESCE(r.model, ''), count(*)::int,
       sum(${tokIn})::bigint, sum(${tokOut})::bigint, sum(${cost}), sum(${credits})
     FROM runs r WHERE r.user_id = $1 AND ${dayOf('r.created_at')} >= $3::date GROUP BY 2, 3
     ON CONFLICT (user_id, day, model) DO UPDATE SET runs = daily_model_stats.runs + EXCLUDED.runs,
       tokens_in = daily_model_stats.tokens_in + EXCLUDED.tokens_in, tokens_out = daily_model_stats.tokens_out + EXCLUDED.tokens_out,
       cost_usd = daily_model_stats.cost_usd + EXCLUDED.cost_usd, credits = daily_model_stats.credits + EXCLUDED.credits`, p)
  // 任务新建
  const taskJoin = `FROM tasks t LEFT JOIN projects pr ON pr.user_id = t.user_id AND pr.id = t.project_id`
  await ins(['tasks_created'], `SELECT $1::bigint, ${dayOf('t.created_at')}, COALESCE(t.agent, ''), COALESCE(pr.name, ''), count(*)::int
    ${taskJoin} WHERE t.user_id = $1 AND ${dayOf('t.created_at')} >= $3::date GROUP BY 2, 3, 4`)
  // 任务完成（done_at 改离 done 时会被清空）
  await ins(['tasks_done', 'task_done_seconds'], `SELECT $1::bigint, ${dayOf('t.done_at')}, COALESCE(t.agent, ''), COALESCE(pr.name, ''), count(*)::int,
      COALESCE(sum(extract(epoch FROM t.done_at - t.created_at)), 0)::bigint
    ${taskJoin} WHERE t.user_id = $1 AND t.done_at IS NOT NULL AND ${dayOf('t.done_at')} >= $3::date GROUP BY 2, 3, 4`)
  // 验收打回：当前仍是 fail 的检查项，按 updated_at 所在天
  await ins(['review_rejects'], `SELECT $1::bigint, ${dayOf('ri.updated_at')}, COALESCE(t.agent, ''), COALESCE(pr.name, ''), count(*)::int
    FROM review_items ri JOIN tasks t ON t.user_id = ri.user_id AND t.id = ri.task_id
    LEFT JOIN projects pr ON pr.user_id = t.user_id AND pr.id = t.project_id
    WHERE ri.user_id = $1 AND ri.status = 'fail' AND ${dayOf('ri.updated_at')} >= $3::date GROUP BY 2, 3, 4`)
}

async function todayIn(db: DB, tz: string): Promise<string> {
  return (await db.query<{ d: string }>('SELECT (now() AT TIME ZONE $1)::date::text AS d', [tz])).rows[0].d
}

/** 单用户的事务：advisory xact lock 串行化同一用户的重算 */
async function withUserLock<T>(pool: pg.Pool, userId: number, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    await c.query("SELECT pg_advisory_xact_lock(hashtext('stats:' || $1::text))", [userId])
    const out = await fn(c)
    await c.query('COMMIT')
    return out
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

async function hasRows(c: DB, userId: number): Promise<boolean> {
  return (await c.query('SELECT 1 FROM daily_stats WHERE user_id = $1 LIMIT 1', [userId])).rows.length > 0
}

/** 回填起点：min(最早任务创建日, 今天 - 90 天) */
async function backfillFrom(c: DB, userId: number, tz: string): Promise<string> {
  return (await c.query<{ d: string }>(
    `SELECT LEAST(
       COALESCE((SELECT ${dayOf('min(created_at)')} FROM tasks WHERE user_id = $1), (now() AT TIME ZONE $2)::date),
       (now() AT TIME ZONE $2)::date - 90)::text AS d`, [userId, tz])).rows[0].d
}

async function windowFrom(c: DB, tz: string, days: number): Promise<string> {
  return (await c.query<{ d: string }>('SELECT ((now() AT TIME ZONE $1)::date - $2::int)::text AS d', [tz, days - 1])).rows[0].d
}

/** 首次（该用户 daily_stats 一行都没有）回填历史；已有数据返回 false 且不动 */
export async function backfillStats(pool: pg.Pool, userId: number, tz: string): Promise<boolean> {
  return withUserLock(pool, userId, async c => {
    if (await hasRows(c, userId)) return false
    await recompute(c, userId, tz, await backfillFrom(c, userId, tz))
    return true
  })
}

/**
 * 重算最近 days（默认 28）天；窗口之外的行不碰。单用户且还没有任何行时先走回填。
 * 不传 userId = 全部有数据的用户，逐个处理，单个用户失败不影响其他人（抛出第一个错误前先处理完）。
 */
export async function rollupStats(pool: pg.Pool, opts: { userId?: number; days?: number; tz?: string } = {}): Promise<void> {
  const tz = opts.tz ?? await resolveStatsTz(pool)
  const days = Math.max(1, Math.min(opts.days ?? ROLLUP_DAYS, ROLLUP_DAYS))
  const one = (userId: number) => withUserLock(pool, userId, async c => {
    const from = (await hasRows(c, userId)) ? await windowFrom(c, tz, days) : await backfillFrom(c, userId, tz)
    await recompute(c, userId, tz, from)
  })
  if (opts.userId !== undefined) return one(opts.userId)
  const users = await pool.query<{ id: string }>(
    `SELECT u.id FROM users u WHERE EXISTS (SELECT 1 FROM tasks WHERE user_id = u.id) OR EXISTS (SELECT 1 FROM runs WHERE user_id = u.id)
       OR EXISTS (SELECT 1 FROM sessions WHERE user_id = u.id) OR EXISTS (SELECT 1 FROM daily_stats WHERE user_id = u.id)`)
  let firstErr: unknown
  for (const u of users.rows) {
    try { await one(Number(u.id)) } catch (e) { firstErr ??= e }
  }
  if (firstErr) throw firstErr
}

// ---------- 查询 ----------

export class StatsParamError extends Error {}

export const GRANULARITIES = ['day', 'week', 'month'] as const
export const BY_KEYS = ['none', 'agent', 'project', 'model'] as const
export type Granularity = (typeof GRANULARITIES)[number]
export type StatsBy = (typeof BY_KEYS)[number]
export type StatsParams = { from?: string; to?: string; granularity?: string; by?: string }
export type StatsResult = {
  granularity: Granularity
  from: string
  to: string
  tz: string
  series: ({ period: string } & StatsMetrics)[]
  totals: StatsMetrics
  previous: { from: string; to: string; totals: StatsMetrics }
  breakdown: { by: StatsBy; rows: ({ key: string } & StatsMetrics)[] }
  snapshot: { todo: number; doing: number; review: number; done: number }
}

const MAX_SPAN = { day: 400, week: 150, month: 60 } as const
const DAY_MS = 86_400_000

const parseDay = (s: string): number => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new StatsParamError('日期格式应为 YYYY-MM-DD')
  const t = Date.parse(`${s}T00:00:00Z`)
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) throw new StatsParamError('日期不合法')
  return t
}
const fmtDay = (t: number) => new Date(t).toISOString().slice(0, 10)
const addDays = (t: number, n: number) => t + n * DAY_MS
const mondayOf = (t: number) => addDays(t, -((new Date(t).getUTCDay() + 6) % 7))
const monthStart = (t: number) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) }
const addMonths = (t: number, n: number) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1) }
const alignDown = (g: Granularity, t: number) => g === 'day' ? t : g === 'week' ? mondayOf(t) : monthStart(t)
const nextPeriod = (g: Granularity, t: number) => g === 'day' ? addDays(t, 1) : g === 'week' ? addDays(t, 7) : addMonths(t, 1)

const metricSelect = METRICS.map(([k, col]) => `COALESCE(sum(${col}), 0)::float8 AS "${k}"`).join(', ')
const num = (v: unknown) => Number(v) || 0

export async function queryStats(pool: pg.Pool, userId: number, params: StatsParams, tz?: string): Promise<StatsResult> {
  tz ??= await resolveStatsTz(pool)
  const granularity = (params.granularity ?? 'day') as Granularity
  if (!GRANULARITIES.includes(granularity)) throw new StatsParamError('granularity 只能是 day / week / month')
  const by = (params.by ?? 'none') as StatsBy
  if (!BY_KEYS.includes(by)) throw new StatsParamError('by 只能是 none / agent / project / model')

  const today = parseDay(await todayIn(pool, tz))
  let toT = params.to ? parseDay(params.to) : today
  if (toT > today) toT = today
  let fromT: number
  if (params.from) fromT = alignDown(granularity, parseDay(params.from))
  else if (granularity === 'day') fromT = addDays(today, -13)
  else if (granularity === 'week') fromT = addDays(mondayOf(today), -11 * 7)
  else fromT = addMonths(monthStart(today), -11)
  if (params.from && parseDay(params.from) > toT) throw new StatsParamError('from 不能晚于 to')
  if (fromT > toT) throw new StatsParamError('from 不能晚于 to')

  // 周期起点序列（补零保证连续）
  const periods: number[] = []
  for (let t = fromT; t <= toT; t = nextPeriod(granularity, t)) {
    periods.push(t)
    if (periods.length > MAX_SPAN[granularity]) throw new StatsParamError(`跨度超限：${granularity} 最多 ${MAX_SPAN[granularity]} 个周期`)
  }
  const from = fmtDay(fromT)
  const to = fmtDay(toT)
  const spanDays = Math.round((toT - fromT) / DAY_MS) + 1
  const prevToT = addDays(fromT, -1)
  const prevFromT = addDays(fromT, -spanDays)

  const trunc = granularity === 'day' ? 'day' : `date_trunc('${granularity}', day)::date`
  const seriesRows = (await pool.query(
    `SELECT ${trunc}::text AS period, ${metricSelect} FROM daily_stats
     WHERE user_id = $1 AND day >= $2::date AND day <= $3::date GROUP BY 1`, [userId, from, to])).rows
  const byPeriod = new Map<string, StatsMetrics>()
  for (const r of seriesRows) {
    const m = zeroMetrics()
    for (const [k] of METRICS) m[k] = num(r[k])
    byPeriod.set(r.period, m)
  }
  const series = periods.map(t => ({ period: fmtDay(t), ...(byPeriod.get(fmtDay(t)) ?? zeroMetrics()) }))
  const totals = zeroMetrics()
  for (const s of series) for (const [k] of METRICS) totals[k] += s[k]

  const prevRow = (await pool.query(
    `SELECT ${metricSelect} FROM daily_stats WHERE user_id = $1 AND day >= $2::date AND day <= $3::date`,
    [userId, fmtDay(prevFromT), fmtDay(prevToT)])).rows[0]
  const prevTotals = zeroMetrics()
  for (const [k] of METRICS) prevTotals[k] = num(prevRow?.[k])

  let rows: ({ key: string } & StatsMetrics)[] = []
  if (by === 'model') {
    const r = await pool.query(
      `SELECT model AS key, sum(runs)::float8 AS runs, sum(tokens_in)::float8 AS "tokensIn", sum(tokens_out)::float8 AS "tokensOut",
         sum(cost_usd)::float8 AS "costUsd", sum(credits)::float8 AS credits
       FROM daily_model_stats WHERE user_id = $1 AND day >= $2::date AND day <= $3::date
       GROUP BY model ORDER BY sum(runs) DESC, model LIMIT 20`, [userId, from, to])
    rows = r.rows.map(x => {
      const m = zeroMetrics()
      for (const k of MODEL_METRICS) m[k] = num(x[k])
      return { key: x.key as string, ...m }
    })
  } else if (by !== 'none') {
    const r = await pool.query(
      `SELECT ${by} AS key, ${metricSelect} FROM daily_stats WHERE user_id = $1 AND day >= $2::date AND day <= $3::date
       GROUP BY ${by} ORDER BY sum(runs) + sum(sessions_new) + sum(tasks_created) DESC, ${by} LIMIT 20`, [userId, from, to])
    rows = r.rows.map(x => {
      const m = zeroMetrics()
      for (const [k] of METRICS) m[k] = num(x[k])
      return { key: x.key as string, ...m }
    })
  }

  const snapshot = { todo: 0, doing: 0, review: 0, done: 0 }
  const snap = await pool.query<{ status: keyof typeof snapshot; n: number }>(
    'SELECT status, count(*)::int AS n FROM tasks WHERE user_id = $1 GROUP BY status', [userId])
  for (const r of snap.rows) if (r.status in snapshot) snapshot[r.status] = r.n

  return {
    granularity, from, to, tz, series, totals,
    previous: { from: fmtDay(prevFromT), to: fmtDay(prevToT), totals: prevTotals },
    breakdown: { by, rows },
    snapshot,
  }
}
