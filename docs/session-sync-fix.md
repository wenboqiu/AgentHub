# 会话名称与运行状态同步修正

日期：2026-11-01。

## 原因与修正

- Codex 旧采集器只取首条用户消息，服务端又优先保留既有标题。现在采集器优先读取 `.codex/session_index.jsonl` 的 `thread_name`，服务端接受 Codex 的新标题。索引重复记录取最后一个非空名称。
- Claude 仅靠 hook 驱动状态；遗漏 Stop 后，即使本机注册表已变为空闲或 shell，服务端仍显示 running。现在每 15 秒核对本机同一账号、同一机器的会话。注册表明确为 idle/shell，且状态更新时间不早于服务端运行事件，才纠正为空闲。
- Codex 最后一个生命周期事件明确完成或中断，且不早于服务端事件时，补报最终状态。超过 5 分钟仍找不到会话记录（含归档目录）的遗留运行记录转为 unknown，移到“其它”并显示“状态未知”；新会话暂不校正，为 rollout 创建保留时间。存在会话记录但没有结束事件时保留状态，不按运行时长强制完成。
- 核对消息带 `expectedAt`。服务端仅在事件时间仍与读取版本一致时接受；核对期间已到达的新运行事件受到保护。校正为 quiet，不制造重复完成通知。
- Codex 核对只读取文件末尾 256 KiB，避免每次重读完整长会话。状态核对不修改 Codex/Claude 本地会话文件或设置。

## 本机定位结果

- 当前聊天在 Codex 名称索引中为“检查同步计划是否可执行”，旧服务端显示首条消息。
- 截图中的 Claude 会话本机状态为 shell，服务端仍为 running。
- 截图中的 Codex `cwd` 记录来自早期临时验证项目 `agenthub-spike/cwd`。

## 验证与交付

- `server/ npm run check` 通过。
- `server/ npm test` 50/50 通过，含新增改名/并发核对保护回归。
- `src-tauri/ cargo test --lib` 49/49 通过，含名称索引、空闲/运行、旧状态、缺失记录及无证据保留检查。
- 更新后的 Windows 安装包需要配合更新服务端代码；本次未部署线上服务，也未覆盖安装用户的桌面应用。
- Android 前端补充“状态未知”的显示，原生代码无需改动；手机显示结果随服务端广播更新。
- Windows 和 Android 打包均退出 0；APK 签名校验通过，Gradle daemon 已停止。

| 产物 | 字节数 | SHA-256 |
|---|---|---|
| `src-tauri/target/release/bundle/nsis/AgentHub_0.5.0_x64-setup.exe` | 2,209,845 | `39E1B66F157641CD9191060D144437FC726FD28A46EFA698198CC6CD28CACE31` |
| `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk` | 6,190,543 | `49D7CC925ED1A5FAF5A426031FB9C6A6FF85716A5E641498AEC34F51B887E1A1` |
