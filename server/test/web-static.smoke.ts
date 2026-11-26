// web.ts 的最小冒烟测试：不连数据库，只验证静态路由与 sendFile 行为
import Fastify from 'fastify'
import { isWebPath, registerWeb, webRoot } from '../src/web.ts'

if (!webRoot) throw new Error('未探测到 dist/，测试环境应有仓库根目录 dist')

const app = Fastify({ logger: false })
// 模拟 routes.ts 的鉴权钩子（同一段放行逻辑）
app.decorateRequest('userId', 0)
app.addHook('onRequest', async (req, reply) => {
  if (req.method === 'OPTIONS' || req.is404) return
  const path = req.url.split('?')[0]
  if (isWebPath(path)) return
  return reply.code(401).send({ error: '请先登录' })
})
await registerWeb(app)
// 桩接口：真实服务端里存在的路由（未登录应 401）
app.get('/auth/me', async (req) => ({ userId: (req as unknown as { userId: number }).userId }))
app.get('/events', async () => ({ events: [] }))

let fail = 0
const check = async (desc: string, expect: number, fn: () => Promise<{ statusCode: number }>) => {
  const res = await fn()
  const ok = res.statusCode === expect
  if (!ok) fail++
  console.log(`${ok ? 'ok' : 'FAIL'} ${desc}: ${res.statusCode}（期望 ${expect}）`)
}

await check('GET / 出首页', 200, () => app.inject({ method: 'GET', url: '/' }))
await check('GET /index.html 出首页', 200, () => app.inject({ method: 'GET', url: '/index.html' }))
await check('GET /assets/xxx 免鉴权（404 说明放行但文件不存在）', 404, () => app.inject({ method: 'GET', url: '/assets/nope.js' }))
await check('GET /auth/me 这类真实接口仍要鉴权', 401, () => app.inject({ method: 'GET', url: '/auth/me' }))
await check('GET /events 仍要鉴权', 401, () => app.inject({ method: 'GET', url: '/events' }))
await check('GET / 之外的未知路径 404（is404 先短路，不放行也不报 401）', 404, () => app.inject({ method: 'GET', url: '/some/random/path' }))

// 首页内容是真的
const home = await app.inject({ method: 'GET', url: '/' })
if (!home.body.includes('<div id="root">')) { fail++; console.log('FAIL 首页内容不对') } else console.log('ok 首页内容含 #root')

await app.close()
process.exit(fail ? 1 : 0)
