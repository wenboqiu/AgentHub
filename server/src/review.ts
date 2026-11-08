import type pg from 'pg'
import { listMessages } from './db.ts'
import { TaskError, getTask, type ChecklistItem, type Task } from './tasks.ts'
import { addMemory } from './memories.ts'
import { randomUUID } from 'node:crypto'

// 验收检查项与证据链（思路来自 LobeHub 的 Acceptance：把需求拆成看得见的检查项，
// 逐项跑并附证据，人整体通过或部分打回，打回原因沉淀成下次交付前的标准）。
// AgentHub 不跑被测产品，所以证据只能从已有材料里取：会话记录自动摘取 + 人工补充。

type DB = Pick<pg.Pool, 'query'>

export type EvidenceKind = 'file' | 'command' | 'test' | 'shot' | 'log'
export type Evidence = { kind: EvidenceKind; label: string; value: string; at: string | null }
export type ItemStatus = 'pending' | 'pass' | 'fail'
export type ReviewItem = { id: number; key: string; title: string; status: ItemStatus; note: string; manual: boolean; updatedAt: string }
export type Review = { items: ReviewItem[]; evidence: Evidence[]; standards: string[] }

const LABEL: Record<EvidenceKind, string> = { file: '文件变更', command: '执行命令', test: '测试结果', shot: '截图', log: '错误日志' }
const CAP: Record<EvidenceKind, number> = { file: 15, command: 10, test: 6, shot: 6, log: 5 }

export async function migrateReview(db: DB) {
  await db.query(`CREATE TABLE IF NOT EXISTS review_items (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id bigint NOT NULL,
    item_key text NOT NULL,
    title text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','pass','fail')),
    note text NOT NULL DEFAULT '',
    manual boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(user_id, task_id, item_key),
    FOREIGN KEY(user_id, task_id) REFERENCES tasks(user_id, id) ON DELETE CASCADE)`)
  // 打回标准：同一条原因重复出现时只累加命中次数，作为「下次交付前先自查」的清单
  await db.query(`CREATE TABLE IF NOT EXISTS review_standards (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text text NOT NULL,
    hits integer NOT NULL DEFAULT 1,
    task_id bigint,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(user_id, text))`)
  await db.query('CREATE INDEX IF NOT EXISTS idx_review_items_task ON review_items(user_id,task_id)')
}

const FILE_RE = /((?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,8})|(\b[\w@-]+\.(?:ts|tsx|js|jsx|py|go|rs|json|md|css|html|yml|yaml|toml|sh|kt|java|sql|png|jpg|jpeg|webp|gif|svg)\b)/g
const SHOT_RE = /\.(?:png|jpe?g|webp|gif|svg)$/i
const SKIP_RE = /(?:^|\/)(?:node_modules|dist|build|out|target|coverage|\.git|\.next)\//
const CMD_RE = /^(?:\$|>|#)\s+(\S.{0,180})$/
const BIN_RE = /^(?:npm|pnpm|yarn|npx|node|bun|deno|python3?|pip|pytest|go|cargo|rustc|git|docker|kubectl|make|cmake|tsc|vite|jest|vitest|mvn|gradle|rg|curl)\b[^\n]{0,180}$/
const TEST_RE = /\b\d+\s+(?:passed|failed|passing|failing|skipped)\b|\b(?:Tests|Test Suites):\s*\d|\b(?:ok|FAIL)\s+[\w./@-]+\s+\d+(?:\.\d+)?s\b|(?:✓|✗|✔|✘)/
const ERROR_RE = /^(?:Error|ERROR|Traceback|Exception|panic:|TypeError|ReferenceError|SyntaxError)\b|^\s+at\s+\S+\s+\(/

// 从会话记录里摘取可复核的证据：文件、命令、测试结果、截图、错误日志。
// 纯函数、只读文本，不解析任何结构化数据，所以宁可少抓也不乱抓。
export function harvestEvidence(msgs: { role: string; text: string; createdAt: string }[]): Evidence[] {
  const out: Evidence[] = []
  const seen = new Set<string>()
  const add = (kind: EvidenceKind, value: string, at: string | null) => {
    const v = value.trim().slice(0, 300)
    if (!v) return
    const key = `${kind}\u0000${v.toLowerCase()}`
    if (seen.has(key) || out.filter(e => e.kind === kind).length >= CAP[kind]) return
    seen.add(key)
    out.push({ kind, label: LABEL[kind], value: v, at })
  }
  for (const m of msgs.slice(-120)) {
    for (const raw of m.text.split('\n').slice(0, 200)) {
      const line = raw.trim()
      if (!line) continue
      const cmd = CMD_RE.exec(line)
      if (cmd) add('command', cmd[1], m.createdAt)
      else if (BIN_RE.test(line)) add('command', line, m.createdAt)
      if (TEST_RE.test(line)) add('test', line, m.createdAt)
      if (m.role !== 'user' && ERROR_RE.test(line)) add('log', line, m.createdAt)
      for (const match of line.matchAll(FILE_RE)) {
        const path = match[1] ?? match[2]
        if (!path || SKIP_RE.test(path) || path.startsWith('/') || path.startsWith('~')) continue
        add(SHOT_RE.test(path) ? 'shot' : 'file', path, m.createdAt)
      }
    }
  }
  return out
}

const item = (r: any): ReviewItem => ({
  id: Number(r.id), key: r.item_key, title: r.title, status: r.status, note: r.note,
  manual: r.manual, updatedAt: r.updated_at.toISOString(),
})

// 用任务清单同步检查项：清单项是唯一来源，改名跟着改；人工加的项和自己做过的判断都保留
export async function syncReviewItems(db: DB, userId: number, taskId: number, checklist: ChecklistItem[]) {
  if (!checklist.length) return
  await db.query(
    'DELETE FROM review_items WHERE user_id=$1 AND task_id=$2 AND manual=false AND item_key <> ALL($3)',
    [userId, taskId, checklist.map(i => i.id)],
  )
  for (const c of checklist) {
    await db.query(
      `INSERT INTO review_items(user_id,task_id,item_key,title,status) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (user_id,task_id,item_key) DO UPDATE SET title=$4,
         updated_at=CASE WHEN review_items.title <> $4 THEN now() ELSE review_items.updated_at END`,
      [userId, taskId, c.id, c.text, c.done ? 'pass' : 'pending'],
    )
  }
}

export async function listReviewItems(db: DB, userId: number, taskId: number): Promise<ReviewItem[]> {
  return (await db.query('SELECT * FROM review_items WHERE user_id=$1 AND task_id=$2 ORDER BY manual, id', [userId, taskId])).rows.map(item)
}

export async function addReviewItem(db: DB, userId: number, taskId: number, title: string): Promise<ReviewItem> {
  await getTask(db, userId, taskId)
  const r = await db.query(
    'INSERT INTO review_items(user_id,task_id,item_key,title,manual) VALUES($1,$2,$3,$4,true) RETURNING *',
    [userId, taskId, `m-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, title],
  )
  return item(r.rows[0])
}

// 判定检查项：打回时带原因，原因同时沉淀为账号级标准（重复出现只累加次数）
// 任务指定了角色时，这条原因还会记进「该员工在这个项目上的经验」，下次派活自动带上
export async function decideReviewItem(db: DB, userId: number, taskId: number, itemId: number, status: ItemStatus, note: string): Promise<ReviewItem> {
  const r = await db.query(
    'UPDATE review_items SET status=$4, note=$5, updated_at=now() WHERE user_id=$1 AND task_id=$2 AND id=$3 RETURNING *',
    [userId, taskId, itemId, status, note.slice(0, 500)],
  )
  if (!r.rows[0]) throw new TaskError('检查项不存在', 404)
  if (status === 'fail' && note.trim()) {
    await addStandard(db, userId, taskId, note.trim())
    const t = await db.query<{ role_id: number | null; project_id: number | null }>(
      'SELECT role_id, project_id FROM tasks WHERE user_id=$1 AND id=$2',
      [userId, taskId],
    )
    const roleId = t.rows[0]?.role_id, projectId = t.rows[0]?.project_id
    // 记忆入库失败不能挡住验收本身：经验是加分项，打回才是用户要的结果
    if (roleId) {
      try {
        await addMemory(db, userId, Number(roleId), projectId === null || projectId === undefined ? null : Number(projectId), note.trim(), 'review')
      } catch { /* 记忆条数到上限等情况忽略 */ }
    }
  }
  // 签署过 Mandate 的任务：打回不是在原任务里重跑，而是出一张新的任务单提案，人确认后重新授权
  if (status === 'fail') {
    try { await proposeRetry(db, userId, taskId, note.trim()) } catch { /* 提案是附加产物，失败不挡住打回本身 */ }
  }
  return item(r.rows[0])
}

/**
 * 打回 → 新 Ticket：原任务保持 review 不动，生成一条带打回原因与原 Mandate 摘要的待确认提案。
 * 没有 Mandate 的老任务 / 纯人工任务保持原行为（只沉淀经验），返回 null。
 */
export async function proposeRetry(db: DB, userId: number, taskId: number, reason: string): Promise<number | null> {
  const m = (await db.query(
    `SELECT m.version, m.scope FROM tasks t JOIN task_mandates m ON m.user_id=t.user_id AND m.id=t.mandate_id
      WHERE t.user_id=$1 AND t.id=$2`, [userId, taskId])).rows[0]
  if (!m) return null
  const t = (await db.query(
    'SELECT title, priority, role_id, project_id, machine, cwd, constraints FROM tasks WHERE user_id=$1 AND id=$2', [userId, taskId])).rows[0]
  if (!t) return null
  const s = (await db.query(
    `SELECT s.id, s.title, s.agent, s.project FROM task_sessions ts JOIN sessions s ON s.user_id=ts.user_id AND s.id=ts.session_id
      WHERE ts.user_id=$1 AND ts.task_id=$2 ORDER BY ts.created_at, ts.session_id LIMIT 1`, [userId, taskId])).rows[0]
  const scope = m.scope as { paths?: string[]; net?: boolean; push?: boolean; scripts?: boolean } | null
  const summary = `原授权范围（v${m.version}）：${scope?.paths?.length ? `只能改 ${scope.paths.join('、')}` : '整个工作目录'}；`
    + `${scope?.net ? '可联网' : '不联网'}、${scope?.push ? '可推远端' : '不推远端'}、${scope?.scripts ? '可跑脚本' : '不跑脚本'}`
  const why = reason || '验收未通过'
  const kind = s ? 'fix' : 'ticket'
  const r = await db.query(
    `INSERT INTO session_proposals(
       user_id,session_id,session_title,session_agent,session_project,task_id,event_at,
       kind,title,notes,checklist,constraints,delivery,priority,role_id,project_id,note,origin,machine,cwd)
     VALUES($1,$2,$3,$4,$5,$6,now(),$7,$8,$9,'[]'::jsonb,$10,'fresh',$11,$12,$13,$14,'heuristic',$15,$16) RETURNING id`,
    [userId, s?.id ?? `ticket:${randomUUID()}`, (s?.title ?? '').slice(0, 200), s?.agent ?? '', (s?.project ?? '').slice(0, 200), taskId, kind,
      `打回重做：${String(t.title).slice(0, 180)}`.slice(0, 200), [`验收打回原因：${why}`, summary, '（范围已冻结：确认这张新任务单会签署新的授权范围。）'].join('\n').slice(0, 4000),
      JSON.stringify(t.constraints ?? {}), t.priority, t.role_id, t.project_id, why.slice(0, 500), t.machine, t.cwd],
  )
  const id = Number(r.rows[0].id)
  // 同一任务多次打回只留最新一张待确认的
  await db.query("UPDATE session_proposals SET status='discarded', updated_at=now() WHERE user_id=$1 AND task_id=$2 AND status='pending' AND id<>$3", [userId, taskId, id])
  return id
}

export async function addStandard(db: DB, userId: number, taskId: number, text: string) {
  await db.query(
    `INSERT INTO review_standards(user_id,text,task_id) VALUES($1,$2,$3)
     ON CONFLICT (user_id,text) DO UPDATE SET hits=review_standards.hits+1, last_at=now(), task_id=$3`,
    [userId, text.slice(0, 500), taskId],
  )
}

export async function listStandards(db: DB, userId: number, limit = 5): Promise<string[]> {
  return (await db.query(
    'SELECT text FROM review_standards WHERE user_id=$1 ORDER BY last_at DESC, id DESC LIMIT $2',
    [userId, limit],
  )).rows.map((r: { text: string }) => r.text)
}

// 证据优先用预摘要里缓存的（进待验收时已抓好），没有就现抓一次，不阻塞验收
async function reviewEvidence(pool: pg.Pool, userId: number, taskId: number, task: Task): Promise<Evidence[]> {
  const cached = await pool.query<{ digest: { evidence?: Evidence[] } }>(
    "SELECT digest FROM task_digests WHERE user_id=$1 AND task_id=$2 AND kind='review'",
    [userId, taskId],
  )
  const hit = cached.rows[0]?.digest?.evidence
  if (hit) return hit
  const session = (await pool.query<{ session_id: string }>(
    'SELECT session_id FROM task_sessions WHERE user_id=$1 AND task_id=$2 ORDER BY created_at, session_id LIMIT 1',
    [userId, taskId],
  )).rows[0]?.session_id
  if (!session) return []
  const msgs = await listMessages(pool, userId, session, 200)
  return harvestEvidence(msgs.map(m => ({ role: m.role, text: m.text, createdAt: m.createdAt })))
}

export async function getReview(pool: pg.Pool, userId: number, taskId: number): Promise<Review> {
  const task = await getTask(pool, userId, taskId)
  await syncReviewItems(pool, userId, taskId, task.checklist)
  return {
    items: await listReviewItems(pool, userId, taskId),
    evidence: await reviewEvidence(pool, userId, taskId, task),
    standards: await listStandards(pool, userId),
  }
}
