# AgentHub 服务端

Node + Fastify + pg + `@fastify/websocket`。Node 24 直接运行 `.ts`（本机 Node 22 也能跑，只能用可擦除类型语法，本地 import 要带 `.ts` 扩展名）。

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `DATABASE_URL` | 是 | - | Postgres 连接串，启动时自动建表 `sessions` |
| `AGENTHUB_TOKEN` | 是 | - | 单用户令牌；REST 用 `Authorization: Bearer <token>`，WebSocket 用 `?token=` |
| `AGENTHUB_CONTROL_TOKEN` | 否 | 空 | 远程控制密钥。**不设置 = 整个远程控制功能关闭**（控制类接口 403、执行器 WS 被拒）。设置后控制类 REST 要额外带 `X-Control-Token`，执行器 WS 要带 `control=` 参数 |
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

### 远程控制（第二版）

在手机 / 电脑的 AgentHub 里给会话发消息、批授权、停止。电脑端 Rust「执行器」用 WebSocket 连上来，服务端把指令转给它，它在本机接着跑 `claude -p` / `codex app-server`，输出和授权请求再经服务端广播给 UI。

新表（启动时 `CREATE TABLE IF NOT EXISTS`）：`runs`、`messages`（每会话只留最近 200 条）、`approvals`；`runs` / `approvals` 随清理任务一起清 7 天前的。

控制类 REST 要 `Authorization: Bearer` **和** `X-Control-Token`。没设 `AGENTHUB_CONTROL_TOKEN` 返回 `403 {error:'服务端没有开启远程控制'}`，密钥不对返回 403。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/control/status` | 只要 Bearer。`{enabled, agents}`，`agents` 是在线执行器的机器名 |
| POST | `/sessions/:id/messages` | body `{text}`（1–8000 字符）。会话不存在 404；该会话所在 machine 没有在线执行器 409 `电脑端不在线`；已有 queued/running 的 run 409 `这个会话正在运行`；Codex 会话状态是 `running` 时 409。成功返回 `{runId}` |
| POST | `/runs/:id/stop` | 转发给执行器，返回 `{ok:true}` |
| POST | `/approvals/:id` | body `{decision:'allow'` 或 `'deny'}`；不是 pending 返回 409 |
| POST | `/sessions/:id/history` | 请执行器读本地记录并写入 messages（等最多 10 秒，超时 504，执行器不在线 409）。返回新插入的 `{messages}`（和已有消息完全重复的会跳过） |
| GET | `/sessions/:id/messages?limit=100` | 只要 Bearer。`{messages, approvals(pending), run(最近一个)}` |

执行器 WS：`/ws?token=<AGENTHUB_TOKEN>&role=agent&machine=<机器名>&control=<控制密钥>`。同一 machine 的新连接会顶掉旧连接（关闭码 4000）；控制密钥不对或功能未开启时关闭码 4403。

| 方向 | 消息 |
|---|---|
| 服务端 → 执行器 | `run.start {runId, sessionId, agent, sessionKey, cwd, text}`、`run.stop {runId}`、`approval.created {localId, approvalId}`、`approval.decide {approvalId, decision}`、`history.request {requestId, agent, sessionKey, cwd}` |
| 执行器 → 服务端 | `run.status {runId, status, error?}`（status 为 running / done / failed / stopped）、`run.message {runId, role, text}`（role 为 assistant / tool / system）、`run.approval {runId, localId, tool, detail}`、`run.approvalExpired {runId, approvalId}`、`history.result {requestId, messages:[{role,text}], error?}` |

执行器断线（或被顶掉）时，它名下 queued/running 的 run 标 `failed`（`电脑端断开`），pending 授权标 `expired`。

授权在执行器等待 30 分钟超时后，立即上报 `run.approvalExpired`。服务端核对机器及运行归属，仅将 pending 授权改为 expired 并广播，运行可继续；重复通知无副作用。此修复需要同时更新桌面执行器和服务端。

viewer 的 `/ws` 新增广播：`{type:'run', run}`、`{type:'message', message}`、`{type:'approval', approval(带 project), notify}`（`notify` 只在新建 pending 时为 true）、`{type:'agents', agents}`；`snapshot` 里多带 `agents` 和 pending 的 `approvals`。

状态：`idle | running | waiting | done | aborted | ended`。会话 id 形如 `claude:<sessionId>` / `codex:<sessionId>`。

`acked` 规则：变成 `running` 自动置 true；变成 `waiting/done/aborted`（非 quiet）置 false 并 `notify=true` 提醒一次；任一端「已处理」置 true。服务端每小时清理 7 天没更新的会话。

## 开发与测试

```bash
docker start agenthub-pg 2>/dev/null || docker run -d --name agenthub-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=agenthub -p 55433:5432 postgres:16-alpine
cd server && npm install && npm run check && npm test
AGENTHUB_TOKEN=dev DATABASE_URL=postgres://postgres:dev@localhost:55433/agenthub node src/index.ts
```

测试默认连 `postgres://postgres:dev@localhost:55433/agenthub`，可用 `DATABASE_URL` 覆盖。启动时建表用 Postgres advisory lock 串行，多个进程（或并行的测试文件）同时启动不会互相撞。

开启远程控制联调：`AGENTHUB_TOKEN=dev AGENTHUB_CONTROL_TOKEN=devctl DATABASE_URL=... node src/index.ts`。
