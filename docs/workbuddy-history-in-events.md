# WorkBuddy 正文随事件上报（不再依赖电脑端在线）

日期：2026-11-07。

## 现象

待处理列表里的 WorkBuddy 会话（Mac 旧名 `my-pc` 的两条、`DESKTOP-OHIULGU` 的一条）点开永远是空的，
右上角刷新按钮是灰的。服务端接口实测返回 `409 电脑端不在线`，`/machines` 里这两台都是
`online: false`，但它们的会话状态、标题、摘要一直在更新。

## 根因

1. WorkBuddy 是只读监听，正文只存在那台电脑的
   `%USERPROFILE%\.workbuddy\projects\<工作区>\<sessionId>.jsonl`，服务端库里只有状态事件，没有消息。
2. 拉正文走 `history.request` 往返，而执行器 WebSocket 只在设置里勾了「允许手机远程执行」
   （`config.remote_enabled`）时才连。没勾的电脑永远不在 `executors` 里。
3. 状态事件走的是 `/events` HTTP 上报，**不需要**这个开关。于是出现「状态一直在变、正文永远拉不到」。
4. 前端 `online = agents.includes(session.machine)` 为假时刷新按钮直接禁用，点了也没提示。

## 改法：正文跟着状态事件一起上来

- 协议（`forwarder::Event`）新增可选 `messages: [{ role, text, at }]`，`skip_serializing_if` 为空，
  没正文的事件不多一个字节。
- `workbuddy.rs` 滚动跟踪时把可见正文收进 `FileState.msgs`：用户消息在状态转 running 时一起发，
  助手回复在完成判定（`confirm_quiet` → done）时一起发；注入块（system-reminder / task-notification /
  cb_summary）沿用原有规则，不当作消息。单条上限 4000 字、一轮最多 30 条。
- 启动首轮登记（`register`）额外读 transcript 尾部 512 KiB，把最近 24 条正文一起带上——
  早先没同步过的老会话（就是上面那三条）在对应电脑的 AgentHub 升级后会自动补齐，
  不需要开远程执行，也不用点刷新。
- 服务端 `appendEventMessages()` 按 `(role, 正文, 时间到秒)` 去重后插入，并顺路累加
  `session_activity` 桶；有新增才广播 `session.history` 让详情页重载。正文相同但时间不同的
  （连说两次「继续」）照常各自入库。
- `forwarder` 发送前按序列化字节数再切批（512 KiB），避免 100 条带正文的事件撞上服务端
  1 MiB 的 `bodyLimit` 而整批卡在重试里。
- 详情页空态文案改成「上报状态时会把正文一起带上来，不用手动同步」。

原生的 `history.request` 链路保留：电脑端在线时它仍然是更准的整段快照（会整段替换库里的记录）。

## 验证

- `cargo test --lib`：128 通过（新增 workbuddy 三条：正文随事件带出 / 注入块不当作消息 / 文本与条数上限；
  forwarder 一条：按字节切批）。
- `server npm run check` 干净；`test/workbuddy-history.test.ts` 2/2 通过（新增「电脑端不在线也能落库、
  重复上报不产生重复消息」）。
- 全量 `server npm test` 仍有既有失败（remote 2 个、notify 时间敏感若干、tasks 提醒 1 个），
  已用 `git worktree` 在 HEAD 上复跑确认与本次无关。
- 前端 `tsc` 干净、46 个单测通过。

## 生效前提

1. 服务端要部署这版代码；
2. 每台跑 WorkBuddy 的电脑要更新 AgentHub 桌面端（Mac 上得用 Mac 编）。
