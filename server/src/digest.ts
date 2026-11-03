import type pg from 'pg'
import { listMessages } from './db.ts'

// 投机预摘要（思路来自 DeepSeek Super-agent 的投机执行：结果不确定是否被采用时先在
// 后台准备，有价值再提交）。任务进入「待验收」时预生成验收摘要，失败运行时预收集
// 错误上下文；用户点开任务详情时立即可见，不用再开终端翻记录。
// 全程只读会话/运行数据 + 写自己的缓存表，不改变任何权限模型。

type DB = Pick<pg.Pool, 'query'>

export type RunBrief = { status: string; error: string; updatedAt: string }
export type ReviewDigest = {
  kind: 'review'
  builtAt: string
  sessionId: string | null
  sessionTitle: string
  agent: string | null
  project: string
  messages: number
  lastReply: string
  lastReplyAt: string | null
  runs: RunBrief[]
}
export type FailureDigest = {
  kind: 'failure'
  builtAt: string
  runId: string
  sessionId: string | null
  error: string
  tail: { role: string; text: string }[]
}
export type Digests = { review: ReviewDigest | null; failure: FailureDigest | null }

export async function migrateDigests(db: DB) {
  await db.query(`CREATE TABLE IF NOT EXISTS task_digests (
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('review','failure')),
    digest jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, task_id, kind))`)
}

// 进入待验收时生成验收摘要：主要会话的规模、最后一条助手回复节选、最近执行记录。
// 会话还没同步过历史（服务端没有消息）时退化为元信息，提示去会话详情加载全文。
export async function buildReviewDigest(pool: pg.Pool, userId: number, taskId: number): Promise<ReviewDigest | null> {
  const task = (await pool.query('SELECT id FROM tasks WHERE user_id=$1 AND id=$2 AND status=\'review\'', [userId, taskId])).rows[0]
  if (!task) return null
  const s = (
    await pool.query(
      `SELECT s.id, s.title, s.agent, s.project FROM task_sessions ts
       JOIN sessions s ON s.user_id = ts.user_id AND s.id = ts.session_id
       WHERE ts.user_id=$1 AND ts.task_id=$2 ORDER BY ts.created_at, ts.session_id LIMIT 1`,
      [userId, taskId],
    )
  ).rows[0]
  const runs = (
    await pool.query('SELECT status, error, updated_at FROM runs WHERE user_id=$1 AND task_id=$2 ORDER BY created_at DESC, id DESC LIMIT 3', [userId, taskId])
  ).rows.map((r: { status: string; error: string; updated_at: Date }) => ({ status: r.status, error: r.error, updatedAt: r.updated_at.toISOString() }))
  let lastReply = '', lastReplyAt: string | null = null, messages = 0
  if (s) {
    const msgs = await listMessages(pool, userId, s.id, 200)
    messages = msgs.length
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant') {
        lastReply = msgs[i].text.slice(0, 500)
        lastReplyAt = msgs[i].createdAt
        break
      }
    }
  }
  if (!s && !runs.length) return null
  const digest: ReviewDigest = {
    kind: 'review',
    builtAt: new Date().toISOString(),
    sessionId: s?.id ?? null,
    sessionTitle: s?.title ?? '',
    agent: s?.agent ?? null,
    project: s?.project ?? '',
    messages,
    lastReply,
    lastReplyAt,
    runs,
  }
  await upsert(pool, userId, taskId, 'review', digest)
  return digest
}

// 失败预诊断：run 失败时收集错误与失败前最后 5 条消息（工具调用/回复），附在任务上
export async function buildFailureDigest(pool: pg.Pool, userId: number, taskId: number, run: { id: string; sessionId: string | null; error: string }): Promise<FailureDigest | null> {
  if (!(await pool.query('SELECT id FROM tasks WHERE user_id=$1 AND id=$2', [userId, taskId])).rowCount) return null
  const tail = run.sessionId
    ? (await listMessages(pool, userId, run.sessionId, 5)).slice(-5).map(m => ({ role: m.role, text: m.text.slice(0, 300) }))
    : []
  const digest: FailureDigest = {
    kind: 'failure',
    builtAt: new Date().toISOString(),
    runId: run.id,
    sessionId: run.sessionId,
    error: (run.error || '').slice(0, 500),
    tail,
  }
  await upsert(pool, userId, taskId, 'failure', digest)
  return digest
}

async function upsert(pool: DB, userId: number, taskId: number, kind: 'review' | 'failure', digest: unknown) {
  await pool.query(
    `INSERT INTO task_digests(user_id, task_id, kind, digest) VALUES($1,$2,$3,$4)
     ON CONFLICT (user_id, task_id, kind) DO UPDATE SET digest=$4, created_at=now()`,
    [userId, taskId, kind, JSON.stringify(digest)],
  )
}

export async function getDigests(pool: pg.Pool, userId: number, taskId: number): Promise<Digests> {
  const r = await pool.query<{ kind: string; digest: unknown }>('SELECT kind, digest FROM task_digests WHERE user_id=$1 AND task_id=$2', [userId, taskId])
  const out: Digests = { review: null, failure: null }
  for (const row of r.rows) {
    if (row.kind === 'review') out.review = row.digest as ReviewDigest
    if (row.kind === 'failure') out.failure = row.digest as FailureDigest
  }
  return out
}
