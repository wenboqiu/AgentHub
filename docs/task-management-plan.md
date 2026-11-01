# AgentHub：目标 + 任务 + 关联会话（任务管理第一版）

> 记录日期：2026-11-01
> 状态：功能已实现；自动测试、双端构建与 Codex 完成流程通过。Haiku 正常回复受额度限制，精确尺寸截图尚未完成，详见 `docs/task-management-verification.md`，不标记全部验证通过。
> 背景：0.4.1 之前只有会话监控、手机发消息、新开会话。用户要围绕它做任务管理（第二版的遗留项），并希望最终支持**通用**的任务和目标管理（不只是 agent 的活）。本文是自包含的实现计划，交给子代理实现时不依赖任何对话上下文。

## 目标

- 账号下有「目标」和「任务」：目标下面挂任务；任务也可以不属于任何目标。任务可以是普通待办，也可以挂 agent 会话。
- 任务状态：待办 → 进行中 → 待验收 → 完成。
- 任务里点「开始」：在指定机器的指定项目目录新开一个 Claude / Codex 会话，任务描述作为第一条消息，任务自动变「进行中」，新会话自动挂到任务上。一个任务可以挂多个会话，也可以手动把已有会话挂上来 / 取消挂接。
- 挂在「进行中」任务上的会话跑完（变成已完成）→ 任务自动变「待验收」；会话又开始跑 → 任务回到「进行中」。
- 目标显示进度（已完成任务数 / 总任务数）。
- 界面：顶部三个标签页「会话 / 任务 / 目标」，会话标签就是现有的会话列表，原样保留。手机和电脑一样。
- 数据存服务端，跟账号走，手机和电脑实时同步（WebSocket）。

不做（留给以后）：到期日和提醒、重复任务、子任务、标签、拖拽看板、宽窗口左右分栏。

## 背景事实

### 当前代码（仓库 `D:\Work2\AgentHub`，基线提交 `c1289d5` 之后再加上未提交的宽屏样式改动；版本 0.4.1）
- 服务端 `server/src/`（Node 22 直接跑 `.ts`，只能用可擦除 TS 语法，本地 import 带 `.ts` 后缀；Fastify + `@fastify/websocket` + pg）：
  - `db.ts`：启动时 `CREATE TABLE IF NOT EXISTS`（有 advisory lock 串行建表，新表照这个写法加）。所有表带 `user_id bigint not null references users(id) on delete cascade`。`sessions` 主键 `(user_id, id)`，会话 id 形如 `claude:<sid>` / `codex:<sid>`；新开会话期间用临时 id `<agent>:pending-<runId>`，拿到真实 id 后由 `renamePendingSession(pool, userId, from, to)`（约 :273，事务里改名/合并，并且 `for (const t of ['runs','messages','approvals']) UPDATE ... SET session_id`）改成真实 id。`createPendingSession(pool, userId, pendingId, sourceSession, title)` 建临时会话（参数是一个源会话，取它的 agent/machine/cwd/project）。`applyEvent`（约 :188）处理 hook/rollout 上报，返回 `{session, notify}`。`removeSession`（约 :240）。
  - `routes.ts`：`registerRoutes(app, pool, opts)`。`serial()` 串行段、`broadcast(userId, msg)`（只发给同账号的 viewer）、`pushSession/pushRun/pushMessage/pushApproval`。鉴权钩子给 `req.userId`。已有接口：`POST /events`（约 :196，对每条事件 `applyEvent` 后 `pushSession`）、`GET /sessions`、`POST /sessions/:id/spawn`（约 :290，要求一个源会话，建临时会话 + run + user 消息，向执行器发 `run.start {runId, sessionId, agent, sessionKey, cwd, text, mode}`，发送失败则 run 标 failed 并 `abortPending`）、`POST /sessions/:id/messages`、执行器消息 `run.status`（约 :406，终态时失败/停止会 `abortPending`）、`run.session`（约 :420，调用 `renamePendingSession`）。执行器在线表 `executors`，key 为 `execKey(userId, machine)`，`agentList(userId)` 返回该账号在线机器名列表。WS 连上先发 `{type:'snapshot', sessions, agents, approvals}`。
  - 测试：`server/test/{api,remote,accounts,spawn}.test.ts` + `helpers.ts`（建用户/登录），连本地 Docker PG `postgres://postgres:dev@localhost:55433/agenthub`（容器 `agenthub-pg`），共 39 个。
- 桌面执行器 `src-tauri/src/runner.rs`：`Mode { Resume, Fork, Fresh }`；Fresh 模式不需要 sessionKey（`valid_key` 只对 Resume/Fork 检查），cwd 必须在电脑端设置的「允许的项目目录」白名单里，否则 run 失败「项目目录不在允许列表里」。Claude Fresh = 不带 `--resume`；Codex Fresh = `thread/start`。拿到新会话 id 后执行器发 `run.session` 给服务端。**这次不用改桌面端和 Android 原生代码**；开始任务时服务端向执行器发 `run.start` 的 `mode:'fresh'`、`sessionKey:''`。实现时先确认执行器在 `sessionKey` 为空串时对 Fresh 模式确实不报错（看 `execute()` / `precheck`），如果会报错，就把服务端发的 `sessionKey` 改成任意合法占位（如 `'task'`）——但要在 Fresh 下被忽略，并把这个确认写进报告。
- 前端 `src/`（React 19 + Vite，桌面和 Android 共用）：
  - `App.tsx`：状态 `view: "list" | "settings"`、`openId`（打开的会话）、`sessions: Map`、`approvals: Map`、`agents`；WS 的 `connect(url, token, handlers)` handlers 在 App 里（`onSnapshot/onSession/onRemoved/onRenamed/onRun/onMessage/onApproval/onAgents/onAuthExpired`）；会话详情用 `switchSession`，Android 返回键靠 `history.pushState` + `popstate`（进入详情压一层历史，返回退回列表；新开会话跳转用 `replaceState`）。列表分「待处理 / 运行中 / 其它」三组，`Row` 组件显示会话，点击进入详情。
  - `lib/api.ts`：`Api` 类（`call()` 带 Bearer，401 抛 `AuthError` 并触发 `onAuthError`）、`connect()`（自动重连、4401 不再重连）、`Handlers` 类型、`Session`/`Message`/`Run`/`Approval` 类型。
  - `SessionView.tsx`：会话详情（消息、授权卡片、发消息、新开会话面板、在终端打开）。
  - `styles.css`：深浅色自适应；`.app` 现在铺满窗口（窄屏 12px 边距、宽屏到 32px），设置页 `.app.settings` 限制 640px 居中，聊天气泡最宽 960px。新页面沿用这些样式。
- 版本号文件：`package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`。
- 另有一份未实现的计划 `.claude/plans/20261101-agenthub-fork-at-reply.md`（从任意回答分叉，原定 0.5.0）。**本计划先做，用 0.5.0；那份计划以后实现时版本号改 0.6.0。不要动它。**

### 用户已定
- 第一版范围：目标 + 任务 + 关联会话（不含到期日/提醒/重复）。
- 界面：顶部三个标签页。
- 先做任务管理，再做「从任意回答分叉」。
- 通用任务：任务不一定挂 agent 会话，普通待办也要能用。

## 设计

### 数据模型（服务端，新表，启动时建；**不要 DROP 任何已有表**）
```sql
goals(
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  title text not null,                 -- 1–200 字符
  notes text not null default '',      -- ≤4000 字符
  status text not null default 'active', -- active | done | archived
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)
tasks(
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  goal_id bigint references goals(id) on delete set null,
  title text not null,                 -- 1–200 字符
  notes text not null default '',      -- ≤4000 字符，也是「开始」时发给 agent 的第一条消息的默认内容
  status text not null default 'todo', -- todo | doing | review | done
  agent text,                          -- claude | codex | null（普通待办）
  machine text,                        -- 默认在哪台电脑开会话，null 表示开始时选
  cwd text,                            -- 默认项目目录，null 表示开始时填
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  done_at timestamptz
)
task_sessions(
  task_id bigint not null references tasks(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  session_id text not null,            -- 和 sessions.id 一致，如 'claude:<sid>'；会话被清理后链接仍保留
  created_at timestamptz not null default now(),
  primary key (task_id, session_id)
)
```
索引：`tasks(user_id, status)`、`tasks(user_id, goal_id)`、`task_sessions(user_id, session_id)`。

文本清洗：标题、备注去 NUL（`\0`）、`trim`；不合法返回 400 中文错误。

### 服务端接口（都要登录，全部按 `req.userId` 隔离；查不到一律 404）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/goals`、`/tasks` | 列表。task 对象带 `sessionIds: string[]` |
| POST | `/goals` | `{title, notes?}` |
| PATCH | `/goals/:id` | `{title?, notes?, status?}`（status 为 active/done/archived） |
| DELETE | `/goals/:id` | 删目标；下属任务保留，`goal_id` 置空 |
| POST | `/tasks` | `{title, notes?, goalId?, agent?, machine?, cwd?}`；`goalId` 必须属于自己的目标；`agent` 只能 claude/codex/空 |
| PATCH | `/tasks/:id` | 上面字段 + `status?`。status 改成 done 时写 `done_at`，改离 done 时清空 |
| DELETE | `/tasks/:id` | 删任务（挂接关系级联删，会话本身不动） |
| POST | `/tasks/:id/sessions` | `{sessionId}` 挂接已有会话，会话必须属于自己（`sessions` 表里有，含临时会话）；已挂过幂等返回成功 |
| DELETE | `/tasks/:id/sessions/:sessionId` | 取消挂接 |
| POST | `/tasks/:id/start` | `{agent?, machine?, cwd?, text?}`：开始任务，见下 |

**开始任务 `/tasks/:id/start`**（在 `serial()` 里，逻辑照 `POST /sessions/:id/spawn`，抽公共函数复用，不要复制粘贴一大段）：
1. 取参数：`agent`（body 优先，其次任务上的，都没有 → 400「请选择 Claude 或 Codex」）；`cwd`（同理，没有 → 400「请填写项目目录」）；`machine`（body → 任务上 → 在线执行器只有一台就用它 → 否则 400「请选择电脑」）；`text`（body → 任务 `notes` → 任务标题，去 NUL，1–8000 字符）。
2. 该账号该机器没有在线执行器 → 409「电脑端不在线」。
3. 建临时会话：`id = '<agent>:pending-<runId>'`，agent / machine / cwd 来自上面，`project` 取 cwd 最后一段（和现有 `projectOf` 一致），`title` = 任务标题。`createPendingSession` 目前要传源会话，改成接受一个 `{agent, machine, cwd}` 对象（保持现有 spawn 调用不变，行为不变）。
4. 在事务内建临时会话、run、user 消息，并把临时会话挂到任务（`task_sessions`），任务 `status` 改成 `doing`（`todo`/`review`/`done` 都改成 doing），清空 `done_at`。
5. 提交后广播 `session`/`run`/`message`/`task`，向执行器发 `run.start {runId, sessionId: 临时id, agent, sessionKey: '', cwd, text, mode:'fresh'}`；发送失败的处理同 spawn（run failed、`abortPending`、409），保留挂接关系和 doing 状态。参数校验或离线预检查失败不改任务。
6. 返回 `{runId, sessionId: 临时id, task}`。
7. 如果这次运行后来失败（会话变已中断），任务保持「进行中」，用户看到失败的会话后可以再点「开始」重试——不要自动回退状态。

**会话改名要带上挂接关系**：`renamePendingSession` 里，除了 `runs/messages/approvals`，还要把 `task_sessions` 里 `session_id = from` 的行改成 `to`；如果 `(task_id, to)` 已存在（hook 抢先上报了真实会话且已被挂过），就删掉 from 那行而不是冲突报错。改完广播受影响的任务（`task` 消息）。

**自动状态流转**（只改这两种，其它状态绝不自动改）：
- 挂接的会话变成 `done`，且任务当前是 `doing` → 任务改为 `review`。触发点：`applyEvent` 返回会话状态为 `done` 之后（`POST /events` 里 `pushSession` 旁边）；以及执行器 `run.status = done` 时对应会话（`getRun` 的 `sessionId`，如果还是临时 id 就跳过，等改名后会话自己的 `done` 事件会触发）。
- 挂接的会话变成 `running`，且任务当前是 `review` → 任务改回 `doing`。
- 一个任务挂了多个会话时：只要任一挂接会话变 done 且任务是 doing 就进 review（不要求全部完成）。
- 流转后广播 `task`。把这个逻辑做成一个函数 `syncTaskForSession(pool, userId, sessionId, sessionState)` 返回被改的任务列表，方便单测。
- 会话改名后按真实会话当前状态和该 run 状态补算任务状态（run 已 done 时优先按 done），覆盖完成事件先于改名到达的情况；事件写入和任务流转放在同一个 serial 段内。

**WebSocket 广播**（只发给同账号 viewer）：`{type:'goal', goal}`、`{type:'goal.removed', id}`、`{type:'task', task}`（task 带 `sessionIds`）、`{type:'task.removed', id}`。snapshot 里增加 `goals: Goal[]`、`tasks: Task[]`。

**类型**（服务端和前端各定义一份，字段名驼峰）：
```ts
Goal = { id: number; title: string; notes: string; status: 'active'|'done'|'archived'; createdAt: string; updatedAt: string }
Task = { id: number; goalId: number | null; title: string; notes: string; status: 'todo'|'doing'|'review'|'done';
         agent: 'claude'|'codex'|null; machine: string | null; cwd: string | null; sessionIds: string[];
         createdAt: string; updatedAt: string; doneAt: string | null }
```

### 前端
1. `lib/api.ts`：类型 + `Api` 方法 `goals/tasks/createGoal/updateGoal/deleteGoal/createTask/updateTask/deleteTask/linkSession/unlinkSession/startTask`；`Handlers` 增加 `onGoal/onGoalRemoved/onTask/onTaskRemoved`，`onSnapshot` 增加 goals/tasks 参数；`connect()` 解析新消息。
2. `App.tsx`：
   - 状态：`goals: Map<number, Goal>`、`tasks: Map<number, Task>`、`tab: "sessions" | "tasks" | "goals"`、`openTaskId`、`openGoalId`。WS 处理新消息；退出登录 / 登录过期时清空。
   - 顶部在标题栏下面加标签栏（会话 / 任务 / 目标），当前标签高亮；任务标签上显示「待验收」任务数徽标（有才显示）。切标签不影响各自已有状态。
   - 会话标签：现有列表完全不变。
   - 打开任务详情 / 目标详情 / 会话详情的导航沿用 `history.pushState`/`popstate` 模式（Android 返回键退回上一层；从任务详情点关联会话进入会话详情，返回回到任务详情）。
3. 新组件 `src/TasksPanel.tsx`（任务标签页内容）：顶部一行输入框「新任务…」回车快速新建（标题即可）；任务按「进行中 / 待验收 / 待办 / 已完成（默认折叠）」分组；每行显示标题、所属目标名、挂接会话数、agent 标记；点行进入任务详情。行上有快捷操作：待办的「开始」不放在列表里（避免误触），只在详情里。
4. 新组件 `src/TaskView.tsx`（任务详情页）：
   - 可编辑：标题、备注（多行）、状态（下拉四选一）、所属目标（下拉含「无」）、agent（无 / Claude / Codex）、电脑（下拉：在线机器 + 手填的已存值 + 「开始时选」）、项目目录（文本框）。改动在失焦或点「保存」时提交 `updateTask`，失败显示错误。
   - 「开始」按钮（设置了 agent 和目录且电脑在线时可用；不可用时在按钮旁说明原因：没选 agent / 没填目录 / 电脑不在线）：弹出一个小确认面板，可改第一条消息（默认任务备注，空则标题）→ 调 `startTask` → 成功后跳到返回的临时会话详情（用现有 `switchSession`）。已经有挂接会话的任务，按钮文字变成「再开一个会话」。
   - 挂接的会话列表：每项显示 agent、project、状态、更新时间，点击进入会话详情；每项有「取消挂接」。如果会话已被清理（不在 sessions 里），显示「会话已清理」且只有「取消挂接」。
   - 「关联已有会话」：弹出选择面板，列出当前账号的会话（排除已挂接的，最近更新的在前，最多 30 条，带 project / title / agent），点一个就 `linkSession`。
   - 「删除任务」（`confirm` 二次确认）。
5. 新组件 `src/GoalsPanel.tsx` 和 `src/GoalView.tsx`：
   - 目标列表：标题、进度条和「完成数/总数」（客户端用任务数据算：该目标下 `done` 的任务数 / 该目标下任务总数，没有任务显示「还没有任务」）；顶部输入框快速新建目标；已归档的目标默认折叠在底部。
   - 目标详情：可编辑标题、备注、状态（进行中/已完成/已归档）；下面列出该目标下的任务（点进入任务详情），顶部有「在这个目标下新建任务」输入框；「删除目标」（二次确认，说明任务会保留）。
6. `SessionView.tsx`：在头部下面显示这个会话挂接的任务（小标签，点击进入任务详情）；加一个「关联到任务」按钮：弹面板列出未完成的任务（`todo/doing/review`）+「新建任务并关联」（输入标题即可，建完自动挂接）。临时会话（id 含 `:pending-`）也允许关联。
7. `styles.css`：标签栏、任务/目标行、进度条、分组标题、详情页表单、选择面板；沿用现有变量和深浅色；手机宽度（360px）和宽窗口（1400px）都要正常。
8. 所有新增的用户可见文案用中文。

### 文档和版本
- 版本号 `0.5.0`（5 个版本号文件）。
- `README.md`：功能列表增加任务管理；`server/README.md`：新接口、WS 新消息、自动流转规则。
- 在 `docs/` 里本文件顶部加一行「状态：已实现（0.5.0）」——**只在全部验证通过后**再加。

## 涉及文件

| 文件（相对 `D:\Work2\AgentHub`） | 改动 |
|---|---|
| `server/src/db.ts` | 三张新表和索引；goals/tasks/task_sessions 的增删改查；`syncTaskForSession`；`createPendingSession` 改成接受 `{agent, machine, cwd}`；`renamePendingSession` 带上 `task_sessions` |
| `server/src/routes.ts` | 新接口、`/tasks/:id/start`（抽出与 spawn 共用的建临时会话+run+发 `run.start` 的函数）、自动流转触发点、新广播、snapshot 增加 goals/tasks |
| `server/src/tasks.ts`（新） | 将目标与任务的类型、建表、校验、CRUD 和自动流转集中在独立模块；`db.ts` 在既有迁移锁内调用新表迁移 |
| `server/src/index.ts` | 允许 PATCH 的 CORS 预检，并返回任务字段校验的中文错误 |
| `server/tools/task-acceptance.ts`（新） | 隔离本地桌面验收夹具，备份/恢复配置、启动测试程序、记录状态并清理本地测试账号 |
| `server/tools/task-acceptance-cleanup.ts`（新） | 校验唯一临时项目路径，归档本次 Codex 线程并清理本次 Claude 会话目录 |
| `src/lib/taskSync.ts`、`test/taskSync.test.ts`（新） | 防止慢 HTTP 响应覆盖较新的任务/目标广播，覆盖同毫秒事件 |
| `server/test/tasks.test.ts`（新） | 见验证 |
| `src/lib/api.ts`、`src/App.tsx`、`src/SessionView.tsx`、`src/styles.css` | 见前端 |
| `src/TasksPanel.tsx`、`src/TaskView.tsx`、`src/GoalsPanel.tsx`、`src/GoalView.tsx`（新） | 见前端 |
| `README.md`、`server/README.md`、5 个版本号文件、本文件 | 见上 |

不改：`src-tauri/src/*`（桌面 Rust）、Android Kotlin、账号体系、状态采集、hook、托盘。

## 实现步骤
1. 服务端：表和类型 → CRUD 接口 → 挂接 → 公共函数抽取 + `/tasks/:id/start` → `renamePendingSession` 带挂接 → 自动流转 → 广播和 snapshot → 测试全部跑通（原有 39 个也要继续通过）。
2. 前端：api/类型/handlers → App 状态和标签页 → 任务列表和详情 → 目标列表和详情 → SessionView 挂接入口 → 样式。
3. 文档和版本号。
4. 按「验证」跑一遍，再在本文件顶部标记「已实现」。

## 已经排除的方案

| 方案 | 为什么不用 |
|---|---|
| 像 Bookshelf 那样客户端本地库 + 记录级 LWW 同步 | AgentHub 的客户端总是在线连着服务端（WebSocket 实时），服务端为准更简单；离线编辑不是需求 |
| 把任务存进现有 `sessions` 表 / 复用会话模型 | 任务不一定有会话，生命周期和字段完全不同，混在一起会污染会话逻辑 |
| 任务只能挂一个会话 | 失败重试、分叉、Codex 和 Claude 各跑一遍都很常见，要支持多个 |
| 全部挂接会话都完成才进「待验收」 | 用户说「会话完成后任务自动进待验收」，任一完成就提醒验收更符合使用习惯；可手动改回 |
| 会话失败时自动把任务退回「待办」 | 会让任务状态来回跳，用户会困惑；保持「进行中」，由用户决定 |
| 自动从会话生成任务 | 现有会话很多是随手聊的，自动生成会产生大量噪音 |
| 到期日、提醒、重复任务、子任务、标签、拖拽看板 | 不在第一版范围（用户选的范围） |
| 宽窗口左右分栏 | 用户选了标签页方案；分栏以后单独做 |
| 新开独立的「任务服务」或新的 WebSocket | 复用现有账号体系、连接和广播，没有必要拆 |

## 环境坑
- **线上服务端** `https://agenthub.wondergarden.top` 是用户在用的生产环境：不要访问、不要部署。只用本地服务端：`docker start agenthub-pg`，`cd server && ADMIN_TOKEN=devadmin DATABASE_URL=postgres://postgres:dev@localhost:55433/agenthub PORT=3000 node src/index.ts`，用 `/admin/users`（`Authorization: Bearer devadmin`）建测试账号。本地库里有历史测试数据和旧 schema，保持不动。
- **已安装的 AgentHub 0.4.1 正在运行**（`%LOCALAPPDATA%\AgentHub\agenthub.exe`，占 127.0.0.1:47821，已登录线上账号）。开发版和已安装版**共用** `%APPDATA%\com.wenbo.agenthub\config.json`。端到端前：备份该文件 → `taskkill /IM agenthub.exe /F` → 写入只指向本地服务端的测试配置（`serverUrl:"http://127.0.0.1:3000"`、`token:""`、`machine:"E2E-PC"`、`remoteEnabled:true`、`allowedRoots` 只填一个 `%TEMP%` 下的临时目录）→ 启动 `src-tauri\target\release\agenthub.exe` 并用 CDP 在界面登录本地测试账号。测完：结束测试进程 → 把备份原样拷回（`cmp` 一致）→ `"%LOCALAPPDATA%\AgentHub\agenthub.exe" --silent` 启动并确认 47821 在监听 → 停掉本地服务端。
- **任何 `claude -p` 都会触发 hook 并上报到 127.0.0.1:47821**：跑之前一定先停掉已安装版并换成测试配置，否则测试会话会被报到用户的线上账号。
- 只用 `%TEMP%` 下新建的临时目录和临时会话；Claude 测试一律 `--model haiku`（仅测试命令里，产品代码不指定模型），消息要求「只回复 XX」。Codex 测试线程用完 `thread/archive`（Desktop 自带 codex.exe：`%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`）。
- 磁盘：D 盘曾被 Rust 编译缓存占满过。遇到 `No space left on device` 就**停下**，在报告里说明，不要自己删目录。
- Node 22 只能用可擦除 TS 语法，本地 import 带 `.ts`。写含 `\0` 的源码用 Edit 工具（不要用 Python 字符串替换，会写进真正的 NUL 字节）。用户环境有 `HTTP_PROXY`，curl 测本地加 `--noproxy '*'`（带引号）。
- 桌面 UI 自动化：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333` 启动后用原生 CDP（Node `WebSocket` 连 `http://127.0.0.1:9333/json` 的 `webSocketDebuggerUrl`，`Runtime.evaluate`；React 受控输入框用原生 value setter + `input` 事件；截图用 `Page.captureScreenshot`，可用 `Emulation.setDeviceMetricsOverride` 切换成 400×800 看手机宽度、1400×800 看宽窗口）。不要用 playwright 的 connectOverCDP。测完不带该环境变量重启，不留调试端口。
- Android 构建：`export ANDROID_HOME='D:/Android/SDK'; export NDK_HOME='D:/Android/SDK/ndk/28.2.13676358'`，结束 `src-tauri/gen/android/gradlew --stop`。**不要安装到手机/平板**。
- 前端改动要打进安装包：改完 `npm run build` 后 `npm run tauri build`；验证本次构建的测试程序窗口里确实是新界面。原安装版只在测试结束后原样恢复，不覆盖安装。

## 验证

```bash
docker start agenthub-pg
cd /d/Work2/AgentHub/server && npm run check && npm test
cd /d/Work2/AgentHub && node --test test/*.test.ts && npm run build
cd /d/Work2/AgentHub/src-tauri && cargo test
cd /d/Work2/AgentHub && npm run tauri build
export ANDROID_HOME='D:/Android/SDK'; export NDK_HOME='D:/Android/SDK/ndk/28.2.13676358'
cd /d/Work2/AgentHub && npm run tauri android build -- --apk --target aarch64
src-tauri/gen/android/gradlew --stop
```

服务端测试（新文件 `server/test/tasks.test.ts`，原有 39 个继续通过）至少覆盖：
- 目标和任务的增删改查；字段校验（标题为空/超长 400、`agent` 非法 400、`goalId` 不属于自己 400/404、状态非法 400）；`done_at` 随状态写入/清空；删目标后任务保留且 `goalId` 为 null。
- **隔离**：账号 A 看不到、改不了、删不了 B 的目标/任务（404）；A 不能把 B 的会话挂到自己的任务上；WS 广播只到同账号 viewer；snapshot 只含本账号数据。
- 挂接：挂接/取消挂接；重复挂接幂等；挂接不存在的会话 404；任务返回的 `sessionIds` 正确。
- `/tasks/:id/start`：缺 agent/cwd/machine 的各种 400；执行器不在线 409；成功时执行器收到的 `run.start` 是 `mode:'fresh'`、cwd/agent 正确、`text` 取值优先级（body > 备注 > 标题）正确；任务变 `doing` 且挂上临时会话；执行器发 `run.session` 后挂接关系改成真实会话 id（含「真实会话已被挂过」不冲突）；发送失败时返回 409 且任务状态符合设计（失败也已是 doing，临时会话 aborted）。
- **自动流转**：doing + 挂接会话 done → review（`/events` 上报 done，以及执行器 `run.status done` 两条路径）；review + 会话 running → doing；todo/done 状态的任务不受影响；多会话任一 done 即 review；`syncTaskForSession` 纯函数/数据库函数的直接测试。
- 迁移：在只有旧表结构的 schema（临时 schema + `search_path`，参考 `server/tools/android-acceptance.ts`）里启动应用，新表建出且已有表数据不丢。

前端：`npm run build` 通过；`node --test test/*.test.ts` 通过（如果新增了纯函数，例如按状态分组、目标进度计算，放进 `src/lib/` 并加测试）。

端到端（本地服务端 + 测试账号，按「环境坑」处理已安装版和配置）：
1. 桌面窗口里出现「会话 / 任务 / 目标」三个标签，会话标签内容和以前一致。
2. 新建目标「测试目标」，在它下面新建任务「测试任务」（备注「只回复 OK」，agent=Claude，目录=临时目录，电脑=E2E-PC）→ 点「开始」→ 跳到新会话，会话里有 user 消息，任务变「进行中」，任务详情里能看到这个挂接会话（临时 id 改成真实 id 后仍然挂着）。
3. 会话跑完（haiku 回复 OK）→ 任务自动变「待验收」，任务标签上的徽标显示 1；手动把状态改成「完成」→ 目标进度变成 1/1。
4. 用手机宽度（400×800）和宽窗口（1400×800）各截图检查三个标签页和任务详情，布局不溢出、不重叠。
5. 通过 REST 用第二个账号访问第一个账号的任务 id → 404。
6. 收尾：恢复 `config.json`（`cmp` 一致）、重启已安装版并确认 47821 在监听、9333 无监听、本地服务端停止、临时会话和 Codex 线程（如果用了）清理。

通过标准：命令全部退出码 0、测试全绿；产出 `AgentHub_0.5.0_x64-setup.exe` 和 Android release APK；端到端 1–5 与描述一致。做不到的如实贴原始输出。

## 边界
- 不提交、不 push、不部署，不访问线上服务端。
- 不安装到手机/平板，不覆盖安装用户电脑上的 AgentHub（只停掉再原样启动已安装版）。
- 不碰用户真实的 Claude / Codex 会话，不改 `~/.claude/settings.json`、`~/.codex/config.toml`。
- 不改桌面 Rust、Android 原生代码、账号体系、状态采集、hook、托盘，不顺手重构既有会话列表和详情的行为（除本计划列出的新增入口）。
- 不做到期日/提醒/重复/子任务/标签/拖拽/宽窗口分栏。
- 不动 `.claude/plans/20261101-agenthub-fork-at-reply.md`。
- 不动用户已有的 Docker 容器（只用 `agenthub-pg`）。

## 计划没覆盖的情况怎么办
- 现有代码结构或字段与本文描述不一致：以实际代码为准，在报告里说明。
- 拿不准的产品决策：选更安全、对用户现有环境零侵入的做法，在报告「我自己拍板的假设」里逐条列出。
