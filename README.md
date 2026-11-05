# AgentHub

集中监控多个 Claude Code / Codex 会话的状态：任何会话「完成」或「等待授权」时，电脑托盘和 Android 手机都会提醒；能看到所有会话的列表，在电脑上点一下跳回对应窗口，处理过的提醒自动或手动消掉。

最新合并版本为 **0.5.1**，包含逐条回复操作、Codex 已读同步、Claude 原终端续聊、实验性豆包状态监听，以及目标优先级。验证与更新要求见 [0.5.1 发布说明](docs/releases/0.5.1.md)。

进行中的 0.9.8（[发布说明](docs/releases/0.9.8.md)）让 WorkBuddy 会话详情能看完整对话记录：电脑端按 sessionId 找到本地 transcript（`~/.workbuddy/projects/…/<sessionId>.jsonl`）解析最近 50 条消息回填，毫秒时间戳保留、注入块剥离，服务端放开读历史限制；仍是只读，不支持续聊/新开/分支。需要先升级服务端再升级客户端。0.9.7（[发布说明](docs/releases/0.9.7.md)）把 ZCode 从只读监听补成能派活的 agent：电脑端新增 ZCode 执行器，按 `zcode app-server --stdio` 的 ZCode Protocol（v1）新开会话、续聊、停止、批授权，和 Codex 同等能力（暂不支持按回复分叉）；服务端同时放开 zcode 的派活／续聊／读历史限制。0.9.6（[发布说明](docs/releases/0.9.6.md)）曾把 ZCode 接成只读会话监听：读 `~/.zcode/v2/sessions` 的权威状态（`meta.status`：running / completed / error，状态一变立刻上报，不用静默窗口推断），展示标题、项目目录与运行状态，跳转切到 ZCode 窗口。此前的 0.5.8（[发布说明](docs/releases/0.5.8.md)）新增账号级通知过滤：设置页「通知规则」可按 agent 静音、设免打扰时段和最低任务优先级；等待授权与审批永远提醒。0.5.9（[发布说明](docs/releases/0.5.9.md)）新增任务预摘要：进入待验收或执行失败时，服务端后台预生成验收摘要 / 失败上下文，任务详情页打开即见。0.6.0（[发布说明](docs/releases/0.6.0.md)）新增 Watchdog：会话 45 分钟无事件疑似卡死、短时间内反复失败时升级提醒（只提醒不干预）。0.7.0（[发布说明](docs/releases/0.7.0.md)）新增 Thread 时间线：任务详情页按时间统一展示关联会话对话、执行记录、提醒和摘要。0.8.0（[发布说明](docs/releases/0.8.0.md)）点系统通知回到应用并定位到会话 / 任务 / 目标，日历日视图支持缩放和平移，项目目录白名单改为可选。0.8.1（[发布说明](docs/releases/0.8.1.md)）新增验收检查项与证据链：任务清单自动成为检查项，可逐项通过 / 打回，打回原因沉淀为标准；证据从会话记录自动摘取。0.8.2（[发布说明](docs/releases/0.8.2.md)）派活支持离线排队：目标电脑离线时不再报错，改为排队并在它上线后自动投递（24 小时过期、单次最多 3 条）；派发失败时任务退回待办，不再卡在"进行中"。0.8.3（[发布说明](docs/releases/0.8.3.md)）新增项目配置：把执行工具 / 电脑 / 项目目录 / 默认优先级 / 检查项模板存成一个名字，建任务或之后选中即可补齐空字段、并入验收检查项；换配置时未勾选的模板项跟着换，已勾选与手工项保留。0.8.4（[发布说明](docs/releases/0.8.4.md)）新增派活看板：排队中 / 运行中 / 卡住（进行中无运行）的活聚到一张板上，卡住的当场重新派发或退回待办，排队的可立即派发或取消。0.9.0（[发布说明](docs/releases/0.9.0.md)）新增角色：把「执行工具 + 模型 + 上下文」存成一个名字，可再挂一个项目配置；发布任务时选角色，模型与上下文随派活下发（Claude 走 `--model` / `--append-system-prompt`，Codex 走进程级模型覆盖 + 首条消息前置上下文），离线排队也带着角色，0.9.1（[发布说明](docs/releases/0.9.1.md)）让角色像员工：新增项目（项目名 + 项目约定 + 默认配置），角色新增职责、可用工具声明和按「角色 × 项目」分区的记忆；验收打回的原因自动沉淀成该员工在这个项目上的经验，派活时与项目说明一起拼成系统提示下发（总预算 5000 字，项目经验优先、用得少的先轮换）。老电脑端会明确提示未生效。0.9.2（[发布说明](docs/releases/0.9.2.md)）让时间轴看得见对话跨度：会话行多一层「从第一次活动到最后一次活动」的虚线带（进行中延伸到当前时刻，条带内直接写总时长），活动分段不再被 run 挤掉，已结束的对话也不再整行消失；同一版还把设置页改成分区列表，项目目录守卫从白名单翻成黑名单（配置键改为 `deniedRoots`，旧值不迁移）。0.9.3（[发布说明](docs/releases/0.9.3.md)）修掉时间轴上重复的对话：一条对话挂了任务后，执行块落在任务行、日历又按同一会话 id 合成一行，同一条对话因此占两行；现在会话 id 已被任务行覆盖的会话行不再单独立行，任务行不在视图内时会话行照旧保留。0.9.4（[发布说明](docs/releases/0.9.4.md)）补上 WorkBuddy 的跨度与标题：WorkBuddy 采集器改为把 transcript 里的消息时间戳聚合成 5 分钟活动桶随事件上报（服务端落 `session_activity`），时间轴上的 WorkBuddy 对话不再是单点；标题改用文件头部播种的 `ai-title`，用户消息兜底标题剥离注入块，Codex 跳过 AGENTS.md 注入段，多个不同对话不再撞同一个名字。0.9.2 与 0.9.3 只需要换客户端安装包；0.9.4 需要先升级服务端再升级客户端；更早的版本均需先升级服务端再升级客户端。

## 组件

| 组件 | 位置 | 说明 |
|---|---|---|
| 中枢服务 | `server/` | Node + Fastify + pg，状态存 Postgres，WebSocket 实时推送（接口见 `server/README.md`） |
| 桌面端 | `src/`（React）+ `src-tauri/`（Rust） | Tauri 2。托盘 + 本地采集器：`127.0.0.1:47821` 接收 Claude hook，轮询 `~/.codex/sessions` 读 Codex 会话，批量转发给服务端 |
| Android 端 | 同一套前端 + `src-tauri/gen/android` | 前端只做 UI；Kotlin 前台服务（`AgentHubService`）保持 WebSocket 长连接并弹本地通知，不用 FCM |

## 目标与任务（0.5.0）

顶部「会话 / 任务 / 目标」标签可管理普通待办和 agent 任务。目标显示已完成任务数与总数；删除目标保留任务，删除任务保留关联会话。

任务和目标详情均可设置开始时间、截止时间及各自的到点提醒开关，按设备本地时区输入。服务端每 15 秒检查一次；桌面通知遵循设置中的通知开关，Android 通过后台监听服务通知。离线期间到期的提醒在重连后补回，首页「时间提醒」可打开对应事项或标记已处理，并同步到同账号设备。完成、归档、关闭提醒或修改时间后，旧提醒不再显示。需同时更新服务端和客户端；服务端启动时自动增量迁移。

任务详情支持最多 100 项 checklist，可添加、编辑、勾选、删除；修改后点击「保存」。任务列表显示已完成项数与总数，清单进度独立于任务状态。

任务详情可编辑标题、备注、状态、所属目标和执行设置；选好 Claude/Codex、在线电脑与项目目录后，点「开始」并确认第一条消息，即在电脑上新开会话。仍需电脑开启远程执行（配了「禁止执行的目录」时，目录不能落在禁止列表里）。可以多次新开，也可以关联已有会话；会话详情同样能关联任务或新建任务并关联。

任务状态为「待办 / 进行中 / 待验收 / 已完成」。任一关联会话完成时，进行中的任务自动进入待验收；关联会话重新运行时，待验收任务回到进行中。待办和已完成不会自动改变。失败运行保留进行中，方便重试。任务与目标跟随账号，通过现有 WebSocket 在手机和桌面同步；需要升级服务端以使用新接口。

第二版新增「远程控制」：在手机或电脑的 AgentHub 里点开一个会话，看最近的对话、发消息让电脑接着跑、在 App 里批授权（允许 / 拒绝）、中途停止。见下面「远程控制」一节。

数据来源：

- Claude Code：hook（`SessionStart` / `UserPromptSubmit` / `Notification` / `Stop` / `SessionEnd`）。`idle_prompt` 不接。
- Codex：只读 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`（`task_started` / `task_complete` / `turn_aborted`），不碰 `config.toml`（`notify` 已被 Codex Desktop 占用）。第一版没有 Codex 的「等待授权」状态。
- 豆包 Windows 客户端（实验性，已对照 2.32.6 本机日志）：只读 `%USERPROFILE%\AppData\Local\Doubao\User Data\sdk_storage\log\saman_YYYY.MMDD.N.log` 中的结构化生命周期事件，每 2 秒增量检查。按会话 ID 展示标题、回复中、完成和中断状态，复用桌面／手机提醒和已处理操作；「跳转」切到豆包窗口，不能定位到指定聊天。没有该目录时自动等待，不需要 API Key。
- WorkBuddy：只读 `%USERPROFILE%\.workbuddy\projects\<工作区>\<sessionId>.jsonl`（`message` / `function_call` / `ai-title` / `custom-title`），每 2 秒增量检查。展示标题、项目目录、运行中／完成／中断状态，复用桌面／手机提醒和已处理操作；0.9.8 起会话详情支持只读历史同步；「跳转」切到 WorkBuddy 窗口，不能定位到指定会话。
- ZCode：只读 `%USERPROFILE%\.zcode\v2\sessions\<工作区哈希>\sess_<uuid>.json`（`meta.status` 直接给出 running / completed / error，不用猜），每 2 秒检查文件改动。展示标题、项目目录、运行中／完成／失败状态，也支持派活、续聊、停止和读历史（走 CLI 的 app-server，见下面「ZCode 会话监听与派活」）；「跳转」切到 ZCode 窗口，不能定位到指定会话。

豆包接入仅提供**会话状态监听**，暂不提供完整对话正文、等待授权、远程发消息、新建或分支。完成状态必须有会话结束成功事件，不通过日志停止增长猜测；初次加载今天和昨天每个日志末尾最多 8 MiB，静默登记已有状态，历史中未结束的运行显示为未知。日志轮换后继续读取新文件。豆包升级改变日志格式时可能无法采集，需要重新适配；此功能需同时更新服务端、桌面端与手机端。

## WorkBuddy 会话监听

WorkBuddy 没有 hook，也没有可调用的 CLI/IPC 通道，因此做**状态与消息监听**：能展示标题、所属项目目录、运行中／完成／中断状态，跳转只能切到 WorkBuddy 窗口，不能定位到指定会话；0.9.8 起会话详情可读取完整对话记录（只读历史同步，见 [0.9.8 发布说明](docs/releases/0.9.8.md)），但等待授权、远程发消息、新建或分支仍不支持。

完成判定不看「日志停止增长」本身，而是三个条件同时满足：

1. transcript 尾部是已完成（`status: completed`）的助手回复，或已归的工具结果；被中断的回复（`incomplete`）判为已中断；
2. 没有未归的 `function_call`（工具还在执行时不会结束）；
3. 文件静默达到确认窗口（回复结束后 20 秒，工具结果后 60 秒）。

首轮启动只登记历史会话的最终状态（静默、不触发提醒），跳过 7 天前和 3 天内未改动过的文件；会话被继续写入时自动恢复跟踪。实现见 `src-tauri/src/workbuddy.rs`，服务端把 workbuddy 当作只读 agent，发消息／新开／分支／读历史都返回 409。

## ZCode 会话监听与派活

ZCode（Z.ai 的编程工作台）没有 hook，但带一个可用的 CLI（`zcode.cjs app-server --stdio`，装在 `C:\Program Files\ZCode`）。AgentHub 因此把 ZCode 做成了**能派活的 agent**：

- **监听**：只读 `%USERPROFILE%\.zcode\v2\sessions\<工作区哈希>\sess_<uuid>.json`，`meta.status` 直接给出 running / completed / error（映射 running / done / aborted），每 2 秒检查文件改动；展示标题、项目目录、状态，照常触发桌面／手机提醒，时间轴有对话跨度。
- **派活 / 续聊 / 停止**：本机执行器起 `zcode app-server` 子进程走 ZCode Protocol（v1 的 `session/create`、`session/resume`、`session/send`、`session/stop`），完成事件驱动状态，授权走 `interaction/requestPermission` 到手机确认。项目目录同样受「禁止执行的目录」约束。
- **读历史**：直接从会话文件读消息，不需要额外通道。

裸跑 CLI 时桌面端 Host 原本负责的三件事由执行器补齐：指向内置 provider 配置（`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`）、下发账号权益（`provider/updateAccountConfig`，基础版本从 CLI 日志里的 `configRevision` 动态读取）、以及响应 `interaction/requestProviderRuntimeHeaders` 注入 Project Access Token（用本地登录凭证换取，只在内存里传递，不写日志）。

**限制**：不支持按回复分叉（可以用同目录新开或直接续聊）；派活时不能附图；Agent 的提问（`interaction/requestUserInput`）在 AgentHub 里不能作答，会自动取消；默认模型 GLM-5.3，角色里写 `providerId/modelId` 可以覆盖；需要本机装好 ZCode 并已登录。协议是桌面端的私有协议，ZCode 升级后可能需要重新适配，细节见 [协议规格](docs/zcode-app-server.md)。

## 逐条回复操作

每条助手回复下提供复制、点赞／点踩、朗读／停止和“从此处分支到新聊天”。评价保存在 AgentHub 账号内并跨设备同步；朗读使用设备语音。分支保留截至所选完整回复的原生上下文，不带后续消息。Claude Code 使用消息 UUID，Codex 使用完成轮次的 turn ID；旧记录请先刷新电脑历史。顶端保留“同目录新建会话”，从零开始聊天。分支与原会话仍使用同一项目目录，不回滚代码文件。

需要同时更新服务端、桌面执行器和客户端。旧执行器缺少指定节点能力时明确报错，不降级为整会话分叉。支持与验证记录见 [回复操作](docs/reply-actions/README.md)。

## 本地开发

```bash
# 服务端
docker start agenthub-pg 2>/dev/null || docker run -d --name agenthub-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=agenthub -p 55433:5432 postgres:16-alpine
cd server && npm install && npm run check && npm test
ADMIN_TOKEN=devadmin DATABASE_URL=postgres://postgres:dev@localhost:55433/agenthub node src/index.ts
# 打开 http://127.0.0.1:3000/admin 用 devadmin 建账号，再在 App 里登录

# 桌面端
npm install
npm run tauri dev          # 登录页填 http://127.0.0.1:3000 和管理页建的账号
cd src-tauri && cargo test
npm run tauri build        # 产物 src-tauri/target/release/bundle/nsis/AgentHub_0.3.0_x64-setup.exe
```

桌面配置保存在 `%APPDATA%\com.wenbo.agenthub\config.json`（serverUrl / token / email / machine / notifyDesktop / deniedRoots / remoteEnabled；token 是登录后拿到的设备会话 token，不用手填）。

## 远程控制（第二版）

```
手机/电脑 UI ──REST(登录 token)──► 服务端 ──WS(role=agent)──► 电脑端「执行器」──► claude -p / codex app-server
     ▲                              │  ◄──────run 事件─────────┘
     └──────WS 广播 message/approval/run──┘
```

**开启步骤**

1. 用同一个账号在电脑和手机上登录（见下面「账号」一节）。
2. 电脑端「设置」→「本机执行与采集」：勾「允许手机远程执行」，保存。设置页会显示执行器连接状态。项目目录默认不限制；想让某些目录绝对不能跑（比如放密钥、放私人文件的地方），就把它们填进「禁止执行的目录」（黑名单，每行一个；`D:\Work2Other` 不算在 `D:\Work2` 之下）。
3. 之后在手机上点会话列表里的任意一行进入详情页：能看到对话、发消息、批授权、停止；「加载电脑上的历史记录」把本机 transcript / rollout 最近 30 条对话拉过来。有 pending 授权的会话在列表里标「待授权」并归入「待处理」，手机弹「<项目> · 请求授权」通知，点开 App 操作。

**规则**

- Claude：原终端仍打开时，通过该会话的认证命名管道投递消息，回复进入原终端与 AgentHub；原终端关闭后，用 `claude -p --resume <sid> --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio --permission-mode default` 在原目录继续。原终端模式的权限确认与中断在终端处理，AgentHub 的“停止跟踪”只结束回复跟踪。详见 [原终端续聊](docs/claude-terminal-chat.md)。
- Codex：用 Codex Desktop 自带的 `codex.exe`（`%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`，取最新的）起一个自己的 `app-server`，`thread/resume` + `turn/start`，`approvalPolicy: on-request`。会话状态是 `running`（Desktop 正在跑）时不允许发消息。
- 同一个会话同一时间只允许一个 AgentHub 发起的运行；由 AgentHub 启动的进程，授权 30 分钟没决定按拒绝处理，单次运行 2 小时停止。接入原终端时，超时或停止只结束回复跟踪，原终端自行控制授权与中断。
- 详情页断线重连后自动补拉最近 200 条消息及运行状态；补拉期间的新消息不会被旧响应覆盖。授权超时立即同步为过期并清除待授权提醒（需同时更新服务端和桌面端）。
- 不用 `bypassPermissions` / `approvalPolicy: never`：所有需要授权的操作都要回到手机上确认。

**安全说明**

- 没有单独的控制密钥：兜底是电脑端「允许手机远程执行」开关 + 每次授权都要在手机上确认（可再选配禁止目录黑名单）；设备可以在设置页随时移除。
- 电脑端必须手动打开「允许手机远程执行」。禁止目录是黑名单、可选的：留空不限制任何目录，填了只是禁止这些目录（含子目录）执行，其余照常。
- 黑名单是「防手滑」而不是沙箱：运行起来的 agent 用 Bash / 写文件仍然能碰到禁止目录里的路径（只挡会话的起始目录），真正的边界是账号和 HTTPS。能登录你账号的人可以让 agent 执行任意（经你批准的）操作，请保管好密码，并务必用 HTTPS。

## 基于已有会话新开、在终端打开（0.4.0）

会话详情页的「新开会话」有两种模式，输入第一条消息后由电脑端在后台启动，新会话出现在列表里，和普通会话一样能收提醒、发消息、批授权、停止（手机和电脑都能用）：

- **分叉（带上下文）**：复制原会话的全部对话，从那里接着聊，原会话不受影响。Claude 用 `claude -p --resume <id> --fork-session ...`，Codex 用 app-server 的 `thread/fork`。
- **同目录新开（不带上下文）**：沿用原会话的目录和 agent 类型，对话从零开始。Claude 不带 `--resume`，Codex 用 `thread/start`。

电脑端要开「允许手机远程执行」（配了禁止目录时，目标目录不能落在禁止列表里）；AgentHub 自行启动的分叉和新会话在手机上确认授权。分叉和新开保留原终端会话。

新会话的真实 id 要等 CLI 启动后才知道：服务端先建一个临时会话（id 形如 `claude:pending-<runId>`），界面立刻跳过去；执行器拿到真实 id 后上报 `run.session`，服务端把临时会话改名（真实 id 已被 hook / 轮询抢先登记时合并）。拿到真实 id 之前就失败，临时会话标为「已中断」并显示错误，可手动删除。

**在终端打开**（仅桌面端、本机的会话）：Claude 会话在原目录新开一个 Windows Terminal **命名窗口** `AgentHub-<id>` 执行 `claude --resume <id>`（`wt.exe` 失败时回退 `cmd /k`）；如果这个会话已经在终端里开着，就直接切过去。Codex 会话把 Codex Desktop 切到前台（无法直接定位到具体会话）。AgentHub 正在运行这个会话时按钮禁用。这是本机的主动点击，不走目录黑名单。

**跳转**（仅桌面端、本机的会话）：把会话所在的终端窗口带到前台。如果这个会话是 AgentHub 用「在终端打开」启动的（本次运行期间），还会用 `wt -w AgentHub-<id> focus-tab` 精确切到对应 tab —— Windows Terminal 的所有 tab 共用一个 HWND，纯 Win32 只能切窗口切不了 tab；用户手动开的 tab 仍只能到窗口级。AgentHub 重启后命名窗口的记忆丢失，退化为只切窗口。

## 安装 Claude Code hook

打开桌面端「设置」→「安装 Claude Code hook」。它会：

1. 把 `agenthub-report.sh` 写到 `~/.claude/hooks/`；
2. 备份 `~/.claude/settings.json` 为 `settings.json.agenthub-bak`；
3. 向 `SessionStart`、`UserPromptSubmit`、`Notification`（matcher `permission_prompt|agent_needs_input|elicitation_dialog`）、`Stop`、`SessionEnd` **追加**一个 hook 组，已有的 hooks 原样保留；重复安装不会重复追加；
4. 「卸载」只删除含 `agenthub-report.sh` 的条目，空组和空事件键一并清掉。

上报脚本绝不往 stdout 输出（hook 的 stdout 会被塞进 Claude 上下文），失败也 `exit 0`；脚本必须是 LF 行尾（`.gitattributes` 已设 `*.sh eol=lf`）。

手工验证（不要用真实 settings.json）：

```bash
echo '{"hook_event_name":"UserPromptSubmit","session_id":"t1","cwd":"D:\\Work2\\Demo","transcript_path":"","prompt":"测试"}' | bash src-tauri/resources/agenthub-report.sh
echo '{"hook_event_name":"Stop","session_id":"t1","cwd":"D:\\Work2\\Demo","transcript_path":"","last_assistant_message":"完成了"}' | bash src-tauri/resources/agenthub-report.sh
echo '{}' | bash src-tauri/resources/agenthub-report.sh | wc -c   # 0
```

## macOS 构建

```bash
npm ci
npm run tauri build        # 产物 src-tauri/target/release/bundle/macos/AgentHub.app
cp -R src-tauri/target/release/bundle/macos/AgentHub.app ~/Applications/
xattr -dr com.apple.quarantine ~/Applications/AgentHub.app   # 未签名包首次启动被拦时
```

- 打包目标按平台拆：`tauri.conf.json` 里只留 `nsis`，macOS 由 `src-tauri/tauri.macos.conf.json` 覆盖成 `app`（两边写在一起会让对方的平台去找不存在的打包器）。
- 机器上没有 Node 时，可直接下官方 darwin 包解到 `~/.local/node`，跑 npm 前 `export PATH=$HOME/.local/node/bin:$PATH`（否则 npm 的 shebang 找不到 node）。
- 需要 dmg：在**已登录桌面**的会话里跑 `npm run tauri build -- --bundles app,dmg`。dmg 打包由 `bundle_dmg.sh` 调 Finder 摆图标，SSH 无人值守会一直卡在 `osascript` 上。
- 仅 Windows 的能力（终端续聊、窗口/标签页跳转、进程链匹配）在 macOS 上会走降级分支直接报错；采集、会话、任务、通知正常。

## Android 构建

```bash
export ANDROID_HOME='D:/Android/SDK'; export NDK_HOME='D:/Android/SDK/ndk/28.2.13676358'
npm run tauri android build -- --apk --target aarch64
src-tauri/gen/android/gradlew --stop      # 构建结束后停掉 Gradle daemon
```

产物：`src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`。

- Gradle wrapper 指向腾讯云镜像（`gradle-wrapper.properties`），官方源国内超时。
- 签名：有 `src-tauri/gen/android/keystore.properties`（已 gitignore）就用正式签名，否则 release 也用 debug 签名。
- 前台服务类型用 `remoteMessaging`（不用 `dataSync`，Android 15 起每天限 6 小时）。
- release 包默认禁止明文 HTTP，手机上请使用 `https://` 的服务端地址。
- 手机上打开 App → 登录 →「设置」→「开启后台提醒」，并把电池优化设为「不限制」。

## 部署（Dokploy，本次未部署）

1. 在共享 Postgres 里新建 `agenthub` 库。
2. 新建应用，构建上下文 `server/`，使用 `server/Dockerfile`。
3. 环境变量：

   | 变量 | 说明 |
   |---|---|
   | `DATABASE_URL` | `postgres://<user>:<pass>@<host>:5432/agenthub` |
   | `ADMIN_TOKEN` | 管理页令牌（长随机串）；不设则 `/admin*` 404、无法建账号 |
   | `PORT` | 默认 3000 |
   | `LOG_LEVEL` | 默认 info |

4. 绑定域名并开启 HTTPS（WebSocket 需要反代透传 Upgrade）。首次上线：打开 `https://<域名>/admin`，输入 `ADMIN_TOKEN`，新建账号；桌面端和手机端的登录页填这个域名和账号。

**升级到 0.3.0**：服务端和客户端都要升级。服务端启动时会清空旧的会话 / 运行 / 消息 / 授权表（只有临时状态数据）；旧客户端会收到 401，需要更新并登录。

## 账号

- 邮箱 + 密码登录，不开放注册，账号只能在服务端 `/admin` 页面创建。每个账号的数据互相隔离。
- 每台设备登录后有自己的会话 token（保存在本地，不用手填）；设置页可以看「已登录设备」、移除其它设备、修改密码。
- 登录失效（被移除、改密码、管理员重置）时，桌面端 / 手机端提示「登录已过期，请重新登录」，上报和执行器停止重试，重新登录后恢复。

## 已知限制

- 手机上新开的会话在运行过程中，电脑终端里看不到实时输出；跑完后可以用「在终端打开」继续。
- 「在终端打开」对 Codex 只能把 Codex Desktop 切到前台，没法定位到具体会话。

- Codex 窗口跳转：没有进程号时匹配可执行名为 `ChatGPT.exe`（Codex Desktop 的窗口进程，实测）或包含 `codex` 且有可见主窗口的进程；找不到会提示「没找到 Codex 窗口」。
- 手机上发给 Codex 的消息，Codex Desktop 界面**不会实时显示**（重新打开那个会话才能看到）；Desktop 自己的 app-server 是私有的，外部连不进去。
- 远程控制的 Claude 会话只能是终端里已关闭/已完成的；Codex 会话 `running` 时不能发。电脑端断线时，进行中的运行会被结束并标为失败。
- 「刷新电脑上的记录」读取最近 50 条可见消息并保留原始消息标识；服务端每个会话只保留最近 200 条消息。
- 通知里没有「允许 / 拒绝」按钮，要点开 App 操作。
- Claude 跳转依赖 Windows 进程链（hook 的 bash → claude.exe → 终端）；Windows Terminal 是多标签单窗口，只能切到窗口，切不到具体标签。
- 本机 AgentHub 没运行时，hook 脚本每次会等 curl 超时（Windows 上连接被拒绝约 2 秒），上限 2 秒。
- Android 端只有重连后「新发生」的变化会弹通知，断线期间错过的提醒不会补弹（列表里仍能看到待处理）。
- Codex 的 `waiting` 状态尚未接入本地采集；标题优先读取 Codex 名称索引，缺失时取首条用户文本。
- WorkBuddy 的完成提醒依赖静默确认窗口：模型长时间思考或工具执行期间不判结束，正常结束会比实际晚 20 秒（工具结果后 60 秒）才提醒；拿不到等待授权状态，因此不能在 AgentHub 里批授权。
- WorkBuddy 的 transcript 结构没有对外承诺，升级后可能改变字段或目录，届时采集会失效需要重新适配。
- ZCode 的 `~/.zcode/v2/sessions` 目录结构与其内部 `meta.status` 枚举没有对外承诺，升级后可能改变，届时采集会失效需要重新适配；从 Claude Code 迁移过来的会话（`migrationSource: claudeCode`）在 ZCode 和 Claude 两侧各显示一条。
- 主力平台 Windows + Android；macOS 可自行源码构建（见「macOS 构建」，终端续聊/窗口跳转降级），不做 iOS。多账号隔离（管理员建账号）。任务管理暂不包含到期提醒、重复任务、子任务和离线编辑。
