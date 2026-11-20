import type pg from 'pg'
import { TaskError } from './tasks.ts'

// 账号级界面偏好：跨设备同步（电脑、手机看到的一样）。目前只有 agent 头像。
// 头像三种：首字母（默认，不存）、内置 emoji（存 id，界面自己画）、自定义图片（客户端裁成小图后存 data URL）。

type DB = Pick<pg.Pool, 'query'>

export const AVATAR_AGENTS = ['claude', 'codex', 'doubao', 'workbuddy', 'zcode', 'codebuddy', 'chatgpt'] as const
export type AvatarAgent = (typeof AVATAR_AGENTS)[number]
export type AgentAvatar = { kind: 'preset'; id: string } | { kind: 'image'; data: string }
export type Prefs = { avatars: Partial<Record<AvatarAgent, AgentAvatar>> }

/** 单张头像 data URL 上限：客户端裁成 96×96，正常 5–20KB，留足余量 */
export const AVATAR_IMAGE_MAX = 100_000
const IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/
const PRESET_RE = /^[a-z0-9-]{1,32}$/

export async function migratePrefs(db: DB) {
  await db.query(`CREATE TABLE IF NOT EXISTS user_prefs (
    user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now())`)
}

/** 角色 / 项目的 avatar 字段：null = 不设（界面显示默认头像） */
export function avatarInput(v: unknown): AgentAvatar | null {
  return v === null ? null : cleanAvatar(v)
}
/** 库里读出来的 avatar jsonb：坏数据当没设 */
export function storedAvatar(v: unknown): AgentAvatar | null {
  if (v === null || v === undefined) return null
  try { return cleanAvatar(v) } catch { return null }
}

export function cleanAvatar(v: unknown): AgentAvatar {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new TaskError('头像必须是对象')
  const o = v as Record<string, unknown>
  if (o.kind === 'preset') {
    if (typeof o.id !== 'string' || !PRESET_RE.test(o.id)) throw new TaskError('内置头像 id 不合法')
    return { kind: 'preset', id: o.id }
  }
  if (o.kind === 'image') {
    if (typeof o.data !== 'string' || !IMAGE_RE.test(o.data)) throw new TaskError('头像图片须为 png / jpeg / webp 的 data URL')
    if (o.data.length > AVATAR_IMAGE_MAX) throw new TaskError('头像图片太大，请换一张小一点的')
    return { kind: 'image', data: o.data }
  }
  throw new TaskError('头像类型只能是 preset 或 image')
}

/** 库里读出来的旧数据也过一遍：坏的条目直接丢，不让整份偏好读失败 */
function normalizeStored(raw: unknown): Prefs {
  const out: Prefs = { avatars: {} }
  const avatars = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).avatars : undefined
  if (avatars && typeof avatars === 'object') {
    for (const k of AVATAR_AGENTS) {
      const v = (avatars as Record<string, unknown>)[k]
      if (v === undefined) continue
      try { out.avatars[k] = cleanAvatar(v) } catch { /* 丢掉坏条目 */ }
    }
  }
  return out
}

export async function getPrefs(db: DB, userId: number): Promise<Prefs> {
  const r = await db.query<{ data: unknown }>('SELECT data FROM user_prefs WHERE user_id=$1', [userId])
  return normalizeStored(r.rows[0]?.data)
}

/** 补丁：avatars.<agent> = 头像对象 → 设置；= null → 恢复默认（首字母）。没提到的 agent 不动 */
export async function savePrefs(db: DB, userId: number, patch: unknown): Promise<Prefs> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TaskError('偏好设置必须是对象')
  const p = patch as Record<string, unknown>
  for (const k of Object.keys(p)) if (k !== 'avatars') throw new TaskError(`未知的偏好字段：${k}`)
  const next = await getPrefs(db, userId)
  if ('avatars' in p) {
    const a = p.avatars
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new TaskError('avatars 必须是对象')
    for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
      if (!(AVATAR_AGENTS as readonly string[]).includes(k)) throw new TaskError(`未知的 agent：${k}`)
      if (v === null) delete next.avatars[k as AvatarAgent]
      else next.avatars[k as AvatarAgent] = cleanAvatar(v)
    }
  }
  await db.query(
    `INSERT INTO user_prefs(user_id, data, updated_at) VALUES($1,$2,now())
     ON CONFLICT (user_id) DO UPDATE SET data=$2, updated_at=now()`,
    [userId, JSON.stringify(next)],
  )
  return next
}
