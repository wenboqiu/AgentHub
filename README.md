# AgentHub

集中监控多个 Claude Code / Codex 会话的状态：任何会话「完成」或「等待授权」时，电脑托盘和 Android 手机都会提醒；能看到所有会话的列表，在电脑上点一下跳回对应窗口，处理过的提醒自动或手动消掉。

## 组件

| 组件 | 位置 | 说明 |
|---|---|---|
| 中枢服务 | `server/` | Node + Fastify + pg，状态存 Postgres，WebSocket 实时推送（接口见 `server/README.md`） |
| 桌面端 | `src/`（React）+ `src-tauri/`（Rust） | Tauri 2。托盘 + 本地采集器：`127.0.0.1:47821` 接收 Claude hook，轮询 `~/.codex/sessions` 读 Codex 会话，批量转发给服务端 |
| Android 端 | 同一套前端 + `src-tauri/gen/android` | 前端只做 UI；Kotlin 前台服务（`AgentHubService`）保持 WebSocket 长连接并弹本地通知，不用 FCM |

## 目标与任务（0.5.0）

顶部「会话 / 任务 / 目标」标签可管理普通待办和 agent 任务。目标显示已完成任务数与总数；删除目标保留任务，删除任务保留关联会话。

任务详情可编辑标题、备注、状态、所属目标和执行设置；选好 Claude/Codex、在线电脑与项目目录后，点「开始」并确认第一条消息，即在电脑上新开会话。仍需电脑开启远程执行，目录位于白名单内。可以多次新开，也可以关联已有会话；会话详情同样能关联任务或新建任务并关联。

任务状态为「待办 / 进行中 / 待验收 / 已完成」。任一关联会话完成时，进行中的任务自动进入待验收；关联会话重新运行时，待验收任务回到进行中。待办和已完成不会自动改变。失败运行保留进行中，方便重试。任务与目标跟随账号，通过现有 WebSocket 在手机和桌面同步；需要升级服务端以使用新接口。

第二版新增「远程控制」：在手机或电脑的 AgentHub 里点开一个会话，看最近的对话、发消息让电脑接着跑、在 App 里批授权（允许 / 拒绝）、中途停止。见下面「远程控制」一节。

数据来源：

- Claude Code：hook（`SessionStart` / `UserPromptSubmit` / `Notification` / `Stop` / `SessionEnd`）。`idle_prompt` 不接。
- Codex：只读 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`（`task_started` / `task_complete` / `turn_aborted`），不碰 `config.toml`（`notify` 已被 Codex Desktop 占用）。第一版没有 Codex 的「等待授权」状态。

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
2. 电脑端「设置」：勾「允许手机远程执行」，在「允许的项目目录」里每行写一个目录（只有位于这些目录下的会话才能被远程接着跑；`D:\Work2Other` 不算在 `D:\Work2` 之下），保存。设置页会显示执行器连接状态。
3. 之后在手机上点会话列表里的任意一行进入详情页：能看到对话、发消息、批授权、停止；「加载电脑上的历史记录」把本机 transcript / rollout 最近 30 条对话拉过来。有 pending 授权的会话在列表里标「待授权」并归入「待处理」，手机弹「<项目> · 请求授权」通知，点开 App 操作。

**规则**

- Claude：用 `claude -p --resume <sid> --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio --permission-mode default` 在会话原来的 cwd 接着跑；只接着跑终端里已经关掉或已经完成的会话（`claude agents --json` 里还列着的会话一律拒绝）。
- Codex：用 Codex Desktop 自带的 `codex.exe`（`%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`，取最新的）起一个自己的 `app-server`，`thread/resume` + `turn/start`，`approvalPolicy: on-request`。会话状态是 `running`（Desktop 正在跑）时不允许发消息。
- 同一个会话同一时间只允许一个 AgentHub 发起的运行；授权 30 分钟没决定按拒绝处理；单次运行 2 小时强制停止。
- 详情页断线重连后自动补拉最近 200 条消息及运行状态；补拉期间的新消息不会被旧响应覆盖。授权超时立即同步为过期并清除待授权提醒（需同时更新服务端和桌面端）。
- 不用 `bypassPermissions` / `approvalPolicy: never`：所有需要授权的操作都要回到手机上确认。

**安全说明**

- 没有单独的控制密钥：兜底是电脑端「允许手机远程执行」开关 + 项目目录白名单 + 每次授权都要在手机上确认；设备可以在设置页随时移除。
- 电脑端有目录白名单（默认空 = 全部拒绝），并且必须手动打开「允许手机远程执行」。
- 能登录你账号的人可以在白名单目录里让 agent 执行任意（经你批准的）操作，请保管好密码，并务必用 HTTPS。

## 基于已有会话新开、在终端打开（0.4.0）

会话详情页的「新开会话」有两种模式，输入第一条消息后由电脑端在后台启动，新会话出现在列表里，和普通会话一样能收提醒、发消息、批授权、停止（手机和电脑都能用）：

- **分叉（带上下文）**：复制原会话的全部对话，从那里接着聊，原会话不受影响。Claude 用 `claude -p --resume <id> --fork-session ...`，Codex 用 app-server 的 `thread/fork`。
- **同目录新开（不带上下文）**：沿用原会话的目录和 agent 类型，对话从零开始。Claude 不带 `--resume`，Codex 用 `thread/start`。

安全规则不变：电脑端要开「允许手机远程执行」、目录在白名单内、授权在手机上确认。分叉和新开不写原会话，所以不受「Claude 会话在终端里还开着就拒绝」的限制。

新会话的真实 id 要等 CLI 启动后才知道：服务端先建一个临时会话（id 形如 `claude:pending-<runId>`），界面立刻跳过去；执行器拿到真实 id 后上报 `run.session`，服务端把临时会话改名（真实 id 已被 hook / 轮询抢先登记时合并）。拿到真实 id 之前就失败，临时会话标为「已中断」并显示错误，可手动删除。

**在终端打开**（仅桌面端、本机的会话）：Claude 会话在原目录新开一个 Windows Terminal 窗口执行 `claude --resume <id>`（`wt.exe` 失败时回退 `cmd /k`）；如果这个会话已经在终端里开着，就直接切过去。Codex 会话把 Codex Desktop 切到前台（无法直接定位到具体会话）。AgentHub 正在运行这个会话时按钮禁用。这是本机的主动点击，不走目录白名单。

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
- 「加载电脑上的历史记录」按角色 + 文本去重，只取最近 30 条；服务端每个会话只保留最近 200 条消息。
- 通知里没有「允许 / 拒绝」按钮，要点开 App 操作。
- Claude 跳转依赖 Windows 进程链（hook 的 bash → claude.exe → 终端）；Windows Terminal 是多标签单窗口，只能切到窗口，切不到具体标签。
- 本机 AgentHub 没运行时，hook 脚本每次会等 curl 超时（Windows 上连接被拒绝约 2 秒），上限 2 秒。
- Android 端只有重连后「新发生」的变化会弹通知，断线期间错过的提醒不会补弹（列表里仍能看到待处理）。
- Codex 第一版没有 `waiting` 状态；title 取第一条不以 `<` 开头的用户文本，可能是注入的上下文。
- 仅 Windows + Android，不做 iOS / macOS，多账号隔离（管理员建账号）。任务管理暂不包含到期提醒、重复任务、子任务和离线编辑。
