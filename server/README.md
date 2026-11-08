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

会话状态包括 `idle/running/waiting/done/aborted/ended/unknown`；`unknown` 表示本机记录缺失，不能确定状态。`/events` 可带 `expectedAt`：仅当当前 `event_at` 与它相等时接受校正，防止旧快照覆盖新事件。Codex 事件的非空 `title` 可更新已有标题，以同步 Codex 显示名称。

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
| GET (WS) | `/ws?token=` | 连上先发 `{type:'snapshot', sessions}`；之后每次变化发 `{type:'session', session, notify}`；服务端每 30 秒发协议层 ping。客户端可发应用层 `{type:'ping'}` 探活，服务端回 `{type:'pong'}`（协议层 ping 在浏览器 / WebView 的 JS 里不可见，判断假连接只能用这一层） |

### 目标与任务（0.5.0）

新增 `goals`、`tasks`、`task_sessions` 表，保留已有数据。以下接口均需登录并按账号隔离；无权访问的目标、任务和会话返回 404。标题去 NUL 并 trim，长度 1–200；备注最多 4000；状态或字段非法返回 400。

| 方法 | 路径 | 请求与返回 |
|---|---|---|
| GET | `/goals`、`/tasks` | `{goals}`、`{tasks}`，任务包含 `sessionIds` |
| POST | `/goals` | `{title, notes?, priority?}` → `{goal}`；优先级 high/medium/low，默认 medium |
| PATCH | `/goals/:id` | `{title?, notes?, status?, priority?}` → `{goal}`；状态 active/done/archived；优先级 high/medium/low |
| DELETE | `/goals/:id` | `{ok:true}`；任务保留，goalId 清空并广播 |
| POST | `/tasks` | `{title, notes?, goalId?, agent?, machine?, cwd?}` → `{task}` |
| PATCH | `/tasks/:id` | 上述字段及 `status?` → `{task}`；状态 todo/doing/review/done，doneAt 随状态写入/清空 |
| DELETE | `/tasks/:id` | `{ok:true}`；关联会话保留 |
| POST | `/tasks/:id/sessions` | `{sessionId}` → `{task}`，重复挂接幂等 |
| DELETE | `/tasks/:id/sessions/:sessionId` | `{task}`；会话清理后仍可取消挂接 |
| POST | `/tasks/:id/start` | `{agent?, machine?, cwd?, text?}` → `{runId, sessionId, task}`；agent 只能是 claude / codex |
| POST | `/tasks/:id/accept` | 验收：`review → done` 的**唯一**入口 → `{task, delivery}`。任务须在 review、检查项全部 pass、关联会话下没有 pending 审批，否则 409 |
| GET | `/tasks/:id/mandate` | `{mode, mandate, stats:{total,wouldAllow,wouldAsk}, delivery}`：冻结的授权范围快照 + 决策统计（observe 下「本来会自动放行 N 条、会问 M 次」）+ 交付物 |
| GET / PUT | `/mandate/settings` | 账号的授权模式 `{mode:'off'\|'observe'\|'auto'}`，默认 off；没有记录等于 off |

开始任务时，body 优先于任务默认设置；没有 machine 且只有一台在线电脑时自动选用它。text 默认备注或标题（1–8000 字符）。离线预检查返回 409 且任务不变。创建运行、临时会话、首条消息、挂接关系和 doing 状态在事务内完成；提交后发送 `mode:'fresh'`。发送失败返回 409，保留 doing 状态和 aborted 临时会话。执行器仍负责目录检查和授权。

目标与任务的 POST/PATCH 均支持 `startAt`、`dueAt`（含时区的 ISO 日期时间或 null）及 `remindStart`、`remindDue`（boolean，默认 true）。返回时间归一化为 UTC；截止时间不得早于开始时间，部分更新也按合并后的时间校验。任务另支持 `checklist: [{id,text,done}]`，最多 100 项，id 唯一且最多 100 字符，text 为 1–500 字符，done 为 boolean；PATCH 替换整个清单，默认空数组。

任务的 `agent` 取值为 `claude` / `codex` / `doubao` / `workbuddy`。豆包和 WorkBuddy 只做状态监听：可以记在任务上用于归类，但 `/tasks/:id/start` 会返回 400，需要在客户端里执行完再用 `/tasks/:id/sessions` 关联会话。

服务端每 15 秒生成已到开始/截止时间且未完成、未归档的提醒。同一事项、提醒种类和时间只生成一条记录。`snapshot.reminders` 包含当前有效且未处理的提醒，实时广播为 `{type:'reminder',reminder:{id,entityType:'task'|'goal',entityId,title,kind:'start'|'due',scheduledAt}}`。`POST /reminders/:id/ack` 标记本账号提醒已处理并广播 `{type:'reminder.acked',id}`；跨账号返回 404。编辑时间或关闭提醒会使旧提醒失效，删除事项级联删除提醒。数据库新增时间/开关列、tasks.checklist 和 entity_reminders，启动时幂等迁移。

临时会话改名时挂接关系跟随迁移，重复挂接合并。关联会话 done：doing → review；关联会话 running：review → doing。任一关联会话完成即触发，todo/done 不自动改变。完成事件来自 `/events` 或执行器 `run.status`；改名后补算当前状态，覆盖完成先于改名的情况。

viewer 的 snapshot 增加 `goals`、`tasks` 数组。新增同账号广播：`{type:'goal',goal}`、`{type:'goal.removed',id}`、`{type:'task',task}`、`{type:'task.removed',id}`；任务对象始终包含 `sessionIds`。旧客户端可忽略这些扩展。CORS 允许 PATCH。

### 远程控制（第二版）

在手机 / 电脑的 AgentHub 里给会话发消息、批授权、停止。电脑端 Rust「执行器」用 WebSocket 连上来，服务端把指令转给它，它在本机接着跑 `claude -p` / `codex app-server`，输出和授权请求再经服务端广播给 UI。

新表（启动时 `CREATE TABLE IF NOT EXISTS`）：`runs`、`messages`（每会话只留最近 200 条）、`approvals`；`runs` / `approvals` 随清理任务一起清 7 天前的。

控制类接口没有单独的密钥，和其它接口一样用设备会话 token；兜底是电脑端「允许手机远程执行」开关 + 每次授权都要在手机上确认（禁止执行的项目目录黑名单可选，留空不限制）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/control/status` | `{agents}`，本账号在线执行器的机器名 |
| POST | `/sessions/:id/messages` | body `{text}`（1–8000 字符）。会话不存在 404；该会话所在 machine 没有在线执行器 409 `电脑端不在线`；已有 queued/running 的 run 409 `这个会话正在运行`；Codex 会话状态是 `running` 时 409。成功返回 `{runId}` |
| POST | `/sessions/:id/spawn` | body `{mode:'fork'或'fresh', text}`（text 1–8000 字符）。基于已有会话新开：fork 带上下文分叉，fresh 同目录从零开始。会话不存在 404；执行器不在线 409 `电脑端不在线`；**不**检查原会话是否在运行。成功建一个临时会话 `<agent>:pending-<runId>`（state running，title 取首条消息前 80 字）并返回 `{runId, sessionId}`，同时广播 `session` / `run` / `message` |
| POST | `/runs/:id/stop` | 转发给执行器，返回 `{ok:true}` |
| POST | `/approvals/:id` | body `{decision:'allow'` 或 `'deny'}`；不是 pending 返回 409 |
| POST | `/sessions/:id/history` | 请执行器读本地记录并写入 messages（等最多 10 秒，超时 504，执行器不在线 409）。返回新插入的 `{messages}`（和已有消息完全重复的会跳过） |
| GET | `/sessions/:id/messages?limit=100` | 只要 Bearer。`{messages, approvals(pending), run(最近一个)}` |

执行器 WS：`/ws?token=<设备会话 token>&role=agent&machine=<机器名>`。同一账号同一 machine 的新连接会顶掉旧连接（关闭码 4000）；设备被踢 / 退出 / 改密码 / 重置密码后关闭码 4401。

| 方向 | 消息 |
|---|---|
| 服务端 → 执行器 | `run.start {runId, sessionId, agent, sessionKey, cwd, text, mode}`（`mode` 为 `resume`（`/messages`）/ `fork` / `fresh`（`/spawn`）；缺省按 resume；fork / fresh 时 `sessionId` 是临时 id、`sessionKey` 是原会话的 sid）、`run.stop {runId}`、`approval.created {localId, approvalId}`、`approval.decide {approvalId, decision}`、`history.request {requestId, agent, sessionKey, cwd}` |
| 执行器 → 服务端 | `run.status {runId, status, error?}`（status 为 running / done / failed / stopped）、`run.message {runId, role, text}`（role 为 assistant / tool / system）、`run.approval {runId, localId, tool, detail}`、`run.approvalExpired {runId, approvalId}`、`run.session {runId, sessionKey}`（fork / fresh 拿到真实 id 后只发一次；`sessionKey` 须匹配 `^[A-Za-z0-9_-]{1,100}$`，run 必须属于该执行器且仍是临时会话，否则忽略）、`history.result {requestId, messages:[{role,text}], error?}` |

执行器断线（或被顶掉）时，它名下 queued/running 的 run 标 `failed`（`电脑端断开`），pending 授权标 `expired`。

授权在执行器等待 30 分钟超时后，立即上报 `run.approvalExpired`。服务端核对机器及运行归属，仅将 pending 授权改为 expired 并广播，运行可继续；重复通知无副作用。此修复需要同时更新桌面执行器和服务端。

`run.session` 处理：在一个事务里把临时会话改名为 `<agent>:<sessionKey>`（`runs` / `messages` / `approvals` 的 session_id 一起改）；真实 id 已存在则保留真实行（标题为空时补上临时行的标题）并删除临时行；随后广播 `removed`（临时 id）、`session`（真实行，notify=false）、`session.renamed {from, to}` 和该 run 的最新状态。拿到真实 id 之前 run 失败 / 停止 / 执行器断线，临时会话标 `aborted`（summary 为错误信息，notify=true）。

viewer 的 `/ws` 新增广播：`{type:'run', run}`、`{type:'message', message}`、`{type:'approval', approval(带 project), notify}`（`notify` 只在新建 pending 时为 true）、`{type:'agents', agents}`；`snapshot` 里多带 `agents` 和 pending 的 `approvals`。

状态：`idle | running | waiting | done | aborted | ended`。会话 id 形如 `claude:<sessionId>` / `codex:<sessionId>`。

`acked` 规则：变成 `running` 自动置 true；变成 `waiting/done/aborted`（非 quiet）置 false 并 `notify=true` 提醒一次；任一端「已处理」置 true。服务端每小时清理 7 天没更新的会话。

## 回复操作协议

- `messages` 新增 `source_id`、`branch_point`；历史同步与实时消息保留原始回复标识。返回的消息可含 `sourceId`、`branchPoint` 和 `rating`（`up/down/null`）。评价存独立 `message_feedback` 表，按账号、会话及原始消息标识隔离，历史重建编号后仍保留。
- `PATCH /sessions/:id/messages/:messageId/feedback`，body `{rating:'up'|'down'|null}`。只允许评价自己的助手回复；无原始标识时 409，其他账号/会话的消息返回 404。成功返回 `{message}` 并发送同 id 的 `message` 广播，客户端应更新已有行。
- `POST /sessions/:id/spawn` 在 `mode:'fork'` 时可带 `messageId`。服务端从该回复读取 `branchPoint`，不接受浏览器直接提供的节点；拒绝无节点、非助手回复和运行中会话。旧版不带 `messageId` 的整会话分叉协议保留兼容，界面统一使用逐条回复分支。
- 执行器 WS 握手增加 `capabilities=reply-branch-v1`。指定回复分支要求该能力，缺少时 409；`run.start` 增加 `branchPoint`。执行器再次从原会话验证节点后，Claude 用 `--resume-session-at <uuid> --fork-session`，Codex 用 `thread/fork.lastTurnId`。
- 历史记录缺少 UUID、完整轮次信息，或旧 CLI 不支持指定节点时明确提示，不能静默分叉全部上下文。

### 一次授权（Mandate）

确认任务单（`POST /proposals/:id/confirm`）或开工（`POST /tasks/:id/start`、项目经理自动派发）= **签署 Mandate**：把任务的执行边界写成不可变快照（`task_mandates`，append-only，同一任务 `version` 递增、新任务从 1 开始，附 `ruleset_version` = `referee.ts` 的 `RULESET_VERSION`），并置 `tasks.mandate_frozen_at`。

- 冻结后 `PATCH /tasks/:id` 改 `constraints` 返回 409「范围已冻结，请新开任务」（原样回传不算修改）；要换范围只能新开任务。
- 有 mandate 或关联过会话的任务，`PATCH status=done` 返回 409，必须经 `POST /tasks/:id/accept`；既没 mandate 也没关联会话的纯人工任务仍可直接完成。
- `MandateScope` = 任务边界（`paths` / `net` / `push` / `scripts` / `note`）+ `commands`（read / test / build / write，空 = 沿用规则表）、`allowedTools`、`maxRuntimeMin`（默认 30，**本期只存储并下发，执行器不强制超时**）。`net` / `push` / `scripts` 默认 false，后续消息不会自动打开。
- `mandate_mode`（每账号，默认 `off`）：
  - `off`：与没有这个功能时一致，不判定、不落库。
  - `observe`：按冻结范围判每条审批，只写 `mandate_decisions`（`would_allow` / `in_scope` / `rule` / `tier`，保留 30 天），**审批流程完全不变**；`run.start` 不带 mandate。
  - `auto`：执行器声明了 `mandate-v1` 且任务有冻结 Mandate 时，范围内的审批不建 `approvals` 行、不插 `approval` 消息、不广播、不通知，直接回 `approval.decide allow`；范围外 / danger / unknown 照旧建审批行并标 `in_scope=false`，一律交人（不走项目经理代批，不产出 deny）。每小时自动放行数受项目经理的代批上限约束，超了全部交人。老执行器（无 `mandate-v1`）自动降级为 observe 行为。
- `run.start` 在 auto 档且执行器有 `mandate-v1` 时带 `mandate: { id, version, mode: 'auto', scope, rulesetVersion }`（`startSession`、`resumeTaskSession` 发送时现取；排队投递最终也走这两个函数，所以离线入队的任务上线后同样带）。老执行器忽略该字段。
- 执行器握手增加 `capabilities=mandate-v1`。桌面端据 `mandate` 把 Claude 改成 `--permission-mode acceptEdits`（声明了目录时保持 `default`，写只在目录内放行）+ `--allowedTools` 白名单，Codex 保留 `workspace-write` 沙箱（`net` 对应 `networkAccess`）、`approvalPolicy` 仍是 `on-request`。**任何路径都不默认 `bypassPermissions` / `danger-full-access`。目录声明只是提示，不是安全隔离**：执行器以用户自己的 OS 账户运行，真正的约束是 CLI 白名单与 sandbox。
- 任务进入 review 时写 `task_deliveries`（重跑再进 review 覆盖未验收的快照，已验收的不动）；检查项被打回时，对签署过 Mandate 的任务会额外生成一条待确认的任务单提案（带打回原因与原范围摘要），原任务保持 review，确认提案 = 新任务 + 新 Mandate。
- 派活看板：`mandate_mode ≠ off` 时只保留需要人的项（等审批、卡住、离线排队、待验收）。

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
