# 任务管理 0.5.0 实施与验证记录

日期：2026-11-01。原有宽屏样式与计划已独立提交为 `5d2bca0`；任务管理与后续 UI 优化已提交为 `58a3cfe`，未推送、未部署。最新界面与重新打包记录见 [UI 验证记录](ui-review/README.md)。

## 实现范围

- 目标、任务、关联会话的持久化和账号隔离；增量建表，保留 0.4 数据。
- CRUD、关联/取消关联、从任务新开 Claude/Codex 会话；与原 spawn 共用创建和发送路径。
- 创建临时会话、run、首条消息、挂接和任务 doing 状态使用同一事务。发送失败保留失败会话和进行中任务，便于重试。
- 临时 ID 改名及重复挂接合并；完成事件先到时，改名后补算任务状态。
- doing → review、review → doing 的自动流转；开始已完成任务时清空 doneAt。
- WebSocket snapshot 与增量广播；任务/目标列表、详情、进度、会话关联入口；多层返回导航和临时 ID 历史映射。
- HTTP 慢响应不覆盖较新的 WebSocket 状态，包括同毫秒事件；增加对应测试。
- 版本号更新到 0.5.0；README 和服务端接口文档已更新。

## 自动检查

| 检查 | 结果 |
|---|---|
| `server/`: `npm run check` | 通过 |
| `server/`: `npm test` | 49/49 通过，含原有 39 项及新增 10 项 |
| `node --test test/*.test.ts` | 6/6 通过 |
| `npm run build` | 通过 |
| `src-tauri/`: `cargo test` | 47/47 通过 |
| `npm run tauri build` | 最终前端修正已打入 0.5.0 Windows 安装包，退出码 0 |
| Android release APK | 通过；Gradle daemon 已停止，未安装到设备 |

新增测试覆盖 CRUD/文本清洗、字段校验、跨账号读写与挂接隔离、重复挂接、清理会话后保留关系、自动流转、多会话、消息优先级、单机自动选择、空 sessionKey 的 fresh 协议、改名乱序与冲突合并、执行器发送失败、广播隔离、CORS PATCH、旧 schema 增量迁移与重复执行。

## 桌面端到端

使用本地 `127.0.0.1:3000`、临时账号、`E2E-PC` 和系统临时目录。配置中只允许该临时项目；没有修改用户真实 Claude/Codex 会话、hook 设置或 Codex 配置。

1. 桌面窗口显示会话/任务/目标标签，任务和目标可打开。
2. 从任务启动 Claude，新会话跳转正常，临时 ID 改为真实 ID，挂接保留。
3. Claude 账号额度阻断正常回复，原始返回：`You've hit your weekly limit · resets Nov 2, 10pm (Asia/Shanghai)`。后续 Claude 完成事件使任务进入待验收；这不代表模型成功执行了提示。
4. 将同一任务执行工具改为 Codex 并保存，再开独立会话；实际收到 assistant `OK`，任务自动进入待验收，两个会话都保持挂接。
5. 会话返回原任务成功；手动改为已完成并保存，目标进度显示 `1/1`。
6. 已检查约 520px 窄窗口和最大化宽窗口的任务详情、任务列表、目标进度，无明显重叠。
7. Codex 测试线程 `01a195a2-9814-7ac0-9570-4e7e641091d4` 已通过 `thread/archive` 归档；本次临时项目的 Claude 会话目录已清理。
8. 原 `config.json` 按字节恢复并核验一致；原安装版恢复监听 `127.0.0.1:47821`；测试账号已删除，本地 3000 服务停止，9333 无监听。没有覆盖安装桌面版本，也没有安装到手机/平板。

## 验收缺口

- Haiku 的正常 OK 回复受账号周限额影响；已用实际 Codex 会话跑通完整完成流程，但不能声称 Haiku 正常回复验收通过。
- 原生桌面的 `400×800` / `1400×800` 精确尺寸截图未完成。后续 UI 优化已用隔离数据完成这两个尺寸的浏览器检查与截图，见 [UI 验证记录](ui-review/README.md)；该检查不替代原生 WebView 验收。

因此计划不标记为「全部验证通过」。

## 我自己拍板的假设

- 任务数据逻辑集中在 `server/src/tasks.ts`，由 `db.ts` 的同一迁移锁调用，避免让既有会话数据模块继续膨胀。
- 任务与目标读取也经过现有串行队列，避免读取到改名完成而自动状态同步尚未结束的中间状态；snapshot 构造与 viewer 登记同样串行。
- 验收夹具使用临时账号的有效设备 token 启动测试程序，未通过界面自动操作登录；账号登录仍由现有回归测试覆盖。
- 仅测试进程通过 `ANTHROPIC_MODEL=haiku` 选择模型，产品执行器不指定模型。

## 产物

- `src-tauri/target/release/bundle/nsis/AgentHub_0.5.0_x64-setup.exe`
- `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`
