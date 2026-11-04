# AgentHub

集中监控多个 Claude Code / Codex 会话的状态：任何会话「完成」或「等待授权」时，电脑托盘和 Android 手机都会提醒；能看到所有会话的列表，在电脑上点一下跳回对应窗口，处理过的提醒自动或手动消掉。

最新合并版本为 **0.5.1**，包含逐条回复操作、Codex 已读同步、Claude 原终端续聊、实验性豆包状态监听，以及目标优先级。验证与更新要求见 [0.5.1 发布说明](docs/releases/0.5.1.md)。

进行中的 0.5.8（[发布说明](docs/releases/0.5.8.md)）新增账号级通知过滤：设置页「通知规则」可按 agent 静音、设免打扰时段和最低任务优先级；等待授权与审批永远提醒。0.5.9（[发布说明](docs/releases/0.5.9.md)）新增任务预摘要：进入待验收或执行失败时，服务端后台预生成验收摘要 / 失败上下文，任务详情页打开即见。0.6.0（[发布说明](docs/releases/0.6.0.md)）新增 Watchdog：会话 45 分钟无事件疑似卡死、短时间内反复失败时升级提醒（只提醒不干预）。0.7.0（[发布说明](docs/releases/0.7.0.md)）新增 Thread 时间线：任务详情页按时间统一展示关联会话对话、执行记录、提醒和摘要。0.8.0（[发布说明](docs/releases/0.8.0.md)）点系统通知回到应用并定位到会话 / 任务 / 目标，日历日视图支持缩放和平移，项目目录白名单改为可选。0.8.1（[发布说明](docs/releases/0.8.1.md)）新增验收检查项与证据链：任务清单自动成为检查项，可逐项通过 / 打回，打回原因沉淀为标准；证据从会话记录自动摘取。均需先升级服务端再升级客户端。

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

任务详情可编辑标题、备注、状态、所属目标和执行设置；选好 Claude/Codex、在线电脑与项目目录后，点「开始」并确认第一条消息，即在电脑上新开会话。仍需电脑开启远程执行（配了项目目录白名单时，目录要在白名单内）。可以多次新开，也可以关联已有会话；会话详情同样能关联任务或新建任务并关联。

任务状态为「待办 / 进行中 / 待验收 / 已完成」。任一关联会话完成时，进行中的任务自动进入待验收；关联会话重新运行时，待验收任务回到进行中。待办和已完成不会自动改变。失败运行保留进行中，方便重试。任务与目标跟随账号，通过现有 WebSocket 在手机和桌面同步；需要升级服务端以使用新接口。

第二版新增「远程控制」：在手机或电脑的 AgentHub 里点开一个会话，看最近的对话、发消息让电脑接着跑、在 App 里批授权（允许 / 拒绝）、中途停止。见下面「远程控制」一节。

数据来源：

- Claude Code：hook（`SessionStart` / `UserPromptSubmit` / `Notification` / `Stop` / `SessionEnd`）。`idle_prompt` 不接。
- Codex：只读 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`（`task_started` / `task_complete` / `turn_aborted`），不碰 `config.toml`（`notify` 已被 Codex Desktop 占用）。第一版没有 Codex 的「等待授权」状态。
- 豆包 Windows 客户端（实验性，已对照 2.32.6 本机日志）：只读 `%USERPROFILE%\AppData\Local\Doubao\User Data\sdk_storage\log\saman_YYYY.MMDD.N.log` 中的结构化生命周期事件，每 2 秒增量检查。按会话 ID 展示标题、回复中、完成和中断状态，复用桌面／手机提醒和已处理操作；「跳转」切到豆包窗口，不能定位到指定聊天。没有该目录时自动等待，不需要 API Key。
- WorkBuddy：只读 `%USERPROFILE%\.workbuddy\projects\<工作区>\<sessionId>.jsonl`（`message` / `function_call` / `ai-title` / `custom-title`），每 2 秒增量检查。展示标题、项目目录、运行中／完成／中断状态，复用桌面／手机提醒和已处理操作；「跳转」切到 WorkBuddy 窗口，不能定位到指定会话。

豆包接入仅提供**会话状态监听**，暂不提供完整对话正文、等待授权、远程发消息、新建或分支。完成状态必须有会话结束成功事件，不通过日志停止增长猜测；初次加载今天和昨天每个日志末尾最多 8 MiB，静默登记已有状态，历史中未结束的运行显示为未知。日志轮换后继续读取新文件。豆包升级改变日志格式时可能无法采集，需要重新适配；此功能需同时更新服务端、桌面端与手机端。

## WorkBuddy 会话监听

WorkBuddy 没有 hook，也没有可调用的 CLI/IPC 通道，因此同样只做**状态与消息元数据监听**：能展示标题、所属项目目录、运行中／完成／中断状态，跳转只能切到 WorkBuddy 窗口，不能定位到指定会话；不提供完整对话正文、等待授权、远程发消息、新建或分支。

完成判定不看「日志停止增长」本身，而是三个条件同时满足：

1. transcript 尾部是已完成（`status: completed`）的助手回复，或已归的工具结果；被中断的回复（`incomplete`）判为已中断；
2. 没有未归的 `function_call`（工具还在执行时不会结束）；
3. 文件静默达到确认窗口（回复结束后 20 秒，工具结果后 60 秒）。

首轮启动只登记历史会话的最终状态（静默、不触发提醒），跳过 7 天前和 3 天内未改动过的文件；会话被继续写入时自动恢复跟踪。实现见 `src-tauri/src/workbuddy.rs`，服务端把 workbuddy 当作只读 agent，发消息／新开／分支／读历史都返回 409。

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

桌面配置保存在 `%APPDATA%\com.wenbo.agenthub\config.json`（serverUrl / token / email / machine / notifyDesktop / allowedRoots / remoteEnabled；token 是登录后拿到的设备会话 token，不用手填）。

## 远程控制（第二版）

```
手机/电脑 UI ──REST(登录 token)──► 服务端 ──WS(role=agent)──► 电脑端「执行器」──► claude -p / codex app-server
     ▲                              │  ◄──────run 事件─────────┘
     └──────WS 广播 message/approval/run──┘
```

**开启步骤**

1. 用同一个账号在电脑和手机上登录（见下面「账号」一节）。
2. 电脑端「设置」：勾「允许手机远程执行」，保存。设置页会显示执行器连接状态。项目目录默认不限制；想让远程只能在几个目录里跑，就把它们填进「项目目录白名单」（每行一个，`D:\Work2Other` 不算在 `D:\Work2` 之下）。
3. 之后在手机上点会话列表里的任意一行进入详情页：能看到对话、发消息、批授权、停止；「加载电脑上的历史记录」把本机 transcript / rollout 最近 30 条对话拉过来。有 pending 授权的会话在列表里标「待授权」并归入「待处理」，手机弹「<项目> · 请求授权」通知，点开 App 操作。

**规则**

- Claude：原终端仍打开时，通过该会话的认证命名管道投递消息，回复进入原终端与 AgentHub；原终端关闭后，用 `claude -p --resume <sid> --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio --permission-mode default` 在原目录继续。原终端模式的权限确认与中断在终端处理，AgentHub 的“停止跟踪”只结束回复跟踪。详见 [原终端续聊](docs/claude-terminal-chat.md)。
- Codex：用 Codex Desktop 自带的 `codex.exe`（`%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`，取最新的）起一个自己的 `app-server`，`thread/resume` + `turn/start`，`approvalPolicy: on-request`。会话状态是 `running`（Desktop 正在跑）时不允许发消息。
- 同一个会话同一时间只允许一个 AgentHub 发起的运行；由 AgentHub 启动的进程，授权 30 分钟没决定按拒绝处理，单次运行 2 小时停止。接入原终端时，超时或停止只结束回复跟踪，原终端自行控制授权与中断。
- 详情页断线重连后自动补拉最近 200 条消息及运行状态；补拉期间的新消息不会被旧响应覆盖。授权超时立即同步为过期并清除待授权提醒（需同时更新服务端和桌面端）。
- 不用 `bypassPermissions` / `approvalPolicy: never`：所有需要授权的操作都要回到手机上确认。

**安全说明**

- 没有单独的控制密钥：兜底是电脑端「允许手机远程执行」开关 + 每次授权都要在手机上确认（可再选配项目目录白名单）；设备可以在设置页随时移除。
- 电脑端必须手动打开「允许手机远程执行」。项目目录白名单是可选的：留空不限制，填了才只允许这些目录。
- 白名单是「防手滑」而不是沙箱：运行起来的 agent 用 Bash / 写文件仍然能碰到白名单外的路径，真正的边界是账号和 HTTPS。能登录你账号的人可以让 agent 执行任意（经你批准的）操作，请保管好密码，并务必用 HTTPS。

## 基于已有会话新开、在终端打开（0.4.0）

会话详情页的「新开会话」有两种模式，输入第一条消息后由电脑端在后台启动，新会话出现在列表里，和普通会话一样能收提醒、发消息、批授权、停止（手机和电脑都能用）：

- **分叉（带上下文）**：复制原会话的全部对话，从那里接着聊，原会话不受影响。Claude 用 `claude -p --resume <id> --fork-session ...`，Codex 用 app-server 的 `thread/fork`。
- **同目录新开（不带上下文）**：沿用原会话的目录和 agent 类型，对话从零开始。Claude 不带 `--resume`，Codex 用 `thread/start`。

电脑端要开「允许手机远程执行」（配了白名单时目录需在白名单内）；AgentHub 自行启动的分叉和新会话在手机上确认授权。分叉和新开保留原终端会话。

新会话的真实 id 要等 CLI 启动后才知道：服务端先建一个临时会话（id 形如 `claude:pending-<runId>`），界面立刻跳过去；执行器拿到真实 id 后上报 `run.session`，服务端把临时会话改名（真实 id 已被 hook / 轮询抢先登记时合并）。拿到真实 id 之前就失败，临时会话标为「已中断」并显示错误，可手动删除。

**在终端打开**（仅桌面端、本机的会话）：Claude 会话在原目录新开一个 Windows Terminal **命名窗口** `AgentHub-<id>` 执行 `claude --resume <id>`（`wt.exe` 失败时回退 `cmd /k`）；如果这个会话已经在终端里开着，就直接切过去。Codex 会话把 Codex Desktop 切到前台（无法直接定位到具体会话）。AgentHub 正在运行这个会话时按钮禁用。这是本机的主动点击，不走目录白名单。

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
- 仅 Windows + Android，不做 iOS / macOS，多账号隔离（管理员建账号）。任务管理暂不包含到期提醒、重复任务、子任务和离线编辑。
