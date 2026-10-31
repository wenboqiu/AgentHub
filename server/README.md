# AgentHub 服务端

Node + Fastify + pg + `@fastify/websocket`。Node 24 直接运行 `.ts`（本机 Node 22 也能跑，只能用可擦除类型语法，本地 import 要带 `.ts` 扩展名）。

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `DATABASE_URL` | 是 | - | Postgres 连接串，启动时自动建表 |
| `ADMIN_TOKEN` | 否 | 空 | 管理页 `/admin` 和 `/admin/*` 接口用的令牌（`Authorization: Bearer`）。**不设则 `/admin*` 全部 404**，也就没法建账号 |
| `PORT` | 否 | `3000` | 监听端口 |
| `LOG_LEVEL` | 否 | `info` | pino 日志级别 |

## 接口

账号体系（0.3.0 起）：邮箱 + 密码登录，每台设备登录后拿到自己的会话 token（库里只存 sha256，180 天按最后使用时间滑动）。**不开放注册**，账号只能由管理员在 `/admin` 页面创建。每个账号的数据（会话、运行、消息、授权、在线电脑）互相隔离，别人的数据一律 404。

除 `/health`、`/auth/login`、`/admin*` 外都要 `Authorization: Bearer <设备会话 token>`（WebSocket 用 `?token=`）。没带 token 返回 401 `请先登录`，无效 / 过期返回 401 `登录已过期，请重新登录`。

### 账号接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/login` | `{email, password, device}` → `{token, email}`；同一 IP 每分钟 10 次，超过 429；错误统一 401 `邮箱或密码不对` |
| POST | `/auth/logout` | 删当前设备会话并关闭它的 WS |
| GET | `/auth/me` | `{email}` |
| GET | `/auth/devices` | `[{id, device, createdAt, lastUsedAt, current}]` |
| DELETE | `/auth/devices/:id` | 只能删自己账号的（否则 404）；立刻以关闭码 4401 关闭该设备的所有 WS |
| POST | `/auth/password` | `{oldPassword, newPassword}`；旧密码错 403；新密码 8–200 位；成功后其它设备全部下线 |

### 管理页与管理接口

`GET /admin` 返回管理页（`src/admin.html`，单文件）：输入 `ADMIN_TOKEN` 后可以建账号、重置密码、查看 / 踢设备、删账号。接口都要 `Authorization: Bearer <ADMIN_TOKEN>`；同一 IP 10 分钟内错 10 次后 429。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET / POST | `/admin/users` | 列表 `[{id,email,createdAt,devices,lastUsedAt}]` / 建账号 `{email,password}`（重复 409） |
| POST | `/admin/users/:id/password` | `{password}` 重置密码，并让该用户全部设备下线 |
| DELETE | `/admin/users/:id` | 删账号（级联删数据） |
| GET | `/admin/users/:id/devices` | 该用户的设备会话 |
| DELETE | `/admin/devices/:id` | 踢掉一个设备 |

### 事件与会话接口

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

控制类接口没有单独的密钥，和其它接口一样用设备会话 token；兜底是电脑端「允许手机远程执行」开关 + 项目目录白名单 + 每次授权都要在手机上确认。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/control/status` | `{agents}`，本账号在线执行器的机器名 |
| POST | `/sessions/:id/messages` | body `{text}`（1–8000 字符）。会话不存在 404；该会话所在 machine 没有在线执行器 409 `电脑端不在线`；已有 queued/running 的 run 409 `这个会话正在运行`；Codex 会话状态是 `running` 时 409。成功返回 `{runId}` |
| POST | `/runs/:id/stop` | 转发给执行器，返回 `{ok:true}` |
| POST | `/approvals/:id` | body `{decision:'allow'` 或 `'deny'}`；不是 pending 返回 409 |
| POST | `/sessions/:id/history` | 请执行器读本地记录并写入 messages（等最多 10 秒，超时 504，执行器不在线 409）。返回新插入的 `{messages}`（和已有消息完全重复的会跳过） |
| GET | `/sessions/:id/messages?limit=100` | 只要 Bearer。`{messages, approvals(pending), run(最近一个)}` |

执行器 WS：`/ws?token=<设备会话 token>&role=agent&machine=<机器名>`。同一账号同一 machine 的新连接会顶掉旧连接（关闭码 4000）；设备被踢 / 退出 / 改密码 / 重置密码后关闭码 4401。

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
ADMIN_TOKEN=devadmin DATABASE_URL=postgres://postgres:dev@localhost:55433/agenthub node src/index.ts
```

首次上线：设好 `ADMIN_TOKEN` 部署后，打开 `https://<域名>/admin`，输入令牌，新建账号，再到桌面端 / 手机端用该邮箱登录。

**升级说明**：0.3.0 的客户端和服务端都要升级。启动时检测到旧结构（`sessions` 没有 `user_id`）会 `DROP` 并重建 `sessions` / `runs` / `messages` / `approvals`（里面只有临时状态数据），旧客户端会收到 401，需要更新并登录。

测试默认连 `postgres://postgres:dev@localhost:55433/agenthub`，可用 `DATABASE_URL` 覆盖。启动时建表用 Postgres advisory lock 串行，多个进程（或并行的测试文件）同时启动不会互相撞。

联调：先用管理页或 `POST /admin/users` 建账号，再 `POST /auth/login` 拿 token。
