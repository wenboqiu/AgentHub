# 单阶段：Node 24 直接运行 .ts，不需要构建
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm config set registry https://registry.npmmirror.com && npm ci --omit=dev
COPY src ./src
# Web 前端（可选）：构建镜像前把仓库根目录 `npm run build` 产出的 dist/ 拷成 server/web/
# （Windows Git Bash：cp -r ../dist web ），不拷则镜像只提供 API，不托管 Web 端
# COPY web ./web
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/index.ts"]
