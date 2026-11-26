// Web 前端托管：把根目录 vite build 出来的 dist/（或镜像里的 web/）挂到 /，
// 浏览器直接访问服务端就是完整客户端。只有目录存在才启用，纯 API 部署行为不变。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'

/** WEB_DIST_DIR 覆盖路径；默认依次找源码仓库的 dist/ 与 Docker 镜像里的 web/ */
function resolveWebRoot(): string | null {
  const fromEnv = process.env.WEB_DIST_DIR?.trim()
  if (fromEnv) return existsSync(join(fromEnv, 'index.html')) ? fromEnv : null
  for (const candidate of [join(import.meta.dirname, '../../dist'), join(import.meta.dirname, '../web')]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate
  }
  return null
}

export const webRoot = resolveWebRoot()

/** 免鉴权的 Web 前端路径：精确匹配（注意 '/' 不能当别的前缀用，否则整个站都放行了） */
export const WEB_EXACT_PATHS = webRoot ? ['/', '/index.html'] : []
/** 免鉴权的 Web 前端路径前缀 */
export const WEB_PREFIX_PATHS = webRoot ? ['/assets/'] : []

/** routes.ts 鉴权钩子用：GET/HEAD 命中前端静态路径才放行 */
export const isWebPath = (path: string) =>
  WEB_EXACT_PATHS.includes(path) || WEB_PREFIX_PATHS.some(p => path.startsWith(p))

export async function registerWeb(app: FastifyInstance) {
  if (!webRoot) return
  await app.register(fastifyStatic, {
    root: webRoot,
    prefix: '/',
    // index.html 由显式路由提供，避免 / 匹配两次
    serve: false,
  })
  // 主页面：GET / 与 /index.html
  app.get('/', async (_req, reply) => {
    return reply.sendFile('index.html')
  })
  app.get('/index.html', async (_req, reply) => {
    return reply.sendFile('index.html')
  })
  // assets/ 下的构建产物（带 contenthash，可以放心缓存）；sendFile 相对 root，所以要补 assets/ 前缀
  app.get('/assets/*', async (req, reply) => {
    return reply.sendFile('assets/' + (req.params as { '*': string })['*'], { immutable: true, maxAge: '1y' })
  })
}
