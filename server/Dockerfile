# 单阶段：Node 24 直接运行 .ts，不需要构建
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm config set registry https://registry.npmmirror.com && npm ci --omit=dev
COPY src ./src
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/index.ts"]
