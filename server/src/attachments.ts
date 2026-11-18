import type pg from 'pg'
// 校验与错误形状和任务共用一套，避免两处各写一遍
import { TaskError, getTask, object, text } from './tasks.ts'

type DB = Pick<pg.Pool, 'query'>

export type AttachmentKind = 'image' | 'file'
export type Attachment = {
  id: number
  taskId: number
  kind: AttachmentKind
  name: string
  mime: string
  size: number
  createdAt: string
  /** 图片才有：可以直接塞进 <img> 的 data URL；文件不带内容，点下载时再取 */
  url: string | null
}

/** 图片按 data URL 存库（和会话消息的附图同一套），单张字符上限与聊天附图对齐 */
const IMAGE_MAX_CHARS = 2_500_000
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
/**
 * 文件按 base64 存库：服务端是容器、没有持久盘，落库才能跟着账号一起备份和迁移。
 * 8MB 是「截图 / 日志 / 设计稿」够用、又不会把单条记录撑爆的折中。
 */
const FILE_MAX_BYTES = 8 * 1024 * 1024
/** 单个任务最多挂这么多附件：备注里是引用，附件本体另存，数量要有上限 */
export const MAX_ATTACHMENTS = 20
/** 上传接口要收 base64，body 上限按最大文件留出 JSON 包装的余量 */
export const ATTACHMENT_BODY_LIMIT = 16 * 1024 * 1024

const MIME = /^[\w.+-]+\/[\w.+-]+$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

export async function migrateAttachments(db: DB) {
  await db.query(`CREATE TABLE IF NOT EXISTS task_attachments (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id bigint NOT NULL,
    kind text NOT NULL CHECK (kind IN ('image','file')),
    name text NOT NULL,
    mime text NOT NULL,
    size integer NOT NULL,
    data text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY(user_id,task_id) REFERENCES tasks(user_id,id) ON DELETE CASCADE)`)
  await db.query('CREATE INDEX IF NOT EXISTS idx_task_attachments ON task_attachments(user_id,task_id,id)')
}

/** 列表里不带本体：图片的 data URL 由前端按需单独取，别让一次列表把几十 MB 塞进响应 */
const row = (r: any): Attachment => ({
  id: Number(r.id), taskId: Number(r.task_id), kind: r.kind, name: r.name, mime: r.mime,
  size: Number(r.size), createdAt: new Date(r.created_at).toISOString(),
  url: typeof r.data === 'string' && r.kind === 'image' ? r.data : null,
})

/**
 * 备注里的附件引用：![名称](attachment:12) 或 [名称](attachment:12)。
 * 只认完整引用——备注里写一句「attachment:99 这个语法」是讨论，不是引用，不该被校验拦下。
 * 带 /g：只能配 matchAll / replace 用，别拿来 .test()（lastIndex 会串）。
 */
const REF_RE = /!?\[([^\]]*)\]\(attachment:(\d+)\)/g

/** 取出去重后的引用 id */
export function refsIn(notes: string): number[] {
  return [...new Set([...notes.matchAll(REF_RE)].map(m => Number(m[2])))]
}

/** 删掉某个附件的引用，顺手收拾掉它留下的空行 */
export function stripRef(notes: string, attachmentId: number): string {
  const re = new RegExp(`!?\\[[^\\]]*\\]\\(attachment:${attachmentId}\\)`, 'g')
  return notes.replace(re, '').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').trimEnd()
}

/** 只留引用里的文字：拼提示给项目经理 / 执行端时用，不用查库也不会把 attachment:12 递过去 */
export function readableNotes(notes: string): string {
  return notes.replace(REF_RE, (_all, label: string) => label || '附件')
}

/**
 * 列表只要元信息：图片的 data URL 单独按 id 取（GET .../attachments/:id），
 * 一次打开任务不再把最坏 20 × 2.5MB 的 base64 全塞进一个响应里。
 */
export async function listAttachments(db: DB, user: number, taskId: number): Promise<Attachment[]> {
  const r = await db.query(`SELECT id,task_id,kind,name,mime,size,created_at
    FROM task_attachments WHERE user_id=$1 AND task_id=$2 ORDER BY id`, [user, taskId])
  return r.rows.map(row)
}

/** 备注里引用了不存在的附件就报错：不然渲染出来是坏图，人还查不出为什么 */
export async function assertRefs(db: DB, user: number, taskId: number, notes: string) {
  const ids = refsIn(notes)
  if (!ids.length) return
  const r = await db.query('SELECT id FROM task_attachments WHERE user_id=$1 AND task_id=$2 AND id=ANY($3::bigint[])', [user, taskId, ids])
  const found = new Set(r.rows.map(x => Number(x.id)))
  const missing = ids.filter(id => !found.has(id))
  if (missing.length) throw new TaskError(`备注里引用了不存在的附件（${missing.join('、')}），请删掉对应引用后重试`)
}

/** 校验并解出来的上传入参：大小按解码后的字节算，不信客户端报的 size */
export type PreparedAttachment = { kind: AttachmentKind; name: string; mime: string; size: number; data: string }

/**
 * 校验与解码是纯计算：16MB body 的 base64 解码放这儿，不进全局串行队列，
 * 免得一次上传把别的请求（含执行端事件上报）堵在后面。
 */
export function prepareAttachment(raw: unknown): PreparedAttachment {
  const b = object(raw)
  if (b.kind !== 'image' && b.kind !== 'file') throw new TaskError('附件类型不合法')
  const kind = b.kind as AttachmentKind
  const name = text(b.name, '文件名', 200)
  const mime = typeof b.mime === 'string' && MIME.test(b.mime) ? b.mime.slice(0, 120) : ''
  if (typeof b.data !== 'string' || !b.data) throw new TaskError('附件内容是空的')
  const data = b.data
  let size: number
  if (kind === 'image') {
    if (!mime || !IMAGE_TYPES.includes(mime)) throw new TaskError('图片格式不支持，只接受 png / jpeg / webp / gif')
    const prefix = `data:${mime};base64,`
    if (!data.startsWith(prefix)) throw new TaskError('图片内容与格式不匹配')
    if (data.length > IMAGE_MAX_CHARS) throw new TaskError('单张图片太大了，请压缩后再上传')
    // 图片和文件用同一套字符集校验：只认前缀的话，截断的 base64 也能存进去
    const body = data.slice(prefix.length)
    if (!BASE64.test(body) || body.length % 4 !== 0) throw new TaskError('图片内容不是有效的 base64')
    size = Buffer.from(body, 'base64').length
    if (!size) throw new TaskError('附件内容是空的')
  } else {
    const body = data.startsWith('base64,') ? data.slice(7) : data
    if (!BASE64.test(body) || body.length % 4 !== 0) throw new TaskError('文件内容不是有效的 base64')
    size = Buffer.from(body, 'base64').length
    if (!size) throw new TaskError('附件内容是空的')
    if (size > FILE_MAX_BYTES) throw new TaskError(`单个文件不能超过 ${FILE_MAX_BYTES / 1024 / 1024} MB`)
    if (!mime) throw new TaskError('缺少文件类型')
  }
  return { kind, name, mime, size, data }
}

/** 落库：只有这一步需要进串行队列（数量上限 + INSERT） */
export async function addAttachment(db: DB, user: number, taskId: number, input: PreparedAttachment): Promise<Attachment> {
  await getTask(db, user, taskId)
  const { kind, name, mime, size, data } = input
  const count = await db.query('SELECT count(*)::int AS n FROM task_attachments WHERE user_id=$1 AND task_id=$2', [user, taskId])
  if (Number(count.rows[0].n) >= MAX_ATTACHMENTS) throw new TaskError(`每个任务最多 ${MAX_ATTACHMENTS} 个附件，先删掉不用的再传`, 409)
  const r = await db.query(`INSERT INTO task_attachments(user_id,task_id,kind,name,mime,size,data)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,task_id,kind,name,mime,size,created_at,data`, [user, taskId, kind, name, mime, size, data])
  return row(r.rows[0])
}

/** 下载：一律给纯 base64，前端自己拼 Blob（图片的 data URL 前缀在这一步剥掉） */
export async function attachmentData(db: DB, user: number, taskId: number, attachmentId: number) {
  const r = await db.query('SELECT name,mime,size,kind,data FROM task_attachments WHERE user_id=$1 AND task_id=$2 AND id=$3', [user, taskId, attachmentId])
  const a = r.rows[0]
  if (!a) throw new TaskError('附件不存在', 404)
  const data = a.kind === 'image' ? String(a.data).replace(/^data:[^;]+;base64,/, '') : String(a.data)
  return { name: a.name as string, mime: a.mime as string, size: Number(a.size), data }
}

export async function deleteAttachment(db: DB, user: number, taskId: number, attachmentId: number) {
  const r = await db.query('DELETE FROM task_attachments WHERE user_id=$1 AND task_id=$2 AND id=$3 RETURNING id', [user, taskId, attachmentId])
  if (!r.rowCount) throw new TaskError('附件不存在', 404)
}
