// 账号：密码哈希、设备会话、限流、管理员鉴权。照 Bookshelf 的实现复制（不跨仓库 import）
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type pg from 'pg'

export const SESSION_TTL = 180 * 24 * 3600 * 1000
const TOUCH_INTERVAL = 3600 * 1000
// scrypt 参数：N=16384 约 16MB 内存，2C2G 上够轻
const N = 16384
const R = 8
const P = 1

declare module 'fastify' {
  interface FastifyRequest {
    userId: number
    authSessionId: number
  }
}

const scryptAsync = (password: string, salt: Buffer, n: number, r: number, p: number) =>
  new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 32, { N: n, r, p }, (err, key) => (err ? reject(err) : resolve(key))))

export async function hashPassword(password: string) {
  const salt = randomBytes(16)
  const key = await scryptAsync(password, salt, N, R, P)
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string) {
  const [alg, n, r, p, salt, hash] = stored.split('$')
  if (alg !== 'scrypt') return false
  const expected = Buffer.from(hash, 'base64')
  const key = await scryptAsync(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p))
  return key.length === expected.length && timingSafeEqual(key, expected)
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const normEmail = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '')
export const emailError = (email: string) => (!EMAIL_RE.test(email) || email.length > 200 ? '邮箱格式不对' : '')
export const passwordError = (v: unknown) => (typeof v !== 'string' || v.length < 8 ? '密码至少 8 位' : v.length > 200 ? '密码太长' : '')

// 登录限流：内存里按 IP，每分钟 10 次。每个 app 一份状态（测试互不影响）
function makeLimiter() {
  const hits = new Map<string, number[]>()
  return (ip: string) => {
    const now = Date.now()
    const list = (hits.get(ip) ?? []).filter(t => now - t < 60_000)
    list.push(now)
    hits.set(ip, list)
    if (hits.size > 5000) for (const [k, v] of hits) if (now - v[v.length - 1] > 60_000) hits.delete(k)
    return list.length > 10
  }
}

export async function newAuthSession(pool: pg.Pool, userId: number | string, device: unknown) {
  const token = randomBytes(32).toString('base64url')
  await pool.query('INSERT INTO auth_sessions (token_hash, user_id, device) VALUES ($1, $2, $3)', [
    sha256(token),
    userId,
    typeof device === 'string' ? device.trim().slice(0, 50) : '',
  ])
  return token
}

export type AuthResult = { userId: number; authSessionId: number } | { error: string }

// 校验设备会话 token；滑动有效期，最多每小时写一次库
export async function authenticate(pool: pg.Pool, token: string | null | undefined): Promise<AuthResult> {
  if (!token) return { error: '请先登录' }
  const tokenHash = sha256(token)
  const res = await pool.query('SELECT id, user_id, last_used_at FROM auth_sessions WHERE token_hash = $1', [tokenHash])
  const expired = { error: '登录已过期，请重新登录' }
  if (!res.rowCount) return expired
  const last = (res.rows[0].last_used_at as Date).getTime()
  const now = Date.now()
  if (now - last > SESSION_TTL) return expired
  if (now - last > TOUCH_INTERVAL) await pool.query('UPDATE auth_sessions SET last_used_at = now() WHERE id = $1', [res.rows[0].id])
  return { userId: Number(res.rows[0].user_id), authSessionId: Number(res.rows[0].id) }
}

// kick：删除设备会话后要立刻关闭它的 WS，由 routes 提供
export type Kick = {
  authSessions(ids: number[]): void
  user(userId: number): void
}

export function registerAuth(app: FastifyInstance, pool: pg.Pool, kick: Kick) {
  const fail = (reply: FastifyReply, code: number, error: string) => reply.code(code).send({ error })
  const limited = makeLimiter()

  app.post('/auth/login', async (req, reply) => {
    if (limited(req.ip)) return fail(reply, 429, '操作太频繁，请稍后再试')
    const body = (req.body ?? {}) as Record<string, unknown>
    const email = normEmail(body.email)
    const password = typeof body.password === 'string' ? body.password.slice(0, 200) : ''
    const res = await pool.query('SELECT id, password_hash FROM users WHERE email = $1', [email])
    // 邮箱不存在也跑一遍哈希，避免靠耗时判断邮箱是否存在
    const ok = res.rowCount ? await verifyPassword(password, res.rows[0].password_hash) : (await hashPassword(password), false)
    if (!ok) return fail(reply, 401, '邮箱或密码不对')
    return { token: await newAuthSession(pool, res.rows[0].id, body.device), email }
  })

  app.post('/auth/logout', async req => {
    await pool.query('DELETE FROM auth_sessions WHERE id = $1', [req.authSessionId])
    kick.authSessions([req.authSessionId])
    return { ok: true }
  })

  app.get('/auth/me', async req => {
    const r = await pool.query('SELECT email FROM users WHERE id = $1', [req.userId])
    return { email: r.rows[0]?.email ?? '' }
  })

  app.get('/auth/devices', async req => {
    const r = await pool.query('SELECT id, device, created_at, last_used_at FROM auth_sessions WHERE user_id = $1 ORDER BY last_used_at DESC, id DESC', [req.userId])
    return r.rows.map(x => ({
      id: Number(x.id),
      device: x.device,
      createdAt: (x.created_at as Date).toISOString(),
      lastUsedAt: (x.last_used_at as Date).toISOString(),
      current: Number(x.id) === req.authSessionId,
    }))
  })

  app.delete('/auth/devices/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    if (!Number.isSafeInteger(id) || id <= 0) return fail(reply, 404, '设备不存在')
    const r = await pool.query('DELETE FROM auth_sessions WHERE id = $1 AND user_id = $2', [id, req.userId])
    if (!r.rowCount) return fail(reply, 404, '设备不存在')
    kick.authSessions([id])
    return { ok: true }
  })

  app.post('/auth/password', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const oldPassword = typeof body.oldPassword === 'string' ? body.oldPassword.slice(0, 200) : ''
    const bad = passwordError(body.newPassword)
    if (bad) return fail(reply, 400, bad)
    const u = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.userId])
    if (!u.rowCount || !(await verifyPassword(oldPassword, u.rows[0].password_hash))) return fail(reply, 403, '旧密码不对')
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(body.newPassword as string), req.userId])
    const gone = await pool.query('DELETE FROM auth_sessions WHERE user_id = $1 AND id <> $2 RETURNING id', [req.userId, req.authSessionId])
    kick.authSessions(gone.rows.map(x => Number(x.id)))
    return { ok: true }
  })
}

// 管理员鉴权（Bearer ADMIN_TOKEN）：没设令牌时 404；同一 IP 10 分钟内错 10 次后先拒绝，防爆破。每个 app 一份状态
export function adminGuard(adminToken: string) {
  const adminFails = new Map<string, number[]>()
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!adminToken) return reply.code(404).send({ error: '接口不存在' })
    const now = Date.now()
    const fails = (adminFails.get(req.ip) ?? []).filter(t => now - t < 600_000)
    if (fails.length >= 10) return reply.code(429).send({ error: '错误次数太多，请稍后再试' })
    const given = Buffer.from(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '')
    const want = Buffer.from(adminToken)
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      fails.push(now)
      adminFails.set(req.ip, fails)
      return reply.code(401).send({ error: '管理员令牌不对' })
    }
  }
}
