// 邀请码：管理员在 /admin 生成，拿到码的人在网页 /register 自助建号。
// 表结构与生成 / 校验都在这里；公开注册接口在 auth.ts，管理接口在 admin.ts。
import { randomBytes } from 'node:crypto'
import type pg from 'pg'

// 去 0/O/1/I/L 的 31 字符表：码是手抄 / 微信转发的，别让抄错
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const CODE_LENGTH = 10
export const CODE_MAX_USES = 1000

export function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH)
  const raw = Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join('')
  // 展示成 XXXXX-XXXXX，库里存连着的形式
  return `${raw.slice(0, 5)}-${raw.slice(5)}`
}

// 输入归一化：大写、去掉空格横线等装饰符。库里 code 仍带横线，比对两边都归一化
export function normCode(v: unknown): string {
  return typeof v === 'string' ? v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32) : ''
}

// 展示形式：10 位码按 5-5 加横线，其余原样返回
export const formatCode = (code: string) =>
  code.length === CODE_LENGTH + 1 ? `${code.slice(0, 5)}-${code.slice(5)}` : code

export type Invite = {
  id: number
  code: string
  note: string
  maxUses: number
  usedCount: number
  expiresAt: string | null
  revoked: boolean
  createdAt: string
  lastUsedAt: string | null
}

type InviteRow = {
  id: string | number
  code: string
  note: string
  max_uses: number
  used_count: number
  expires_at: Date | null
  revoked: boolean
  created_at: Date
  last_used_at: Date | null
}

const toInvite = (r: InviteRow): Invite => ({
  id: Number(r.id),
  code: formatCode(r.code),
  note: r.note,
  maxUses: r.max_uses,
  usedCount: r.used_count,
  expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
  revoked: r.revoked,
  createdAt: r.created_at.toISOString(),
  lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
})

// 码还有效吗（不检查邮箱是否重复）：存在、没吊销、没过期、没用完
function usable(row: InviteRow | undefined): string {
  if (!row) return '邀请码无效'
  if (row.revoked) return '邀请码已被停用'
  if (row.expires_at && row.expires_at.getTime() < Date.now()) return '邀请码已过期'
  if (row.used_count >= row.max_uses) return '邀请码已被用完'
  return ''
}

export async function createInvite(
  pool: pg.Pool,
  opts: { note?: unknown; maxUses?: unknown; expiresInDays?: unknown } = {},
): Promise<Invite> {
  const note = typeof opts.note === 'string' ? opts.note.trim().slice(0, 100) : ''
  const maxUsesRaw = Number(opts.maxUses ?? 1)
  const maxUses = Number.isSafeInteger(maxUsesRaw) && maxUsesRaw >= 1 ? Math.min(maxUsesRaw, CODE_MAX_USES) : 1
  const daysRaw = Number(opts.expiresInDays)
  const expiresInDays = Number.isSafeInteger(daysRaw) && daysRaw >= 1 && daysRaw <= 3650 ? daysRaw : null
  // 撞码概率约 31^-10，重试只是形式上的兜底（unique 冲突时换一个再来）
  for (let i = 0; i < 5; i++) {
    const code = generateCode()
    try {
      const r = await pool.query<InviteRow>(
        `INSERT INTO invites (code, note, max_uses, expires_at)
         VALUES ($1, $2, $3, CASE WHEN $4::int IS NULL THEN NULL ELSE now() + ($4::int * interval '1 day') END)
         RETURNING *`,
        [code, note, maxUses, expiresInDays],
      )
      return toInvite(r.rows[0])
    } catch (e) {
      if ((e as { code?: string })?.code !== '23505') throw e
    }
  }
  throw new Error('生成邀请码失败')
}

export async function listInvites(pool: pg.Pool): Promise<Invite[]> {
  const r = await pool.query<InviteRow>('SELECT * FROM invites ORDER BY id DESC LIMIT 500')
  return r.rows.map(toInvite)
}

// 停用：只置 revoked，使用记录保留
export async function revokeInvite(pool: pg.Pool, id: number): Promise<Invite | null> {
  const r = await pool.query<InviteRow>('UPDATE invites SET revoked = true WHERE id = $1 AND revoked = false RETURNING *', [id])
  return r.rows[0] ? toInvite(r.rows[0]) : null
}

export async function deleteInvite(pool: pg.Pool, id: number): Promise<boolean> {
  const r = await pool.query('DELETE FROM invites WHERE id = $1', [id])
  return (r.rowCount ?? 0) > 0
}

/**
 * 注册时核销：一个事务里锁定邀请码行、建账号、记一笔使用。
 * 邮箱唯一冲突（23505）按 409 处理；邀请码无效统一报「邀请码无效或已用完」，
 * 不区分「不存在 / 过期 / 用完」，避免帮人猜码。
 */
export type RegisterResult = { userId: number; email: string } | { error: string; statusCode: number }

export async function registerWithInvite(
  pool: pg.Pool,
  code: string,
  email: string,
  passwordHash: string,
): Promise<RegisterResult> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const inv = await client.query<InviteRow>(
      'SELECT * FROM invites WHERE replace(replace(code, \'-\', \'\'), \' \', \'\') = $1 FOR UPDATE',
      [normCode(code)],
    )
    const bad = usable(inv.rows[0])
    if (bad) {
      await client.query('ROLLBACK')
      return { error: '邀请码无效或已用完', statusCode: 400 }
    }
    const row = inv.rows[0]
    let userId: number
    try {
      const u = await client.query<{ id: string | number }>(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
        [email, passwordHash],
      )
      userId = Number(u.rows[0].id)
    } catch (e) {
      await client.query('ROLLBACK')
      if ((e as { code?: string })?.code === '23505') return { error: '这个邮箱已经有账号了', statusCode: 409 }
      throw e
    }
    await client.query('UPDATE invites SET used_count = used_count + 1, last_used_at = now() WHERE id = $1', [row.id])
    await client.query('INSERT INTO invite_uses (invite_id, user_id, email) VALUES ($1, $2, $3)', [row.id, userId, email])
    await client.query('COMMIT')
    return { userId, email }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

export function migrateInvites(pool: { query: pg.Pool['query'] }) {
  return (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS invites (
      id bigserial primary key,
      code text unique not null,
      note text not null default '',
      max_uses integer not null default 1,
      used_count integer not null default 0,
      expires_at timestamptz,
      revoked boolean not null default false,
      created_at timestamptz not null default now(),
      last_used_at timestamptz
    )`)
    await pool.query(`CREATE TABLE IF NOT EXISTS invite_uses (
      id bigserial primary key,
      invite_id bigint not null references invites(id) on delete cascade,
      user_id bigint,
      email text not null,
      created_at timestamptz not null default now()
    )`)
    await pool.query('CREATE INDEX IF NOT EXISTS idx_invite_uses_invite ON invite_uses(invite_id)')
  })()
}
