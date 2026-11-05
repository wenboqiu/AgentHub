import type pg from 'pg'
import { listMessages } from './db.ts'
import { TaskError, getTask } from './tasks.ts'
import type { Evidence } from './review.ts'
import { getDigests } from './digest.ts'

// 任务产物：每个任务跑完后留一份「为什么这么改」的文档。
// 和验收摘要的分工——摘要给验收时看（最后回复 + 证据），产物给三个月后看
// （做了什么、怎么验证、影响面、后续、风险），可编辑、可导出成 Markdown。
//
// 默认由服务端按已有材料生成骨架（不花模型调用），保证「每个任务都有产物」；
// 之后执行端如果能按契约自己交一份，覆盖同一行即可（source='agent'）。

type DB = Pick<pg.Pool, 'query'>

export type ArtifactSource = 'digest' | 'agent' | 'user'
export type TaskArtifact = {
  taskId: number
  /** Markdown 全文 */
  md: string
  source: ArtifactSource
  /** 人改过之后，重新生成不再覆盖 */
  edited: boolean
  createdAt: string
  updatedAt: string
}

const MAX_MD = 40000
/** 收尾结论文本最多取这么多字：够说清做了什么，又不至于把整段对话贴进来 */
const MAX_REPLY = 3000

export async function migrateArtifacts(db: DB) {
  await db.query(`CREATE TABLE IF NOT EXISTS task_artifacts (
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id bigint NOT NULL,
    kind text NOT NULL DEFAULT 'doc' CHECK (kind IN ('doc')),
    md text NOT NULL,
    source text NOT NULL DEFAULT 'digest' CHECK (source IN ('digest','agent','user')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, task_id, kind),
    FOREIGN KEY (user_id, task_id) REFERENCES tasks(user_id, id) ON DELETE CASCADE)`)
  await db.query('CREATE INDEX IF NOT EXISTS idx_task_artifacts_updated ON task_artifacts(user_id, updated_at DESC)')
}

const row = (r: any): TaskArtifact => ({
  taskId: Number(r.task_id),
  md: r.md ?? '',
  source: r.source as ArtifactSource,
  // 只有人改过的才不会在任务重进待验收时被覆盖
  edited: r.source === 'user',
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
})

export async function getArtifact(db: DB, userId: number, taskId: number): Promise<TaskArtifact | null> {
  const r = await db.query('SELECT * FROM task_artifacts WHERE user_id=$1 AND task_id=$2 AND kind=\'doc\'', [userId, taskId])
  return r.rows[0] ? row(r.rows[0]) : null
}

// ---------- 骨架 ----------

export type ArtifactInput = {
  title: string
  status: string
  project: string
  agent: string | null
  machine: string | null
  cwd: string | null
  sessionTitle: string
  doneAt: string | null
  /** 执行端收尾的那段话 */
  lastReply: string
  evidence: Evidence[]
  checklist: { text: string; done: boolean }[]
  runs: { status: string; error: string }[]
}

const EVIDENCE_LABEL: Record<string, string> = { test: '测试', command: '命令', file: '文件', shot: '截图', log: '日志' }
const RUN_LABEL: Record<string, string> = { queued: '排队中', running: '运行中', done: '完成', failed: '失败', stopped: '已停止' }

/**
 * 把一份任务的材料排成 Markdown。纯函数，方便单测：
 * 选「做了什么 / 怎么验证 / 影响面 / 验收要点 / 后续 / 风险」六段，
 * 是因为前四段回答「这次交付了什么」，后两段回答「下次从哪接着干」。
 */
export function renderArtifact(a: ArtifactInput): string {
  const out: string[] = []
  out.push(`# ${a.title || '未命名任务'}`)
  out.push([
    `- 状态：${a.status}`,
    a.project ? `- 项目：${a.project}` : '',
    a.agent ? `- 执行：${a.agent}${a.machine ? ` @ ${a.machine}` : ''}` : '',
    a.cwd ? `- 目录：\`${a.cwd}\`` : '',
    a.doneAt ? `- 完成时间：${a.doneAt}` : '',
    a.sessionTitle ? `- 来源会话：${a.sessionTitle}` : '',
  ].filter(Boolean).join('\n'))

  out.push('## 做了什么')
  out.push(a.lastReply.trim() || '_执行端没有留下收尾说明，需要人补一句这次改了什么。_')

  out.push('## 怎么验证')
  if (a.evidence.length) {
    const lines = a.evidence.map(e => `- ${EVIDENCE_LABEL[e.kind] ?? e.kind}：\`${e.value.slice(0, 300)}\``)
    out.push(lines.join('\n'))
  } else {
    out.push('_没有从会话里摘到命令、测试或文件变更，验证方式待补。_')
  }

  const files = a.evidence.filter(e => e.kind === 'file')
  out.push('## 影响面')
  out.push(files.length
    ? files.map(f => `- \`${f.value.slice(0, 300)}\``).join('\n')
    : '_没有识别到改动的文件。_')

  out.push('## 验收要点')
  out.push(a.checklist.length
    ? a.checklist.map(c => `- [${c.done ? 'x' : ' '}] ${c.text}`).join('\n')
    : '_这个任务没有设检查项。_')

  const rest = a.checklist.filter(c => !c.done)
  const failed = a.runs.filter(r => r.status === 'failed' || r.status === 'stopped')
  out.push('## 后续')
  out.push(rest.length
    ? rest.map(c => `- 未完成：${c.text}`).join('\n')
    : '- 无未完成的检查项。')

  out.push('## 风险与未决')
  const risks: string[] = []
  if (failed.length) {
    for (const r of failed.slice(0, 3)) {
      risks.push(`- 有 ${RUN_LABEL[r.status] ?? r.status} 的执行${r.error ? `：${r.error.slice(0, 200)}` : ''}`)
    }
  }
  if (rest.length) risks.push(`- 还有 ${rest.length} 条验收要点没勾上，交付不完整`)
  if (!a.evidence.some(e => e.kind === 'test')) risks.push('- 没有测试证据，回归风险未知')
  out.push(risks.length ? risks.join('\n') : '- 未见明显风险。')

  return out.join('\n\n')
}

/** 从一段收尾回复里挑出「一句结论」喂给项目简报：太长就截断，空就退回任务标题 */
export function summarize(text: string, fallback: string, max = 160): string {
  const flat = text.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim()
  if (!flat) return fallback.slice(0, max)
  // 按句末标点切，攒到一句有信息量的话为止：「好。」单独进简报等于没说
  const parts = flat.match(/[^。！？.!?]+[。！？.!?]?/g) ?? [flat]
  let line = ''
  for (const part of parts) {
    line += part
    if (line.length >= 12 || line.length >= max) break
  }
  line = (line.trim() || flat)
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const slug = (s: string) => s
  .toLowerCase()
  .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 60) || 'task'

/** 导出时建议的文件名：docs/tasks/<id>-<slug>.md */
export function artifactPath(taskId: number, title: string): string {
  return `docs/tasks/${taskId}-${slug(title)}.md`
}

// ---------- 生成与写入 ----------

/**
 * 按当前材料重建产物骨架。
 * 人改过的（source='user'）不覆盖，除非 force；任务还没跑过任何执行也没有会话时不生成。
 */
export async function buildArtifact(pool: pg.Pool, userId: number, taskId: number, opts: { force?: boolean } = {}): Promise<TaskArtifact | null> {
  const task = await getTask(pool, userId, taskId).catch(() => null)
  if (!task) return null
  const existing = await getArtifact(pool, userId, taskId)
  if (existing && existing.source === 'user' && !opts.force) return existing

  const digests = await getDigests(pool, userId, taskId)
  const review = digests.review
  // 摘要里的最后回复只留了 500 字；产物要能说清来龙去脉，重新取一次全文
  let lastReply = review?.lastReply ?? ''
  if (review?.sessionId) {
    const msgs = await listMessages(pool, userId, review.sessionId, 200).catch(() => [])
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant') { lastReply = msgs[i].text.slice(0, MAX_REPLY); break }
    }
  }
  // 有会话或者已经推进到待验收/完成，才有材料可整理；纯 todo 任务不硬造空文档
  if (!review && !lastReply && !task.sessionIds.length && task.status !== 'done' && task.status !== 'review') return existing

  const project = task.projectId === null
    ? ''
    : (await pool.query('SELECT name FROM projects WHERE user_id=$1 AND id=$2', [userId, task.projectId])).rows[0]?.name ?? ''

  const md = renderArtifact({
    title: task.title,
    status: task.status === 'done' ? '已完成' : task.status === 'review' ? '待验收' : task.status === 'doing' ? '进行中' : '待办',
    project,
    agent: task.agent,
    machine: task.machine,
    cwd: task.cwd,
    sessionTitle: review?.sessionTitle ?? '',
    doneAt: task.doneAt ? new Date(task.doneAt).toLocaleString('zh-CN', { hour12: false }) : null,
    lastReply,
    evidence: review?.evidence ?? [],
    checklist: task.checklist.map(c => ({ text: c.text, done: c.done })),
    runs: review?.runs ?? [],
  })

  const r = await pool.query(
    `INSERT INTO task_artifacts(user_id, task_id, md, source) VALUES($1,$2,$3,'digest')
     ON CONFLICT (user_id, task_id, kind) DO UPDATE SET md=$3, updated_at=now()
       WHERE task_artifacts.source <> 'user'
     RETURNING *`,
    [userId, taskId, md.slice(0, MAX_MD)],
  )
  // 撞上人改过的版本（WHERE 不成立）时返回已有那份，调用方不必区分
  return r.rows[0] ? row(r.rows[0]) : existing
}

/** 人改产物：改了就是 'user'，之后自动重建不再覆盖 */
export async function saveArtifact(db: DB, userId: number, taskId: number, md: string): Promise<TaskArtifact> {
  const body = md.replaceAll('\0', '').trim()
  if (!body) throw new TaskError('产物内容不能为空')
  if (body.length > MAX_MD) throw new TaskError(`产物最多 ${MAX_MD} 字`)
  const r = await db.query(
    `INSERT INTO task_artifacts(user_id, task_id, md, source) VALUES($1,$2,$3,'user')
     ON CONFLICT (user_id, task_id, kind) DO UPDATE SET md=$3, source='user', updated_at=now()
     RETURNING *`,
    [userId, taskId, body],
  )
  return row(r.rows[0])
}

export async function deleteArtifact(db: DB, userId: number, taskId: number): Promise<void> {
  await db.query('DELETE FROM task_artifacts WHERE user_id=$1 AND task_id=$2 AND kind=\'doc\'', [userId, taskId])
}
