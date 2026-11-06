# Hub Worker 轮询接入指南

AgentHub 任务队列（`127.0.0.1:47822`）的 worker 接入方式。当前是分单模式：发单时指定 worker，各 worker 只拉自己队列的单。

## 接口速查

| 端点 | 方法 | 说明 |
|---|---|---|
| `/hub/tasks` | POST | 发单 `{title, body, worker, workspace}` |
| `/hub/claim?worker=X` | GET | 拉单（无单返回 `{"empty":true}`） |
| `/hub/ack` | POST | `{taskId}` 确认接单（Dispatched→Running） |
| `/hub/heartbeat` | POST | `{taskId}` 续约（Running 10 分钟超时） |
| `/hub/report` | POST | `{taskId, ok, summary, artifacts, retry}` 回报 |
| `/hub/ping?worker=X` | GET | 报到 + 查负载 `{queued, running}` |
| `/hub/tasks?state=queued` | GET | 任务列表 |
| `/hub/workers` | GET | worker 一览（最近报到时间 / 负载） |

鉴权：`config.json` 里 `hubToken` 非空时，所有请求需带 `Authorization: Bearer <hubToken>`；为空时本机回环不鉴权。

## 发单示例

```bash
curl -s -X POST http://127.0.0.1:47822/hub/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "给 README 补安装说明",
    "worker": "workbuddy",
    "workspace": "D:/Work2/AgentHub",
    "body": "## 目标\n...\n## 约束\n...\n## 验收标准\n- ...\n## 回报\n完成后 report，附产物路径"
  }'
```

**工单 body 必须自包含**（背景 / 约束 / 验收标准），worker 是无上下文拉单的。

---

## WorkBuddy：内置自动化轮询（推荐先跑通这条）

WorkBuddy 支持「自动化 → 定时任务」。新建一个**每 10 分钟**的自动化，prompt 整段粘贴（按需改 worker 名和 token）：

```text
你是 AgentHub 的任务 worker（worker 名：workbuddy）。按以下步骤机械执行，全程不要询问用户，不要做单子以外的任何事：

1. 拉单：执行 curl -s "http://127.0.0.1:47822/hub/claim?worker=workbuddy"
2. 如果返回内容包含 "empty":true，本轮结束，直接回复"无单"。
3. 如果返回任务 JSON：记下 id、title、body、workspace 四个字段。立即确认接单：
   curl -s -X POST http://127.0.0.1:47822/hub/ack -H "Content-Type: application/json" -d '{"taskId":"<id>"}'
4. 严格按 body 里的工单内容执行。body 是自包含的工单（含背景、约束、验收标准）；工作目录用 workspace。不要偏离工单范围。
5. 执行期间每完成一个主要步骤就续约一次：
   curl -s -X POST http://127.0.0.1:47822/hub/heartbeat -H "Content-Type: application/json" -d '{"taskId":"<id>"}'
6. 全部验收标准通过后回报完成：
   curl -s -X POST http://127.0.0.1:47822/hub/report -H "Content-Type: application/json" -d '{"taskId":"<id>","ok":true,"summary":"<一句话结果>","artifacts":["<产物文件路径>"]}'
7. 如果做不完 / 验收不通过 / 出错，回报失败（AgentHub 会自动回队重派，最多 3 次）：
   curl -s -X POST http://127.0.0.1:47822/hub/report -H "Content-Type: application/json" -d '{"taskId":"<id>","ok":false,"summary":"<失败原因>"}'
8. 回报完成后本轮结束。整个过程中不要向用户提问。
```

要点：

- **频率别太密**：每次触发都是真实的模型调用，空轮询也烧额度，≥5 分钟为宜。
- **忙时不拉（可选）**：在步骤 1 之前加一步 `curl -s "http://127.0.0.1:47822/hub/ping?worker=workbuddy"`，返回 `running` 大于 0 就直接结束——同一 worker 的自动化触发撞上正在跑的单时避免重复接。
- hubToken 配置后，每条 curl 都要加 `-H "Authorization: Bearer <token>"`。

## 豆包：两条路线

### 路线 A：豆包定时任务直接跑同款 prompt（待验证）

豆包 Work / 桌面版自带「自动任务」。如果它的任务能调用本地命令/连接器执行 curl，可直接复用上面的 WorkBuddy prompt（把 worker 名改成 `doubao`）。限制：豆包对本地 shell 的开放程度待验证。

### 路线 B：外部脚本驱动（doubao-cli / CDP，可控性最好）

在 AgentHub 侧跑一个轮询脚本（Windows 计划任务 / 常驻进程）：

1. `curl /hub/claim?worker=doubao` 拉单；
2. 有单则通过 `doubao-cli`（社区 CDP 方案，`doubao sessions create "<工单>" --wait`）把工单正文发给豆包并等结果；
3. 按结果调 `/hub/report`。

这条路派发、回报都由脚本控制，不依赖豆包自身工具能力，但依赖豆包桌面版 CDP 端口（`--remote-debugging-port`），版本更新可能失效。

## 状态机与超时（发单方需要知道的）

```
Queued →(claim)→ Dispatched →(ack)→ Running →(report ok)→ Done
                                     └→(report !ok)→ Queued（重派）/ Failed（超 3 次）
Dispatched 5 分钟未 ack → 回队 / Failed
Running 10 分钟无心跳 → 回队 / Failed
```

也就是说：worker 死了单子不会丢，最多重派 3 次后判 Failed 并记录最后失败原因（`GET /hub/tasks` 可查）。
