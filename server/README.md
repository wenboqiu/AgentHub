# AgentHub 服务端

Node + Fastify + pg + `@fastify/websocket`。Node 24 直接运行 `.ts`（本机 Node 22 也能跑，只能用可擦除类型语法，本地 import 要带 `.ts` 扩展名）。

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `DATABASE_URL` | 是 | - | Postgres 连接串，启动时自动建表 `sessions` |
| `AGENTHUB_TOKEN` | 是 | - | 单用户令牌；REST 用 `Authorization: Bearer <token>`，WebSocket 用 `?token=` |
| `PORT` | 否 | `3000` | 监听端口 |
| `LOG_LEVEL` | 否 | `info` | pino 日志级别 |

## 接口

除 `/health` 外都要鉴权，token 不对返回 401。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok:true}`，免鉴权 |
| POST | `/events` | body `{events: Event[]}`，一次最多 100 条。`Event = {agent, sessionId, machine, cwd, state, at, title?, summary?, pid?, quiet?}`。`at` 早于库里 `event_at` 的事件直接丢弃（乱序）；`quiet=true` 只更新数据、不提醒，且 done/aborted 记为已处理。返回 `{accepted}` |
| GET | `/sessions?all=1` | 默认隐藏 `ended` 和 24 小时没更新的会话；`all=1` 不过滤。按 `updated_at` 倒序，返回 `{sessions}` |
| POST | `/sessions/:id/ack` | 标为已处理并广播 |
| POST | `/sessions/ack-all` | 全部标为已处理并广播 |
| DELETE | `/sessions/:id` | 删除并广播 `{type:'removed', id}` |
| GET (WS) | `/ws?token=` | 连上先发 `{type:'snapshot', sessions}`；之后每次变化发 `{type:'session', session, notify}`；服务端每 30 秒发 ping |

状态：`idle | running | waiting | done | aborted | ended`。会话 id 形如 `claude:<sessionId>` / `codex:<sessionId>`。

`acked` 规则：变成 `running` 自动置 true；变成 `waiting/done/aborted`（非 quiet）置 false 并 `notify=true` 提醒一次；任一端「已处理」置 true。服务端每小时清理 7 天没更新的会话。

## 开发与测试

```bash
docker start agenthub-pg 2>/dev/null || docker run -d --name agenthub-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=agenthub -p 55433:5432 postgres:16-alpine
cd server && npm install && npm run check && npm test
AGENTHUB_TOKEN=dev DATABASE_URL=postgres://postgres:dev@localhost:55433/agenthub node src/index.ts
```

测试默认连 `postgres://postgres:dev@localhost:55433/agenthub`，可用 `DATABASE_URL` 覆盖。
