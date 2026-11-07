# 任务单执行（WorkBuddy 版）

盯住**派到本机、但还没开动的任务单**：发现就认领、在单上写的目录里干完、把产物写回任务并转成「待验收」。

执行者默认是 **WorkBuddy 自己的 CLI**（`codebuddy -p`，应用自带、同一个引擎同一套登录态），也可以切成本机的 `claude`。

```
watch-tasks.mjs   选单：状态 / 去重 / 目录映射 / 回写（确定性，不靠模型猜）
task-run.mjs      执行：认领 → 在目标目录跑执行器 → 写产物 → 转待验收
task-daemon.mjs   触发：挂 WebSocket 推送，单子一落库就调 task-run
```

## 命令行触发（不用常驻进程）

```bash
npm run task:run -- 24            # 跑 24 号单
npm run task:next                 # 自动挑一张最该接的（按优先级 + 创建时间）
npm run task:run -- 24 --dry      # 只打印将要执行的命令和目录，不真跑
npm run task:run -- 24 --executor claude   # 换执行器
```

`--dry` 会输出执行器路径、参数、工作目录和产物路径，先看一眼再决定跑不跑。

跑完的现场：

- 产物 → `/tmp/agenthub-task-<id>.md`，并已 PATCH 到任务单上；
- 任务状态 → `review`（待验收）；
- 执行器原始输出 → `~/.agenthub/watcher/runs/<id>.log`；
- 账本 → `~/.agenthub/watcher/ledger.json` 记 `done` / `failed`。

## 三种触发方式

| 方式 | 延迟 | 命令 | 花不花额度 |
|---|---|---|---|
| 常驻 daemon（WebSocket 推送） | 秒级 | `npm run daemon` | run 模式花 |
| 手动 | 你敲的那一刻 | `npm run task:next` | 花 |
| WorkBuddy 定时任务 | 最迟 1 小时 | 「AgentHub 任务单监听（自动接手）」 | 花 |

平台定时任务最小粒度是 1 小时（分钟级 RRULE 会被拒），所以秒级只能靠本机常驻进程。

## 一个绕不过去的限制：daemon 必须从终端（或 launchd）启动

WorkBuddy 的沙箱把桌面端凭据目录设成了 ask 级保护：

```
~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/
```

**从 WorkBuddy 的 agent 会话里启动的进程读不到它**，于是 `codebuddy -p` 起不来。所以：

- ✅ 你自己在终端里 `npm run daemon` —— 沙箱外，能读凭据；
- ✅ launchd 拉起 —— 同样在沙箱外（本机 launchd 目前坏了，见下）；
- ❌ 在 WorkBuddy 对话里让我 `npm run daemon` —— 起来的进程继承沙箱，调不动 WorkBuddy CLI。

反过来，`--executor claude` 没这个问题（claude 的登录态在 `~/.claude`，不受该规则管）。

## daemon 的两种模式

`~/.agenthub/watcher/config.json`：

```json
{
  "executor": "workbuddy",
  "workbuddyPort": 50999,
  "runTimeoutMinutes": 30,
  "daemon": { "mode": "run", "sweepMinutes": 10, "executor": "workbuddy" }
}
```

- `notify`：只弹系统通知，不花额度。
- `run`：收到就交给 `task-run.mjs` 干完，成功转待验收、失败记一笔。

`executor` 决定谁干活：`workbuddy`（默认，应用自带 CLI）/ `claude`（`/usr/local/bin/claude`）。`daemon.executor` 不写就跟随顶层。

`workbuddyPort`：CLI 启动时会在 `127.0.0.1` 上占一个端口，桌面端开着时默认端口可能撞车（`EADDRINUSE`），给个固定端口最稳。

## 执行失败怎么落

| 情况 | 处理 |
|---|---|
| 退出码 0 且有产物 | 转「待验收」 |
| 退出码 0 但没写产物 | 用执行器输出的尾部自动攒一份产物，再转「待验收」 |
| 端口冲突 `EADDRINUSE` | **不记失败**，释放账本，提示设 `workbuddyPort` |
| 读不到凭据 | **不记失败**，释放账本，提示从终端/launchd 启动 |
| 其它非零退出 | 记 `failed`，单子留在待办；同一张单失败一次后不再重试 |
| 超过 `runTimeoutMinutes` | 记 `failed`，原因写「超时」 |

前两种环境问题不占用「失败一次」的名额，否则一次端口冲突就把单子永久拉黑。

## 什么样的单会被接

五道筛子全过才算候选：

1. `status` 是「待办」（`includeDoing` 打开后「进行中」也算），不在离线派发队列里，没挂会话——挂了会话说明已经有人在跑；
2. 账本里没有它的记录（接过、失败过的都不再碰）；
3. 任务单上的电脑在本机清单里（`machineAliases`）；
4. 任务单上的目录能落到本机一个真实存在的目录（`cwdMap` 映射或本来就是本机路径）；
5. 单上没指定别的执行工具——写了 Claude / Codex / ZCode 的活是派给那台机器执行器的，不抢（`respectAgent: false` 可关掉这条）。

排序按优先级（high → low），再按创建时间，每轮最多 `maxPerRun` 张。

### 为什么只看「待办」

AgentHub 里 **WorkBuddy 是只读 agent**，派不出去：

- 前端下拉根本没有 WorkBuddy（`src/lib/agents.ts` 的 `DISPATCHABLE_AGENTS` 把 doubao / workbuddy 排除了），只有 Claude / Codex / ZCode；
- 服务端 `/tasks/:id/start` 也会硬拒：`agent === 'workbuddy'` 直接 400「豆包、WorkBuddy 只做状态监听，请在客户端里执行后把会话关联到任务」。

所以「派活」这条路 WorkBuddy 接不了。它能接的是**建了单、选好电脑和目录、但没点开始**的任务单。

要把这条路真正打通（在 App 里看到执行过程），得改三处：执行器加一个 `run_workbuddy`（`src-tauri/src/runner.rs:2185` 的 match）、服务端白名单（`server/src/routes.ts:483`）、前端 `LISTEN_ONLY`。那需要重编译桌面端。

## 为什么能做到秒级

不用轮询。服务端在任务新建、改动、确认、派发、删除时都会往 `/ws` 推 `{type:'task', task}`（`pushTask`），daemon 挂在同一条 WebSocket 上，单子一落库就到手——实测建单与发现是同一秒。

同一张单只处理一次（记在 `notified.json`，保留最近 200 条）。断线按 2s→4s→…→60s 退避重连，重连后立刻补一次全量探测；另外每 `sweepMinutes`（默认 10）分钟兜底巡检一次，防止连接静默假死。

## 开机自启（暂时不可用）

`~/Library/LaunchAgents/top.wondergarden.agenthub.tasknotify.plist` 已备好（`KeepAlive`，崩了 30 秒后重拉，用系统的 `/usr/local/bin/node`，不受 WorkBuddy 升级影响）：

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/top.wondergarden.agenthub.tasknotify.plist
launchctl print gui/$(id -u)/top.wondergarden.agenthub.tasknotify | head   # 确认 state = running

# 卸掉
launchctl bootout gui/$(id -u)/top.wondergarden.agenthub.tasknotify
rm ~/Library/LaunchAgents/top.wondergarden.agenthub.tasknotify.plist
```

**注意**：本机 launchd 目前对新任务一律返回 `Bootstrap failed: 5: Input/output error`——连 `/bin/sleep 999` 这种最小 plist 也装不进去，说明是系统域的状态问题，不是配置写错（同一份文件早先还能正常 `bootstrap` 并跑起来）。重新登录或重启后 launchd 域会重置，plist 届时自动生效。在那之前用 `npm run daemon` 手动跑，功能一样，只是关掉终端就停。

## 状态文件

都在 `~/.agenthub/watcher/`，不在仓库里：

| 文件 | 作用 |
|---|---|
| `config.json` | 服务端地址、机器名与别名、目录映射、执行者、daemon 模式 |
| `ledger.json` | 账本：每张单去过哪一步（`working` / `done` / `failed` / `baseline`） |
| `notified.json` | 已经通知过 / 处理过的任务 id，防止同一张单反复打扰 |
| `daemon.log` | 常驻进程的连接、发现、开工、重连记录 |
| `runs/<id>.log` | 每次执行的完整输出，出问题看这里 |
| `lock.json` | 并发锁，45 分钟没释放视为失效 |

`config.json` 首次运行自动生成，默认把 `D:\Work2\` 映射到 `~/Work/`。要加别的机器或目录，直接改 `machineAliases` 和 `cwdMap`，不用改代码。映射不上时脚本会把单子放进 `blocked` 报出来，而不是猜一个目录乱跑。

## 凭据

- **AgentHub**：不新存一份密码，默认读桌面端已登录的 token（macOS `~/Library/Application Support/com.wenbo.agenthub/config.json`，Windows `%APPDATA%\com.wenbo.agenthub\config.json`）。也可以用 `AGENTHUB_URL` / `AGENTHUB_TOKEN` 覆盖。
- **WorkBuddy CLI**：复用桌面端登录态（`~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`），不额外存密码；但只对沙箱外的进程可读，见上文。

## 边界

- 只回写「产物 + 待验收」，不替人点验收通过；验收还是人来看。
- 不碰 git 提交与推送，除非任务单自己写明。
- 任务单里的 `constraints`（`paths` / `net` / `push` / `scripts` / `note`）就是执行边界，会逐条写进给执行器的 prompt，越界不做。
- 执行器只能在单上写的目录里改文件。

## 关掉 / 重开

监听有三个入口，关的时候要一起关：

```bash
# 1. 常驻进程
pkill -f scripts/task-daemon.mjs

# 2. 开机自启（plist 已改名，标签也已 disable）
launchctl disable gui/$(id -u)/top.wondergarden.agenthub.tasknotify
mv ~/Library/LaunchAgents/top.wondergarden.agenthub.tasknotify.plist{.disabled,}   # 恢复用，反向 mv

# 3. WorkBuddy 定时任务「AgentHub 任务单监听（自动接手）」→ 在「定时任务」里暂停
```

重开：`npm run daemon`；自启恢复 `launchctl enable` + `bootstrap`；定时任务点继续。
脚本和 `~/.agenthub/watcher/` 里的账本都留着，随时可以再开。
