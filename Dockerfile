# 完整构建（手动部署用）：从仓库根目录构建，`docker build -f Dockerfile -t wondergarden-agenthub:latest .`
# 与 server/Dockerfile 的区别：本文件多一个前端构建阶段，把 Web 版打进镜像（/app/web）。
# Dokploy 面板仍按 buildPath=server/ + server/Dockerfile 构建（纯 API，不托管 Web）；
# 面板部署若要带 Web，把 buildPath 改成仓库根并切到本文件，或继续用下面的手动流程。
# 阶段 1：构建 Web 前端（vite build → dist/）
FROM node:24-alpine AS web
WORKDIR /build
COPY package.json package-lock.json tsconfig.json tsconfig.node.json vite.config.ts index.html ./
COPY src ./src
RUN npm config set registry https://registry.npmmirror.com && npm ci && npm run build

# 阶段 2：server 运行镜像（Node 24 直接运行 .ts）
FROM node:24-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm config set registry https://registry.npmmirror.com && npm ci --omit=dev
COPY server/src ./src
# Web 前端：web.ts 探测 import.meta.dirname/../web（即 /app/web）
COPY --from=web /build/dist ./web
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/index.ts"]
