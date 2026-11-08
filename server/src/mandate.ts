import type pg from 'pg'
import { TaskError, getTask, saveTask, type Task } from './tasks.ts'
import { RULESET_VERSION, judgeApproval, normalizeScope, type MandateScope, type Verdict } from './referee.ts'
import { listReviewItems, syncReviewItems } from './review.ts'

// Mandate：确认任务单 = 签署一份不可变的授权范围。
// - task_mandates 是 append-only 快照，永远不 UPDATE / DELETE（审计要求）；
// - 审批按「是否落在冻结范围内」判定，范围外 / danger / unknown 一律交人，不产出 deny；
// - 每账号 mandate_mode：off（默认，行为与旧版一致）/ observe（只留痕）/ auto（范围内自动放行 + 执行器关 CLI 逐动作审批）；
// - 任务只能经 accept 从 review 到 done。
// 目录声明只是提示，不是安全隔离；真正的约束来自 CLI 白名单与 sandbox。

type DB = Pick<pg.Pool, 'query'>

export type MandateMode = 'off' | 'observe' | 'auto'
export const MANDATE_MODES: readonly MandateMode[] = ['off', 'observe', 'auto']

export type Mandate = {
  id: number
  taskId: number
  version: number
  scope: MandateScope
  rulesetVersion: string
  authorizedBy: string
  reason: string
  createdAt: string
}

export async function migrateMandate(db: DB) {
  await db.query(`CREATE TABLE IF NOT EXISTS task_mandates (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id bigint NOT NULL,
    version integer NOT NULL,
    scope jsonb NOT NULL,
    ruleset_version text NOT NULL,
    authorized_by text NOT NULL,
    reason text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(user_id, task_id, version),
    FOREIGN KEY(user_id, task_id) REFERENCES tasks(user_id, id) ON DELETE CASCADE)`)
  await db.query(`CREATE TABLE IF NOT EXISTS mandate_decisions (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id bigint NOT NULL,
    mandate_id bigint,
    approval_id text,
    would_allow boolean NOT NULL,
    in_scope boolean NOT NULL,
    rule text NOT NULL DEFAULT '',
    tier text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now())`)
  // 记录是哪一档留的痕：auto 的限额只数 auto 档真放行的那些
  await db.query(`ALTER TABLE mandate_decisions ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'observe'`)
  await db.query('CREATE INDEX IF NOT EXISTS idx_mandate_decisions_task ON mandate_decisions(user_id, task_id, created_at DESC)')
  await db.query(`CREATE TABLE IF NOT EXISTS task_deliveries (
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id bigint NOT NULL,
    mandate_id bigint NOT NULL,
    digest jsonb NOT NULL,
    sessions jsonb NOT NULL DEFAULT '[]',
    runs jsonb NOT NULL DEFAULT '[]',
    evidence jsonb NOT NULL DEFAULT '[]',
    accepted_at timestamptz,
    accepted_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(user_id, task_id, mandate_id),
    FOREIGN KEY(user_id, task_id) REFERENCES tasks(user_id, id) ON DELETE CASCADE)`)
  await db.query(`CREATE TABLE IF NOT EXISTS mandate_settings (
    user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    mode text NOT NULL DEFAULT 'off' CHECK (mode IN ('off','observe','auto')),
    updated_at timestamptz NOT NULL DEFAULT now())`)
  await db.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS mandate_id bigint')
  await db.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS mandate_frozen_at timestamptz')
  await db.query('ALTER TABLE approvals ADD COLUMN IF NOT EXISTS mandate_id bigint')
  await db.query('ALTER TABLE approvals ADD COLUMN IF NOT EXISTS in_scope boolean')
}

/** observe 留痕只保留 30 天，和 session_activity 同一口径 */
export async function pruneMandateDecisions(db: DB) {
  await db.query("DELETE FROM mandate_decisions WHERE created_at < now() - interval '30 days'")
}

const mandate = (r: any): Mandate => ({
  id: Number(r.id), taskId: Number(r.task_id), version: Number(r.version), scope: normalizeScope(r.scope),
  rulesetVersion: r.ruleset_version, authorizedBy: r.authorized_by, reason: r.reason, createdAt: new Date(r.created_at).toISOString(),
})

/** 任务当前生效的 Mandate（冻结在任务上的那份）；没签署过返回 null */
export async function getMandate(db: DB, user: number, taskId: number): Promise<Mandate | null> {
  const r = await db.query(
    `SELECT m.* FROM tasks t JOIN task_mandates m ON m.user_id=t.user_id AND m.id=t.mandate_id
      WHERE t.user_id=$1 AND t.id=$2`,
    [user, taskId],
  )
  return r.rows[0] ? mandate(r.rows[0]) : null
}

/**
 * 签署：校验范围 → 写不可变快照（同一任务 version 递增，新任务从 1 开始）→ 置 tasks.mandate_id / mandate_frozen_at。
 * 同一任务重复签署直接返回已有快照，不重复建，也不会改动已冻结的范围。
 */
export async function signMandate(db: DB, user: number, taskId: number, scope: unknown, by = 'user', reason = ''): Promise<Mandate> {
  await getTask(db, user, taskId)
  const existing = await getMandate(db, user, taskId)
  if (existing) return existing
  const clean = normalizeScope(scope)
  const note = reason.trim() || clean.note
  const r = await db.query(
    `INSERT INTO task_mandates(user_id,task_id,version,scope,ruleset_version,authorized_by,reason)
     VALUES($1,$2,(SELECT COALESCE(MAX(version),0)+1 FROM task_mandates WHERE user_id=$1 AND task_id=$2),$3,$4,$5,$6) RETURNING *`,
    [user, taskId, JSON.stringify(clean), RULESET_VERSION, by, note.slice(0, 500)],
  )
  await db.query('UPDATE tasks SET mandate_id=$3, mandate_frozen_at=now() WHERE user_id=$1 AND id=$2', [user, taskId, r.rows[0].id])
  return mandate(r.rows[0])
}

export async function getMandateMode(db: DB, user: number): Promise<MandateMode> {
  const r = await db.query('SELECT mode FROM mandate_settings WHERE user_id=$1', [user])
  const mode = r.rows[0]?.mode
  return mode === 'observe' || mode === 'auto' ? mode : 'off'
}

export async function setMandateMode(db: DB, user: number, mode: unknown): Promise<MandateMode> {
  if (typeof mode !== 'string' || !(MANDATE_MODES as readonly string[]).includes(mode)) throw new TaskError('授权模式不合法（off / observe / auto）')
  await db.query(
    `INSERT INTO mandate_settings(user_id,mode) VALUES($1,$2)
     ON CONFLICT (user_id) DO UPDATE SET mode=$2, updated_at=now()`,
    [user, mode],
  )
  return mode as MandateMode
}

/**
 * 按冻结范围判一条审批：in_scope = 规则放行。policy 由范围派生，不读全局代批开关；
 * commands 非空时只放行声明过的命令类（更保守），空 = 沿用 referee 规则表。
 */
export function judgeByMandate(scope: MandateScope, input: { tool: string; detail: string; cwd: string }): Verdict {
  const has = (c: string) => scope.commands.length === 0 || scope.commands.includes(c)
  return judgeApproval({
    ...input,
    grants: scope,
    policy: {
      enabled: true,
      allowRead: has('read'),
      allowWrite: has('write'),
      allowTests: has('test') || has('build'),
      allowNetwork: scope.net,
      maxPerHour: Number.MAX_SAFE_INTEGER,
    },
  })
}

export async function recordDecision(db: DB, user: number, d: {
  taskId: number; mandateId: number | null; approvalId: string | null; wouldAllow: boolean; inScope: boolean; rule: string; tier: string; mode: MandateMode
}): Promise<void> {
  await db.query(
    `INSERT INTO mandate_decisions(user_id,task_id,mandate_id,approval_id,would_allow,in_scope,rule,tier,mode)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [user, d.taskId, d.mandateId, d.approvalId, d.wouldAllow, d.inScope, d.rule, d.tier, d.mode],
  )
}

/** 给审批行打上它属于哪份 Mandate、是否落在范围内（只在 auto 档用，不改审批状态） */
export async function tagApproval(db: DB, user: number, approvalId: string, mandateId: number, inScope: boolean): Promise<void> {
  await db.query('UPDATE approvals SET mandate_id=$3, in_scope=$4 WHERE user_id=$1 AND id=$2', [user, approvalId, mandateId, inScope])
}

/** auto 档最近一小时真放行了几次（超过代批限额就全交给人，防跑飞） */
export async function recentAutoAllowCount(db: DB, user: number): Promise<number> {
  const r = await db.query(
    `SELECT count(*)::int n FROM mandate_decisions
      WHERE user_id=$1 AND mode='auto' AND would_allow AND rule<>'quota' AND created_at > now() - interval '1 hour'`,
    [user],
  )
  return Number(r.rows[0]?.n ?? 0)
}

export type DecisionStats = { total: number; wouldAllow: number; wouldAsk: number }

export async function decisionStats(db: DB, user: number, taskId: number): Promise<DecisionStats> {
  const r = await db.query(
    `SELECT count(*)::int total, count(*) FILTER (WHERE would_allow)::int allow
       FROM mandate_decisions WHERE user_id=$1 AND task_id=$2`,
    [user, taskId],
  )
  const total = Number(r.rows[0]?.total ?? 0), allow = Number(r.rows[0]?.allow ?? 0)
  return { total, wouldAllow: allow, wouldAsk: total - allow }
}

export type Delivery = {
  taskId: number; mandateId: number; digest: unknown; sessions: string[]; runs: { id: string; status: string }[]
  evidence: unknown[]; acceptedAt: string | null; acceptedBy: string | null; createdAt: string
}
const delivery = (r: any): Delivery => ({
  taskId: Number(r.task_id), mandateId: Number(r.mandate_id), digest: r.digest, sessions: r.sessions ?? [], runs: r.runs ?? [],
  evidence: r.evidence ?? [], acceptedAt: r.accepted_at ? new Date(r.accepted_at).toISOString() : null,
  acceptedBy: r.accepted_by ?? null, createdAt: new Date(r.created_at).toISOString(),
})

/**
 * 任务进入待验收时落交付物快照。重跑后再进 review：同一 (任务, mandate) 覆盖未验收的快照，
 * 已验收的不动。没有 mandate 的任务（老任务、纯人工）没有交付物。
 */
export async function createDelivery(db: DB, user: number, taskId: number, digest: unknown): Promise<Delivery | null> {
  const m = await getMandate(db, user, taskId)
  if (!m) return null
  const sessions = (await db.query('SELECT session_id FROM task_sessions WHERE user_id=$1 AND task_id=$2 ORDER BY created_at, session_id', [user, taskId]))
    .rows.map((r: { session_id: string }) => r.session_id)
  const runs = (await db.query('SELECT id, status FROM runs WHERE user_id=$1 AND task_id=$2 ORDER BY created_at, id', [user, taskId]))
    .rows.map((r: { id: string; status: string }) => ({ id: r.id, status: r.status }))
  const evidence = (digest as { evidence?: unknown[] } | null)?.evidence ?? []
  const r = await db.query(
    `INSERT INTO task_deliveries(user_id,task_id,mandate_id,digest,sessions,runs,evidence)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (user_id,task_id,mandate_id) DO UPDATE
       SET digest=$4, sessions=$5, runs=$6, evidence=$7, created_at=now()
       WHERE task_deliveries.accepted_at IS NULL
     RETURNING *`,
    [user, taskId, m.id, JSON.stringify(digest ?? {}), JSON.stringify(sessions), JSON.stringify(runs), JSON.stringify(evidence)],
  )
  if (r.rows[0]) return delivery(r.rows[0])
  return getDelivery(db, user, taskId)
}

export async function getDelivery(db: DB, user: number, taskId: number): Promise<Delivery | null> {
  const r = await db.query(
    `SELECT d.* FROM task_deliveries d JOIN tasks t ON t.user_id=d.user_id AND t.id=d.task_id AND t.mandate_id=d.mandate_id
      WHERE d.user_id=$1 AND d.task_id=$2`,
    [user, taskId],
  )
  return r.rows[0] ? delivery(r.rows[0]) : null
}

/** 任务关联会话下还没人处理的审批数（= 未解决的 attention） */
export async function pendingApprovalCount(db: DB, user: number, taskId: number): Promise<number> {
  const r = await db.query(
    `SELECT count(*)::int n FROM approvals a JOIN task_sessions ts ON ts.user_id=a.user_id AND ts.session_id=a.session_id
      WHERE a.user_id=$1 AND ts.task_id=$2 AND a.status='pending'`,
    [user, taskId],
  )
  return Number(r.rows[0]?.n ?? 0)
}

/**
 * 验收：review → done 的唯一入口。门禁：任务在 review、检查项全部 pass、没有 pending 审批。
 * 通过后写交付物的 accepted_at / accepted_by。
 */
export async function acceptTask(db: DB, user: number, taskId: number, by = 'user'): Promise<{ task: Task; delivery: Delivery | null }> {
  const current = await getTask(db, user, taskId)
  if (current.status !== 'review') throw new TaskError('任务不在待验收状态，不能验收', 409)
  await syncReviewItems(db, user, taskId, current.checklist)
  const open = (await listReviewItems(db, user, taskId)).filter(i => i.status !== 'pass')
  if (open.length) throw new TaskError(`还有 ${open.length} 个检查项没有通过，不能验收`, 409)
  const pending = await pendingApprovalCount(db, user, taskId)
  if (pending) throw new TaskError(`还有 ${pending} 条待处理的审批，不能验收`, 409)
  const task = await saveTask(db, user, { status: 'done' }, taskId, { viaAccept: true })
  const m = await getMandate(db, user, taskId)
  let delivered: Delivery | null = null
  if (m) {
    // 手工推进到 review、没经过会话事件时可能还没有交付物：补一份再盖章
    if (!(await getDelivery(db, user, taskId))) {
      const cached = (await db.query("SELECT digest FROM task_digests WHERE user_id=$1 AND task_id=$2 AND kind='review'", [user, taskId])).rows[0]?.digest ?? {}
      await createDelivery(db, user, taskId, cached)
    }
    await db.query(
      'UPDATE task_deliveries SET accepted_at=COALESCE(accepted_at,now()), accepted_by=COALESCE(accepted_by,$4) WHERE user_id=$1 AND task_id=$2 AND mandate_id=$3',
      [user, taskId, m.id, by],
    )
    delivered = await getDelivery(db, user, taskId)
  }
  return { task, delivery: delivered }
}
