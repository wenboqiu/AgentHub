// 管理后台：GET /admin 是单页（admin.html，无构建），接口走 /admin/*，用 ADMIN_TOKEN（Bearer）鉴权。没设 ADMIN_TOKEN 时全部 404
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type pg from 'pg'
import { adminGuard, emailError, hashPassword, normEmail, passwordError, type Kick } from './auth.ts'
import { createInvite, deleteInvite, listInvites, revokeInvite } from './invites.ts'

const PAGE = readFileSync(join(import.meta.dirname, 'admin.html'), 'utf8')
const REGISTER_PAGE = readFileSync(join(import.meta.dirname, 'register.html'), 'utf8')
// 页面只有内联脚本 / 样式，数据只请求本站
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

type DeviceRow = { id: string | number; device: string; created_at: Date; last_used_at: Date }
const toDevice = (x: DeviceRow) => ({ id: Number(x.id), device: x.device, createdAt: x.created_at.toISOString(), lastUsedAt: x.last_used_at.toISOString() })

export function registerAdmin(app: FastifyInstance, pool: pg.Pool, adminToken: string, kick: Kick) {
  const fail = (reply: FastifyReply, code: number, error: string) => reply.code(code).send({ error })

  const page = async (_req: unknown, reply: FastifyReply) => {
    if (!adminToken) return fail(reply, 404, '接口不存在')
    return reply
      .type('text/html; charset=utf-8')
      .header('Content-Security-Policy', CSP)
      .header('X-Robots-Tag', 'noindex')
      .header('Cache-Control', 'no-store')
      .send(PAGE)
  }
  app.get('/admin', page)
  app.get('/admin/', page)

  // 邀请码注册页：公开（注册接口自己限流），页面本身没有任何敏感内容
  app.get('/register', async (_req, reply) =>
    reply
      .type('text/html; charset=utf-8')
      .header('Content-Security-Policy', CSP)
      .header('X-Robots-Tag', 'noindex')
      .header('Cache-Control', 'no-store')
      .send(REGISTER_PAGE),
  )

  app.register(async api => {
    api.addHook('preHandler', adminGuard(adminToken))

    const parseId = (raw: unknown) => {
      const id = Number(raw)
      return Number.isSafeInteger(id) && id > 0 ? id : null
    }

    api.get('/admin/users', async () => {
      const r = await pool.query(
        `SELECT u.id, u.email, u.created_at, count(a.id) AS devices, max(a.last_used_at) AS last_used_at
           FROM users u LEFT JOIN auth_sessions a ON a.user_id = u.id
          GROUP BY u.id ORDER BY u.id`,
      )
      return r.rows.map(x => ({
        id: Number(x.id),
        email: x.email,
        createdAt: (x.created_at as Date).toISOString(),
        devices: Number(x.devices),
        lastUsedAt: x.last_used_at ? (x.last_used_at as Date).toISOString() : null,
      }))
    })

    api.post('/admin/users', async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const email = normEmail(body.email)
      const bad = emailError(email) || passwordError(body.password)
      if (bad) return fail(reply, 400, bad)
      const r = await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING id, created_at', [
        email,
        await hashPassword(body.password as string),
      ])
      if (!r.rowCount) return fail(reply, 409, '这个邮箱已经有账号了')
      return { id: Number(r.rows[0].id), email, createdAt: (r.rows[0].created_at as Date).toISOString() }
    })

    api.post('/admin/users/:id/password', async (req, reply) => {
      const id = parseId((req.params as { id: string }).id)
      const body = (req.body ?? {}) as Record<string, unknown>
      const bad = passwordError(body.password)
      if (bad) return fail(reply, 400, bad)
      if (!id) return fail(reply, 404, '账号不存在')
      const r = await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(body.password as string), id])
      if (!r.rowCount) return fail(reply, 404, '账号不存在')
      await pool.query('DELETE FROM auth_sessions WHERE user_id = $1', [id])
      kick.user(id)
      return { ok: true }
    })

    api.delete('/admin/users/:id', async (req, reply) => {
      const id = parseId((req.params as { id: string }).id)
      if (!id) return fail(reply, 404, '账号不存在')
      const r = await pool.query('DELETE FROM users WHERE id = $1', [id])
      if (!r.rowCount) return fail(reply, 404, '账号不存在')
      kick.user(id)
      return { ok: true }
    })

    api.get('/admin/users/:id/devices', async (req, reply) => {
      const id = parseId((req.params as { id: string }).id)
      if (!id) return fail(reply, 404, '账号不存在')
      const r = await pool.query<DeviceRow>('SELECT id, device, created_at, last_used_at FROM auth_sessions WHERE user_id = $1 ORDER BY last_used_at DESC, id DESC', [id])
      return r.rows.map(toDevice)
    })

    // ---------- 邀请码 ----------
    api.get('/admin/invites', async () => listInvites(pool))

    api.post('/admin/invites', async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const inv = await createInvite(pool, body)
      return inv
    })

    api.delete('/admin/invites/:id', async (req, reply) => {
      const id = parseId((req.params as { id: string }).id)
      if (!id) return fail(reply, 404, '邀请码不存在')
      const r = await revokeInvite(pool, id)
      if (!r) {
        // 没吊销成功：可能是已经吊销过，也可能是真不存在
        const gone = await deleteInvite(pool, id)
        if (!gone) return fail(reply, 404, '邀请码不存在')
      }
      return { ok: true }
    })

    api.delete('/admin/devices/:id', async (req, reply) => {
      const id = parseId((req.params as { id: string }).id)
      if (!id) return fail(reply, 404, '设备不存在')
      const r = await pool.query('DELETE FROM auth_sessions WHERE id = $1', [id])
      if (!r.rowCount) return fail(reply, 404, '设备不存在')
      kick.authSessions([id])
      return { ok: true }
    })
  })
}
