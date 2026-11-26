import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import { createPool, migrate, purgeOld } from './db.ts'
import { registerRoutes } from './routes.ts'
import { registerAuth } from './auth.ts'
import { registerAdmin } from './admin.ts'
import { registerWeb } from './web.ts'
import { TaskError } from './tasks.ts'
import { resolveStatsTz, rollupStats } from './stats.ts'

// adminToken：管理页（/admin）用，不设则 /admin* 全部 404
export type AppConfig = {
  adminToken?: string
  /** 登录 / 注册接口每 IP 每分钟次数上限（默认 10） */
  authRatePerMin?: number
  historyTimeoutMs?: number
  reminderIntervalMs?: number
  watchdogIntervalMs?: number
  stallAfterMs?: number
  abortSpreeCount?: number
  abortSpreeWindowMs?: number
  queueTtlMs?: number
  queueDrainLimit?: number
  queueMaxAttempts?: number
  queueSweepIntervalMs?: number
}

// 构造应用（测试里直接用，不 listen）
export async function buildApp(databaseUrl: string, logLevel = 'info', config: AppConfig = { adminToken: process.env.ADMIN_TOKEN ?? '' }) {
  const pool = createPool(databaseUrl)
  await migrate(pool)
  const app = Fastify({ logger: { level: logLevel }, bodyLimit: 1024 * 1024, trustProxy: true })
  await app.register(cors, { origin: true, methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'], allowedHeaders: ['Authorization', 'Content-Type'] })
  await app.register(websocket)
  app.setErrorHandler((err: { statusCode?: number }, req, reply) => {
    if (err instanceof TaskError) return reply.code(err.statusCode).send({ error: err.message })
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: '请求格式不对' })
    req.log.error(err)
    return reply.code(500).send({ error: '服务器出错了' })
  })
  // Web 前端（dist/ 存在才启用）：路由本身不鉴权，由 routes.ts 的钩子放行静态路径
  await registerWeb(app)
  // 先注册 routes（里面有全局鉴权钩子），再注册账号 / 管理接口
  const kick = registerRoutes(app, pool, config)
  registerAuth(app, pool, kick, config.authRatePerMin)
  registerAdmin(app, pool, config.adminToken ?? '', kick)
  // 每小时：先把最近几天沉淀进统计汇总表，再清理过期数据（顺序不能反，否则将被清理的数据来不及沉淀）。两者各自 catch
  const timer = setInterval(async () => {
    await rollupStats(pool).catch(e => app.log.error(e, '统计汇总失败'))
    await purgeOld(pool).catch(e => app.log.error(e, '清理会话失败'))
  }, 3600_000)
  timer.unref()
  // 启动 30 秒后全量汇总一次（不在 buildApp 里同步跑：测试每个进程都 buildApp，共享测试库用户很多）
  const bootRollup = setTimeout(async () => {
    await resolveStatsTz(pool, m => app.log.warn(m)).catch(() => {})
    await rollupStats(pool).catch(e => app.log.error(e, '统计汇总失败'))
  }, 30_000)
  bootRollup.unref()
  app.addHook('onClose', async () => {
    clearInterval(timer)
    clearTimeout(bootRollup)
    await pool.end()
  })
  return app
}

// 直接运行（node src/index.ts）时才启动；被测试 import 时不启动
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('缺少环境变量 DATABASE_URL')
  const app = await buildApp(url, process.env.LOG_LEVEL ?? 'info')
  await app.listen({ port: Number(process.env.PORT) || 3000, host: '0.0.0.0' })
}
