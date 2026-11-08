# ZCode app-server 协议与执行器接入规格

> 实测版本：ZCode 桌面端 0.17.1（CLI bundle `C:\Program Files\ZCode\resources\glm\zcode.cjs`），系统 Node v22.22.2 / Windows 11。
> 协议源码：`github.com/zai-org/ZCode` → `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/{server,transport,server-operations}.ts`、`packages/shared/src/zcode-protocol/index.ts`。
> 本文所有帧样例都来自本机探针 `inspect.local/zcode-probe/zcode-probe.cjs` 的真实收发（已跑通 create → send → `turn.completed` → 模型回复 `OK1`）。

---

## 0. 结论（先说结果）

- **`zcode app-server --stdio` 可以在裸 CLI 下跑通**：`session/create` → `session/subscribe` → `session/send` → 收到 `session/event` 的 `turn.completed`，模型真实回复 `OK1`（input ~24k tokens）。探针退出码 0。
- **裸跑能跑通的前提是三件事**，缺一不可：
  1. `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 指向桌面端内置 provider 配置；
  2. Host 角色补齐 `provider/refreshRegistry` + `provider/updateAccountConfig`（否则 Provider Registry 为空，`model.available: []`）；
  3. Host 响应 `interaction/requestProviderRuntimeHeaders` 并注入 **Project Access Token**（用本地 OAuth 凭证换取），否则报 `Provider runtime headers were not applied before model request attempt`。
- **`ERA_NEGOTIATION_FAILED` 与 app-server 协议本身无关**，它是 MCP 双 Era 协商错误：CLI 对 `~/.zcode/cli/config.json` 里的 `node_repl` 做 MCP `server/discover` modern 探测时，子进程被关闭。app-server 模式下该配置文件因 schema 不合法被整条跳过，所以不触发；`-p` 模式会触发（详见 §9）。
- **`zcode -p` 无头 one-shot 在裸环境不可用**：先报 `Select a model before sending a message`（registry 为空），随后退出清理阶段抛 `ERA_NEGOTIATION_FAILED`。不建议作为 AgentHub 的执行通道。

---

## 1. 进程入口与启动形态

### 1.1 命令行

```bash
# 桌面端实际用法（Host 侧 spawn，args 见 zcodeAgentProcessManager.ts）
node "<install>/resources/glm/zcode.cjs" app-server --stdio --surface desktop
# agent-server --stdio 是同能力别名
```

- `--cwd <path>` 决定进程工作目录；`app-server` 自身的协议 `workspace` 与 cwd 是可分离的（cwd 只影响文件/命令，身份用 workspaceKey）。
- `--surface desktop` 只影响展示语义，不影响 stdio 帧。
- 桌面端不是用独立 node，而是 Electron 自带运行时 + `ELECTRON_RUN_AS_NODE=1` 跑同一个 `zcode.cjs`；用系统 Node 22 同样可跑（本机实测）。

### 1.2 输出边界（硬约束）

- **stdout 只能是协议帧**：严格 NDJSON，`JSON.stringify(message) + "\n"`，LF 分帧；reader 可容忍帧尾 CRLF，但不得 trim/改写帧内字符串。
- `console.log/info/warn/debug/error` 以及所有依赖日志**全部写 stderr**。任何非 JSON 的 stdout 行都视为协议违规。
- 空行会被忽略；超长 payload（如 `process/networkRequests`）在 stdout 背压 >256KB 时允许直接丢弃（可观测数据）。

---

## 2. 帧信封（wire format）

不是标准 JSON-RPC：**没有 `jsonrpc: "2.0"` 字段**。四种帧（严格 schema，未知字段会触发 `-32602 Invalid params`）：

```jsonc
// 1) client -> server 请求（id 为 string 或 int）
{ "id": "probe-1", "method": "session/create", "params": { /* ... */ }, "trace": { /* 可选 */ } }

// 2) server -> client 应答
{ "id": "probe-1", "result": { /* ... */ } }

// 3) 错误应答
{ "id": "probe-1", "error": { "code": -32603, "message": "…", "data": { /* 可选 */ } } }

// 4) 通知（无 id；双向）
{ "method": "session/event", "params": { /* ... */ } }
```

要点：

- `id` 由请求方自由生成，应答原样回传；服务端反向请求用 `server-N` 自增 id。
- 错误码：`-32700` 解析失败、`-32600` 非法消息、`-32601` 未知方法、`-32602` 参数 schema 不合法、`-32603` 内部错误；业务错误用 `-320xx`（例：`-32010` 会话已有运行中的 prompt、`-32019` registry refresh 未配置）。
- 传输层并发模型：普通请求串行排队（长模型任务会阻塞队列），少数方法旁路（`session/stop`、`workspace/cancelGenerateText`、MCP App 相关、`session/lifecycle/*`、V4 subscribe/command）。**应答与同一请求的后续通知有确定性顺序**：先写 response，再写该请求的 outbox。

### 2.1 没有 initialize 握手

协议 **没有** `initialize` / `initialized` / 版本协商握手。进程起来后直接可以发 `session/create`。启动期间服务端会主动推送存储状态通知：

```json
{"method":"startup/storageState","params":{"schemaVersion":1,"attemptId":"…","sequence":1,"databaseId":"ed2a…","databaseKind":"session","phase":"checking","elapsedMs":0}}
```

`phase` 枚举：`checking | waiting_for_lock | migrating | committing | ready | failed`；`databaseKind`：`session | tasks-index`。**`phase: "ready"` 之前发出的 create 会被排队等待**（实测第一条 ready 前发请求也不会失败，但建议等到 ready 再 create，避免误判启动卡死）。

---

## 3. 进程生命周期

```text
starting ──初始化完成──> serving ──stdin EOF──> draining ──(已接收请求完成 或 100ms)──> stopping ──> exited
   │                        │
   └── stdin/stdout 错误、信号、未捕获异常 ─────────────────────────────> stopping ──> exited
```

- **优雅关闭 = 关闭 stdin（EOF）**。EOF 后停止接单，已接收请求可完成，最多 drain 100ms；清理+flush 上限 1500ms。桌面端契约是「先 EOF，宽限 1800ms，再强杀进程树」。
- 不要只用 `taskkill /PID`（Windows）或 `SIGKILL` 杀父进程：CLI 会派生 MCP 子进程（`node_repl`、documents/presentations/pdf/spreadsheets 等 builtin），需要按进程树回收。
- stderr 断裂不影响协议服务（只标记出口不可用）；stdout 破裂（EPIPE）则整个连接 epoch 终止，旧订阅不可复用。
- 服务端关闭顺序：拒绝新请求 → 取消反向请求/运行 → 关闭 app → 释放 gateway。**不会**广播 `session.removed`，也不删持久会话文件。

---

## 4. 方法面（v1）

`zcodeProtocolMethods` 全集见 `packages/shared/src/zcode-protocol/index.ts`。执行器真正需要的子集：

| 方法 | 用途 | 备注 |
| --- | --- | --- |
| `session/create` | 建会话 | 返回完整 snapshot，`sessionId` 在 `result.session.sessionId` |
| `session/resume` | 冷恢复已有会话 | 入参只给 `sessionId`（+ workspace 可选） |
| `session/subscribe` | 订阅事件流 | **必须先订阅再 send**，否则事件不推 |
| `session/send` | 发一条用户输入 | 需要 `modelSelection` |
| `session/stop` | 中断当前回合 | 旁路队列，能在模型运行中送达 |
| `session/close` | 卸载会话 | CLI 常驻时可保留；AgentHub 单轮用完可省 |
| `session/read` / `session/messages` / `session/events` | 读快照/消息/事件补洞 | `session/events {afterSeq}` 用于断线补齐 |
| `session/list` | 列 workspace 下会话 | 可选 `workspace`/`sessionIds`/`limit` |
| `session/setModel` `session/setThoughtLevel` `session/setMode` | 改配置 | 旧链路；新链路走 V4 `switchModelConfig` |
| `workspace/readState` | 读 workspace 状态 | 轻量 |
| `provider/refreshRegistry` | 重算 provider registry | **裸跑必需** |
| `provider/updateAccountConfig` | 下发账号 provider 配置 | **裸跑必需** |
| `process/childProcesses` | 列 MCP 子进程 pid | 资源回收用 |

另有 V4 主链路（`v4/command`、`conversation/<sessionId>` topic 等，见 §8），**执行器无需使用**，v1 方法足够完成「建会话 → 发消息 → 收完成」。

### 4.1 `session/create`

请求：

```json
{"id":"probe-1","method":"session/create","params":{
  "workspace": {
    "workspacePath": "C:\\Users\\…\\Temp\\zcode-probe-ws-XXXX",
    "workspaceKey":  "C:\\Users\\…\\Temp\\zcode-probe-ws-XXXX"
  }
}}
```

`workspace` 严格 schema：`{ workspacePath, workspaceKey, workspaceIdentity?, remoteSessionId? }`（全部字符串；`workspaceKey = workspaceIdentity?.trim() || workspacePath`）。
可选入参：`sessionId`（自选 id）、`mode`（`plan|build|edit|yolo|guarded|auto`）、`model`（`{providerId, modelId, options?}`）、`thoughtLevel`、`mcpServers[]`、`toolAllowlist[]`/`toolDenylist[]`、`persistence`、`additionalDirectories[]`、`titleGenerationEnabled`、`offPeakToolEnabled`、`dynamicWorkflowEnabled`。

响应（实测）：

```json
{"id":"probe-1","result":{
  "messages": [],
  "projection": {"activeToolCalls":[],"backgroundJobs":[],"contextUsed":0,"contextWindow":200000,
                 "mode":"build","pendingPermissions":[],"sessionId":"unknown","status":"idle",
                 "target":null,"totalTokenCount":0,"turnCount":0},
  "protocol": {"name":"ZCode Protocol","version":1},
  "runtime": {"eventSeq":0,"stateRevision":0,"pendingRequestIds":[],"goalVerifications":[],"goalVerificationTimeline":[]},
  "session": {"sessionId":"sess_04f320d8-…","sessionKind":"interactive","createdAt":1793852900123,
              "mode":"build","traceId":"…"},
  "settings": {"mode":{"current":"build"},
               "model":{"available":[], "current":null},
               "permission":{"mode":"build"},
               "thoughtLevel":{"available":[],"enabled":false}},
  "slashCommands": [], "todos": [], "todoGroups": []
}}
```

- **`sessionId` 在 `result.session.sessionId`**（`projection.sessionId` 在 create 返回里是占位 `"unknown"`，别用）。
- `settings.model.available` 初始为空是正常的——它表示「当前 host 没有下发 provider」，不是错误。
- 实测耗时：**首次 create 约 20s**（要等官方 MCP 鉴权与 workspace 初始化），后续会话毫秒级。超时预算建议 ≥120s。

创建过程中服务端会推生命周期通知并**发起反向请求**（见 §7），不答或答错会直接导致 create 失败：

```json
{"method":"session/lifecycle/changed","params":{"sessionId":"sess_…","state":"starting","generation":1,"revision":1,"lastError":null}}
{"id":"server-1","method":"session/requestRuntimePreferences","params":{"sessionId":"sess_…","scope":"runtime-materialization"}}
{"method":"session/lifecycle/changed","params":{"sessionId":"sess_…","state":"ready","generation":1,"revision":2,"lastError":null}}
```

`state` 枚举：`starting | ready | stopping | unloaded`；失败时 `lastError: {operation, code, message}`。

### 4.2 `session/subscribe`

```json
{"id":"probe-2","method":"session/subscribe","params":{
  "sessionId":"sess_…",
  "deliveryKind":"desktop-continuous",
  "includeSnapshot":false,
  "afterSeq": 0
}}
```

```json
{"id":"probe-2","result":{"sessionId":"sess_…","eventSeq":0,"events":[]}}
```

- `deliveryKind`：`desktop-continuous` | `web-remote-replayable`（恢复语义不同；执行器用前者）。
- `afterSeq` 有值时，会把该水位之后的历史事件塞进 `result.events`；`includeSnapshot:true` 时额外带 `snapshot`。
- 订阅 ACK **不内嵌 snapshot**；之后的事件以通知 `session/event` 推送。
- 断线重连：拿最后 `seq` 作为 `afterSeq` 重新 subscribe；出现 gap 就 `includeSnapshot:true` 收敛。

### 4.3 `session/send`

```json
{"id":"probe-5","method":"session/send","params":{
  "sessionId":"sess_…",
  "content":"只回复 OK1",
  "modelSelection":{
    "providerId":"account:bigmodel-individual-coding-plan",
    "modelId":"GLM-5.3",
    "options":{"reasoningLevel":"high"}
  }
}}
```

```json
{"id":"probe-5","result":{"sessionId":"sess_…","accepted":true,"stateRevision":1}}
```

- **`modelSelection` 必须给**（否则 `CONFIGURATION_ERROR: Select a model before continuing`）；`options.reasoningLevel` 也必须给（否则 `invalid_model_request: Reasoning level is required …`，取值受 builtin 配置 `optionSpecs` 约束，GLM-5.x 实测 `high` 可用，`disabled`/`enabled` 被拒）。
- 同一 session 有运行中回合时再 send 会返回 `-32010 "A prompt is already running for this session"`；要排队必须走 V4 queue。
- 其他可选字段：`inputId`/`queryId`（幂等/关联）、`attachments[]`、`expectedRevision`、`browserAmbientContext`、`toolDenylist[]`、`offPeakTaskId`/`automationId`。

### 4.4 `session/stop` / `session/close`

```json
{"id":"…","method":"session/stop","params":{"sessionId":"sess_…"}}
{"id":"…","method":"session/close","params":{"sessionId":"sess_…"}}   // → {"closed": true}
```

`session/stop` 走旁路队列（不等长任务），约 3s 内回 `turn.failed`/`turn.completed` 终止态；`session/close` 会触发生命周期 `stopping → unloaded`，实测 5–7s。

### 4.5 典型成功时序（实测时间线）

```text
t+0.0s  spawn；<- startup/storageState ×5（…→ ready）
t+3.0s  -> session/create
t+3.9s  <- session/lifecycle/changed starting
t+3.9s  <- server-1 session/requestRuntimePreferences   -> 应答
t+22.6s <- server-2 interaction/requestOfficialMcpAuthHeaders -> 应答 {}
t+22.7s <- session/lifecycle/changed ready
t+22.7s <- probe-1 result（snapshot）
t+22.7s -> session/subscribe      <- result
t+22.9s -> session/send           <- result accepted
t+23.0s <- session/event session.titleUpdated
t+23.1s <- session/event turn.started
t+23.1s <- session/event model.streaming ×N（text_delta "OK1"）
t+23.5s <- session/event turn.completed（response: "OK1"）
```

---

## 5. 事件推送

### 5.1 通知信封

订阅后所有会话事件都是通知：

```json
{"method":"session/event","params":{
  "eventId":"20838a97-…",
  "sessionId":"sess_04f320d8-…",
  "turnId":"turn_3c2af789-…",          // 部分事件有
  "seq":10,                            // 单调递增，断线补齐用
  "traceId":"…",
  "timestamp":1793852912455,
  "deliveryKind":"desktop-continuous",
  "type":"model.streaming",
  "payload":{ /* 按 type 变化，部分 type 无 payload */ }
}}
```

### 5.2 事件类型清单（26 种，`zcodeSessionEventTypeSchema`）

| 分组 | type | payload 关键字段 |
| --- | --- | --- |
| 会话 | `session.created` | `mode`, `contextWindow` |
| | `session.resumed` | 恢复信息 |
| | `session.updated` | `patch`（任意对象，含 model 可用列表等） |
| | `session.titleUpdated` | `title`, `previousTitle`, `source` |
| | `session.closed` | `reason?` |
| 回合 | `turn.started` | `messageId`, `input`, `turnNumber`, `executionStartedAt` |
| | `turn.completed` | `response`, `stopReason`, `usage{inputTokens,outputTokens,totalTokens,cacheReadTokens…}`, `content` |
| | `turn.failed` | `error{type,code,message,detail,attribution{…},stack}` |
| | `turn.steerQueued` / `turn.steerDrained` | 排队引导 |
| 消息 | `message.upserted` / `message.removed` | 整条消息 |
| | `part.started` / `part.delta` / `part.upserted` / `part.removed` | 消息片段（文本增量走这里） |
| | `model.streaming` | `assistantMessageId`, `delta`, `done`, `kind:"text_delta"/"reasoning_delta"` |
| 工具 | `tool.updated` | 工具调用状态（含 `kind=scheduled` 兼容事件） |
| 授权 | `permission.requested` / `permission.resolved` | 见 §7 |
| | `userInput.requested` / `userInput.resolved` | 见 §7 |
| 其他 | `checkpoint.created` / `rewind.triggered` / `streamRecovery.updated` | 任意对象 |

除 `session/event` 外，服务端还会推这些通知（执行器可按需忽略）：

- `session/lifecycle/changed`（会话状态机，见 §4.1）
- `state.updated`（`{type:"state.updated", scope:"session", sessionId, revision, patch, reason}`，model/permission/mode 变更）
- `computer-use/operation-event`（CUA 专用，`turn-started`/`turn-completed`/`turn-failed` 等）
- `v4/telemetry/event`（遥测，可忽略）
- `process/mcpTelemetry`、`process/resourceSample`、`process/networkRequests`、`process/toolExecResource`（进程观测，可忽略）
- `startup/storageState`（启动期）
- `plugins/operationProgress`

### 5.3 回合完成判定

**以 `session/event` 的 `turn.completed` / `turn.failed` 为唯一完成信号**（`computer-use/operation-event` 的 `turn-completed` 是另一条平行流，别混用）。实测 `turn.completed` payload：

```json
{"content":"OK1","contextWindow":1000000,"querySource":"main_turn","stopReason":"stop",
 "usage":{"inputTokens":23936,"outputTokens":39,"totalTokens":23975,"cacheReadTokens":8832}}
```

失败示例：

```json
{"error":{"type":"unknown_error","code":"provider_not_found",
 "message":"Provider Registry 中不存在 Provider: account:bigmodel-individual-coding-plan",
 "detail":"Model creation failed","attribution":{"source":"runtime","errorPhase":"model_creation","providerId":"…","modelId":"…","retryable":false}}}
```

常见 `error.code`：`provider_not_found`、`model_not_found`、`invalid_model_request`、`model_request_failed`、`CONFIGURATION_ERROR`；`attribution.errorPhase`：`prepare | model_creation | stream`。

---

## 6. Provider / 凭证（裸跑的关键）

### 6.1 Provider Registry 从哪来

CLI 的 Provider Registry 由进程内 worker 从三处合成：

1. `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` → builtin 模板（`resources/config/provider/zcode-builtin.json`，`revision: 43`）；
2. 本地凭证 `~/.zcode/v2/credentials.json`（OAuth 登录态）；
3. Host 下发的账号配置（`provider/updateAccountConfig`）。

裸跑时 (2) 只让 worker 知道「登录了 bigmodel」，但 builtin 模板里所有 `account:*` provider 都是 **`entitled: false`**，registry 过滤后 **`providerCount: 0`**。表现就是：`settings.model.available: []`，send 报 `Select a model before continuing`。

### 6.2 让 provider 可用：`provider/updateAccountConfig`

```json
{"id":"probe-4","method":"provider/updateAccountConfig","params":{
  "revision":"probe-1793852040368",
  "basedOnZCodeBuiltinRevision":"zcode-builtin:43:d3e2480ce9f8791f5d2ce7b31188c97220ab453de2b4a849db0b0cc4e74b7cf3",
  "providers":{
    "account:bigmodel-individual-coding-plan":{"access":{"type":"zhipu-account","entitled":true}}
  },
  "states":{
    "account:bigmodel-individual-coding-plan":{"availability":"available","entitled":true,"current":true}
  }
}}
```

- `states[id]` 严格 schema：`{availability: "available"|"pending"|"unavailable"|"unknown", entitled: boolean, current?: boolean}`。
- 对 `zhipu-account` 且 `entitled:true` 的 provider，`states[id].current` 必填 boolean，否则 `Account State 缺少 current`。
- `basedOnZCodeBuiltinRevision` 是 CAS 基础版本，形如 `zcode-builtin:<revision>:<sha256>`；**版本升级后 hash 会变**，实现时不要硬编码（见 §12 风险）。
- 推送后 `refreshRegistry` 可选；实测两者都调最稳。推送后 send 不再报 `provider_not_found`。

### 6.3 `interaction/requestProviderRuntimeHeaders`：必须注入 Project Token

每次模型请求前，CLI 会向 client 发起：

```json
{"id":"server-7","method":"interaction/requestProviderRuntimeHeaders","params":{
  "requestId":"sess_…:provider-runtime-headers:…",
  "sessionId":"sess_…","turnId":"turn_…",
  "workspace":{"workspacePath":"…","workspaceKey":"…"},
  "modelSelection":{"providerId":"account:bigmodel-individual-coding-plan","modelId":"GLM-5.3","options":{"reasoningLevel":"high"}},
  "providerId":"account:bigmodel-individual-coding-plan",
  "reason":"…"}}
```

应答（schema 是 **discriminated union**，`headersApplied` 必填）：

```jsonc
// 成功
{"id":"server-7","result":{"headersApplied":true,"requestAuth":{"apiKey":"<project access token>","apiKeyId":"…","accountScope":"<64 hex>?","headers":{"…":"…"}?}}}
// 声明不注入（zhipu-account 下会导致 "Provider runtime headers were not applied before model request attempt"）
{"id":"server-7","result":{"headersApplied":false}}
```

**Project Access Token 换链**（桌面 Host `createAccountProviderCredentialService` → `ProjectAccessTokenClient`，本机已复刻成功）：

```text
OAuth access_token（credentials.json → oauth:bigmodel:access_token，enc:v1 加密）
  → GET  https://bigmodel.cn/api/biz/customer/getCustomerInfo        Authorization: <裸 token>
  → GET  https://bigmodel.cn/api/biz/v1/organization/{org}/projects/{proj}/api_keys
  → POST {keyListUrl}/{apiKeyId}/access_tokens
         body {"clientType":"zcode","clientVersion":"0.17.1"}
  → data.accessToken  ← 作为 requestAuth.apiKey
```

- 凭证解密：`enc:v1:<iv>.<tag>.<ciphertext>`（base64url，aes-256-gcm），密钥 = `sha256(ZCODE_CREDENTIAL_SECRET ?? "zcode-credential-fallback:<platform>:<homedir>:<username>")`。
- 位置缓存就在 credentials 里的 `project-key-location:v1:<urlencoded json>` → `{organizationId, projectId, apiKeyId}`，有缓存就跳过前两步。
- 注意响应字段是 `data.accessToken`（不是 `token`）。
- 直接把 OAuth access_token 当 `apiKey` 传会报 `Client signing requires an API Key or Project Access Token.`。

### 6.4 官方 MCP 鉴权（可选）

创建会话时会收到 `interaction/requestOfficialMcpAuthHeaders {mcpKey:"sites", pluginId:"zcode-site@…", targetOrigin:"https://zcode.z.ai", …}`。返回 `{}` 即可（CLI 随即跳过官方 MCP，代价是 create 多花约 18s 等超时）；返回 `{headers:{…}}` 可启用官方插件。

---

## 7. 服务端 → 客户端阻塞交互

CLI 用反向请求把「需要宿主决策」的阻塞点抛出来。**所有反向请求都必须应答**，否则对应操作挂起到超时/失败。

| 方法 | 触发时机 | 应答 schema |
| --- | --- | --- |
| `session/requestRuntimePreferences` | create 的 `runtime-materialization`、send 的 `user-execution` | `zcodeSessionRuntimePreferencesResultSchema`（strict，见下） |
| `interaction/requestPermission` | 工具需要授权 | `{decision:"allow"\|"deny"\|"escalate"\|"modify", reason?, modifiedInput?, permissionUpdates?[]}` |
| `interaction/requestUserInput` | Agent 提问（AskUserQuestion） | `{value?, cancelled?}` |
| `interaction/requestProviderRuntimeHeaders` | 每次模型请求前 | `{headersApplied:true, requestAuth:{apiKey,…}}` 或 `{headersApplied:false}` |
| `interaction/requestOfficialMcpAuthHeaders` | 官方插件 MCP | `{headers?:{…}}` |
| `interaction/browserList` / `browserExecute` | Browser Use | 浏览器代理能力 |

`requestRuntimePreferences` 最小合法应答（缺字段会被 Zod 拒绝，并让 create 直接失败：

```json
{"id":"server-1","result":{
  "nativeSearchEnhancementsEnabled": false,
  "toolSearchMode": "off",
  "memoryEnabled": false,
  "askUserQuestionAutoResolutionEnabled": true,
  "modelContextBudgetStrategy": "preflight-v1"
}}
```

`requestPermission` 载荷（`zcodePermissionRequestParamsSchema`）：

```json
{"requestId":"…","sessionId":"sess_…","turnId":"turn_…","toolCallId":"…",
 "toolName":"Bash","reason":"…","riskLevel":"low|medium|high|critical",
 "input":{…},"origin":"…","options":[{"id":"…","label":"…","kind":"…"}]}
```

AgentHub 侧建议：`requestPermission` → 复用现有 Codex 审批卡片；默认 30 分钟超时自动 deny；`requestUserInput` → 提问卡片，超时按 `{value:"", cancelled:true}` 回。

---

## 8. V4 主链路（仅了解，不必实现）

- 读：`conversation/<sessionId>`、`sessions-index/<workspaceId>`、`workspace-config/<workspaceId>` topic + `v4/conversation/subscribe`（带 `baseSeq`/`baseLogEpoch`，可续接 delta 或回退 snapshot）。
- 写：`v4/command`（`{commandId, clientId, sessionId, baseRevision?, baseLogEpoch?, type, payload}`），ACK：`accepted|rejected|stale|duplicate|noop|failed`。
- V4 是桌面/手机主链路，能力强（队列、goal、fork、rewind、interaction resolve）；但它需要更完整的 host 状态（registry、projection 水位、logEpoch）。**AgentHub 单轮派活用 v1 足够**，出问题再考虑 V4。

---

## 9. `ERA_NEGOTIATION_FAILED` 根因与解法

### 9.1 它是什么

错误来自 MCP TypeScript SDK（`SdkError(mcpBrand)`，`code: "ERA_NEGOTIATION_FAILED"`）：

> `Version negotiation failed: the transport was closed during the server/discover probe`

ZCode 的 MCP client 支持双 Era（`docs/mcp-dual-era-version-negotiation.md`）：

- **modern**：MCP `2026-07-28`，连接时先发 `server/discover` 探测（在 disposable sibling 进程里跑，≤5s 预算），不发 `initialize`；
- **legacy**：`initialize`/`initialized` 旧握手；
- 普通 server 默认 `auto`：probe 失败视为 legacy 证据，回退 `initialize`；
- **内置 `node_repl` 固定 pin modern**：probe 失败**不允许回退**，直接抛 `ERA_NEGOTIATION_FAILED`。

### 9.2 本机为什么触发

`~/.zcode/cli/config.json` 里配置了：

```json
{"mcp":{"servers":{
  "node_repl":{"command":"C:\\Users\\…\\OpenAI\\Codex\\runtimes\\cua_node\\…\\bin\\node_repl.exe","args":[],"env_vars":[…],"env":{…}},
  "unityMCP":{"url":"http://127.0.0.1:8080/mcp","tools":{…}}
}}}
```

- `node_repl.exe` 来自 Codex 的 CUA 运行时，依赖 Codex 注入的管道/环境；由 ZCode 裸跑拉起时进程瞬间关闭 → probe child 关闭 → pin modern 无回退 → `ERA_NEGOTIATION_FAILED`。
- `unityMCP` 指向未启动的本地 HTTP 服务，但它走 auto，不致命。

### 9.3 为什么 app-server 模式不触发

app-server 的配置加载器对 `mcp.servers[*]` 做严格 schema 校验，本机这份配置两个条目都不合法，被整条跳过（stderr/日志可见）：

```text
config.mcp_server.skipped: <server>: Unrecognized key: "env_vars"   (path: mcp.servers.node_repl)
config.mcp_server.skipped: <server>: Unrecognized key: "tools"      (path: mcp.servers.unityMCP)
```

没有 MCP 连接 → 没有 `server/discover` → 不报 ERA。

### 9.4 解法（按优先级）

1. **走 app-server 通道**（AgentHub 采用）：无需处理；若确实需要 MCP，用 `session/create` 的 `mcpServers[]` 显式下发（而不是依赖 `config.json`）。
2. 修 `config.json`：`env_vars` → `env`（对象）、删除 `tools` 这类非协议字段；或移除 `node_repl`。
3. 给该 server 显式 `"protocolVersion": "legacy"`（跳过 modern probe，直接旧握手）。
4. 保证 `node_repl.exe` 可被独立拉起（其依赖的 Codex 管道/环境存在），或改用 ZCode 自带 `resources/glm/node-runtime`。
5. 与 Node 版本/网络代理无关（本机 Node 22 + 有/无代理均复现同样结论）。

### 9.5 `-p` 无头模式对照结论（实测）

```bash
ZCODE_BUILTIN_PROVIDER_CONFIG_FILE="<install>/resources/config/provider/zcode-builtin.json" \
  node zcode.cjs -p "只回复 OK1" --mode build
```

输出：`Error: Select a model before sending a message (traceId: …)`，随后退出清理阶段抛 `SdkError: Version negotiation failed: the transport was closed during the server/discover probe`（`ERA_NEGOTIATION_FAILED`，栈在 `closeClientAndTransport/failConnection`）。

结论：`-p` 既没有账号 provider 注入通道（无 `provider/updateAccountConfig`、无 `requestProviderRuntimeHeaders` 应答方），又会在清理阶段撞 MCP 协商错误。**不要用 `-p` 作为执行器**；它只适合人工在已登录桌面环境里试水。

---

## 10. 环境变量清单

### 10.1 裸跑 app-server 必需/常用

| 变量 | 作用 | 实测 |
| --- | --- | --- |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | 指向 `<install>/resources/config/provider/zcode-builtin.json` | **必需**，否则报「无法定位 CLI ZCode Built-in Provider Config」 |
| `ZCODE_LOG_DIR` | 日志目录（JSONL，含 `mcp.server.connected`、`provider_registry.ready` 等） | 排查利器 |
| `ZCODE_CREDENTIAL_SECRET` | 覆盖凭证解密密钥 | 可选；缺省用确定性 fallback |
| `ZCODE_DATA_BASE_DIR` | 覆盖数据根（默认 `~/.zcode`） | 可用于测试隔离（未深测） |
| `ZCODE_RUNTIME_ENV` | `production` / `development` | 影响遥测/日志 |
| `ZCODE_APP_VERSION` | 桌面版本号（影响 runtime 缓存目录 `runtime/provider/<platform>/<version>/…`） | 桌面注入 |
| `ZCODE_BASE_URL` / `ZCODE_ENDPOINT_ORIGIN` | 覆盖官方 API origin（默认 `https://zcode.z.ai`） | 私有化/测试用 |
| `ZCODE_HTTP_PROXY` / `ZCODE_NO_PROXY` | provider/http 层代理（优先级高于 `HTTP(S)_PROXY`） | 设置页代理 |
| `ZCODE_AGENT_CA_CERT` / `NODE_EXTRA_CA_CERTS` | 自定义 CA | 可选 |
| `ELECTRON_RUN_AS_NODE=1` | 用 Electron 运行时跑 `zcode.cjs` | 桌面注入；用系统 node 时不需要 |

### 10.2 桌面端 spawn CLI 时实际注入（`zcodeAgentProcessManager.ts`）

```text
cwd   = workspacePath
args  = ["app-server", "--stdio", "--surface", "desktop"]
env   = sanitize(process.env)              # 剔除 NODE_ENV / ELECTRON_RUN_AS_NODE / HTTP(S)_PROXY /
                                           #   ALL_PROXY / NO_PROXY / NODE_EXTRA_CA_CERTS / SSL_* /
                                           #   OTEL_* / ZCODE_TELEMETRY_* / npm_config_*proxy*
      + ZCODE_RUNTIME_ENV=production|development
      + 设置页代理/CA: HTTP_PROXY,HTTPS_PROXY,ALL_PROXY,ZCODE_HTTP_PROXY,NO_PROXY,ZCODE_NO_PROXY,
                       NODE_EXTRA_CA_CERTS,ZCODE_AGENT_CA_CERT,ZCODE_BASE_URL
      + ZCODE_WORKSPACE_IDENTITY=<workspaceIdentity>     # 远程 workspace 才注入
      + GEN_UI_OUTPUT_ROOT=<appConfigDir>/…             # 生成文件根目录
      + ELECTRON_RUN_AS_NODE=1
```

Host 侧环境（Electron utilityProcess）：`ZCODE_PROCESS_LABEL`、`ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED`、macOS 额外 `ZCODE_CUA_LAUNCHER_PID`。

### 10.3 调试/覆盖用（Host 级）

`ZCODE_AGENT_SERVER_COMMAND`、`ZCODE_AGENT_SERVER_ARGS_JSON`、`ZCODE_AGENT_SERVER_CWD`：显式覆盖 CLI 命令（最高优先级）；`ZCODE_DESKTOP_AGENT_BYTECODE=1` 启用字节码入口实验。

---

## 11. 进程生命周期与 workspace 隔离（接入规则）

1. **每个 workspaceKey 最多一个 app-server 进程**。`workspaceKey = workspaceIdentity?.trim() || workspacePath`；`workspacePath` 只用于文件系统与命令 cwd。远程/多窗口场景必须传 `workspaceIdentity`，不能用路径替代身份。
2. 一个进程内可并存多个 session（`sess_*` 是 CLI 侧持久对象，落盘在 `~/.zcode/v2/sessions/<workspace 哈希>/sess_<uuid>.json`，`meta.status`：`running|completed|error`）。
3. 复用规则：
   - 同一 workspace 的连续派活**复用同一进程**（省掉 20s 冷启动与 MCP 初始化）；
   - 进程空闲可保留，但要有上限（内存 + MCP 子进程）；退出用 **stdin EOF → 等 1.8s → 杀进程树**；
   - 修改 provider/代理/CA 后需要重启进程才生效（这些是 spawn 期 env）。
4. 会话级隔离：`session/create` 的 `workspace` 决定文件权限边界；不同 workspace 的会话不能塞进同一进程（CLI 内部按 workspaceKey 分组）。
5. 崩溃恢复：进程异常退出后，先用 `session/list` 找会话，再 `session/resume {sessionId}`；不要重发用户输入（V4 有 commandId 幂等，v1 没有）。
6. Windows 上进程树回收：CLI 派生 MCP 子进程；用 `taskkill /T /F /PID` 或 Job Object；优先 EOF 优雅退出。

---

## 12. AgentHub 执行器实现建议（对照 `src-tauri/src/runner.rs` 的 Codex 模式）

现状：`runner.rs::run_codex` 是「每 run 一个 `codex app-server` 子进程 + stdin/stdout 行协议 + `initialize` 握手 + `turn/start` + 反向 `requestUserInput`/审批请求」。ZCode 可以套用同一骨架，但要改四点：

### 12.1 进程模型

- Codex：每 run 一进程（模型是进程级配置）。
- **ZCode：按 workspaceKey 建常驻进程池**（`HashMap<workspaceKey, Child>`），进程内多 session；模型是 session/请求级参数，不需要重启进程。
- 可选简化：先按 run 起进程（与 Codex 同构，改动最小），代价是每轮多 ~20s；后续再优化成池。
- 关闭：`child.stdin.take() → drop(stdin)` 触发 EOF；等 1.8s；`kill_tree`。

### 12.2 启动参数与环境

```rust
Command::new(node_exe)                     // 系统 node，或 Electron + ELECTRON_RUN_AS_NODE=1
  .arg(zcode_cjs_path)                     // <install>/resources/glm/zcode.cjs
  .args(["app-server", "--stdio", "--surface", "desktop"])
  .current_dir(workspace_path)
  .env("ZCODE_BUILTIN_PROVIDER_CONFIG_FILE", "<install>/resources/config/provider/zcode-builtin.json")
  .env("ZCODE_RUNTIME_ENV", "production")
  // 不要继承宿主代理变量；需要时用 ZCODE_HTTP_PROXY / ZCODE_NO_PROXY 显式注入
```

### 12.3 握手与消息序列（v1）

```text
1. spawn，读 stdout 直到 startup/storageState.phase == "ready"（或超时 30s 直接 create）
2. -> session/create {workspace:{workspacePath, workspaceKey}}
   <- server-N session/requestRuntimePreferences      必须应答（§7）
   <- session/lifecycle/changed starting
   <- server-N interaction/requestOfficialMcpAuthHeaders 应答 {}（或带 headers）
   <- result.session.sessionId
3. -> provider/refreshRegistry {reason:"run"}（可忽略错误）
   -> provider/updateAccountConfig {revision, basedOnZCodeBuiltinRevision, providers, states}
4. -> session/subscribe {sessionId, deliveryKind:"desktop-continuous"}
5. -> session/send {sessionId, content, modelSelection:{providerId,modelId,options:{reasoningLevel}}}
   <- server-N interaction/requestProviderRuntimeHeaders  → 换 Project Token 应答（§6.3）
   <- session/event turn.started / model.streaming / tool.updated / turn.completed|turn.failed
6. 完成：turn.completed → Finish::Done；turn.failed → 按 error.code 映射失败文案
7. 停止：session/stop（不要杀进程）；断线：session/events {afterSeq}
```

### 12.4 事件 → UI 映射

| ZCode 事件 | AgentHub 处理 |
| --- | --- |
| `turn.started` | `run.status("running")` |
| `model.streaming {kind:"text_delta"}` | 追加 assistant 文本（同 `part.delta`，二者会重复，二选一） |
| `model.streaming {kind:"reasoning_delta"}` | 思考流（可选展示） |
| `turn.completed` | `run.message("assistant", payload.content)` + `Finish::Done` |
| `turn.failed` | `run.fail(payload.error.code + message)` |
| `tool.updated` | 工具卡片（`kind=scheduled/started/completed`） |
| `permission.requested`（同时也会走反向请求） | 审批卡片，应答反向请求 |
| `session/lifecycle/changed` | 会话状态提示（starting/ready 可展示「初始化中」） |

### 12.5 授权/交互

- `interaction/requestPermission`：沿用 `runner.rs` 的 `Approvals`（`run.out` 发审批事件，`RunMsg::Decide` 回来应答），应答体改为 `{decision: allow|deny}`；`riskLevel` 可做默认策略（low 自动允许可配）。
  - 已实现（2026-11-08）：配置键 `zcodeAutoApprove`（off|low|medium，默认 low），执行器在档位内的 `riskLevel` 直接 allow 并在会话时间线留痕；high / critical 与 riskLevel 缺失的一律弹审批卡。设置入口：本机执行与采集 → ZCode 自动放行。
- `interaction/requestUserInput`：复用现有提问卡片；应答 `{value, cancelled}`。
- 超时策略沿用 30 分钟；超时回 `deny` / `cancelled:true`。

### 12.6 错误与重试

| 现象 | 含义 | 处理 |
| --- | --- | --- |
| `provider_not_found` / `model_not_found` | registry 没下发/版本 hash 不匹配 | 重推 `updateAccountConfig` 后重试一次 |
| `invalid_model_request: Reasoning level is required` | 缺 `options.reasoningLevel` | 从 provider 目录里选（GLM-5.x → `high`） |
| `CONFIGURATION_ERROR: Select a model` | send 未带 `modelSelection` | 补 modelSelection |
| `Provider runtime headers were not applied` | 反向请求答了 `headersApplied:false` | 换 Project Token 重答 |
| `-32010 A prompt is already running` | 并发 send | 串行化或改走 V4 队列 |
| 进程异常退出 | 看 stderr 尾部 + `ZCODE_LOG_DIR` JSONL | 重启进程 + `session/resume` |

### 12.7 安全

- OAuth/Project Token 只在内存中传递，不写日志、不进 WS 消息；探针与执行器的日志都要脱敏（当前 `summarize()` 会把整帧打出来，生产实现要过滤 `requestAuth.apiKey`）。
- `requestAuth` 走的是「Host → CLI 的 stdio」，不落盘；凭证文件解密密钥不要落库。

---

## 13. 探针脚本用法

```bash
cd inspect.local/zcode-probe
node zcode-probe.cjs                       # 默认：GLM-5.3 + 只回复 OK1
node zcode-probe.cjs --model-id GLM-5.3 --prompt "只回复 OK1"
node zcode-probe.cjs --provider-id account:zai-individual-coding-plan
node zcode-probe.cjs --timeout 180000
```

- 退出码 `0` = 收到 `turn.completed`；`1` = 失败（失败原因会打印，且完整 create snapshot 会写到 `last-create-result.json`）。
- 脚本会：建临时工作区（`%TEMP%/zcode-probe-ws-*`）→ 起 app-server → create → subscribe → refreshRegistry → updateAccountConfig → send → 收事件 → close → 关 stdin。
- 反向请求自动应答：`requestRuntimePreferences`（固定最小集）、`requestProviderRuntimeHeaders`（本地换 Project Token）、官方 MCP 鉴权（`{}`）、权限（deny）。
- 一次运行约 24k input tokens（GLM 配额），不要循环刷。

---

## 14. 遗留风险清单

1. **非公开协议**：以上基于 0.17.1 实测 + 仓库 main 分支源码；桌面端版本目录已是 `3.17.2`，CLI 版本号与外部对齐规则未验证，升级可能改 schema。
2. **`basedOnZCodeBuiltinRevision` 硬编码**：探针里写死了 `zcode-builtin:43:<sha256>`。正式实现应从 builtin 配置文件 + 内容 hash 动态推导，或从 `provider_registry.ready` 日志读取；hash 不匹配时 `updateAccountConfig` 会被 CAS 拒绝（表现为 provider 仍不可用）。
3. **entitlement 依赖远端**：`provider/refreshRegistry` 走远端刷新 + 本地 entitlement 缓存；本机实测 `refreshRegistry` 成功但 registry 仍为空，必须靠 `updateAccountConfig` 兜底。若远端把 `entitled` 判为 false，需回退到「普通 API key provider」方案。
4. **Project Token 换链依赖登录态**：OAuth access_token 过期/被吊销时，`access_tokens` 交换失败 → 模型请求 prepare 阶段失败。需要处理 401 → 提示重新登录。
5. **官方 MCP 拖慢 create**：裸跑无身份头，create 要等约 18s 超时；正式执行器建议显式传 `mcpServers: []` 或只传必需项，减少启动耗时与后台进程。
6. **`requestRuntimePreferences` 严格校验**：字段缺失会直接 create 失败（实测 Zod 报错），升级时要跟随 schema。
7. **事件补齐**：事件只在 subscribe 后推送；send 与 subscribe 之间的窗口需用 `session/events {afterSeq}` 补，或先 subscribe 再 send（本规格推荐）。
8. **并发语义**：v1 `session/send` 不支持排队（运行中再发直接 `-32010`）；需要排队/引导/重试必须上 V4 命令面。
9. **Windows 进程树**：MCP 子进程（node_repl、documents/presentations/pdf/spreadsheets）必须按树回收，否则残留进程。
10. **`-p` 不可用**：既无 provider 注入通道，又会在退出时撞 MCP 协商错误；不要把它作为降级方案。
11. **配额**：每次真实回合约 24k input tokens（系统提示 + 42 个工具），调试时注意成本。

---

## 15. 模型清单：为什么裸跑只能拿到内置 4 个（实测 2026-11，macOS + ZCode 3.17.2 / CLI bundle）

AgentHub 的角色页要给出模型下拉，这里的结论是「静态解析安装包」而不是「问 app-server」，原因如下。

### 15.1 本地有哪些清单

| 来源 | 内容 | 可信度 |
| --- | --- | --- |
| `<install>/Resources/config/provider/zcode-builtin.json` → `config.modelConfigRules.builtinProviderModelRules` | 30 条 = 10 个 `account:*` 套餐 × 4 个模型：`GLM-5.3` / `GLM-5.3-Flash` / `GLM-5.2` / `GLM-5-Turbo`（本机 revision 43） | 静态、随版本更新，按套餐过滤即可 |
| 同文件 `templateModelRules`（316 条） | 第三方模板（如 `opencode-go-chat`）的模型目录 | **不是**账号可用集，别用 |
| `~/.zcode/v2/provider_config.json` | 本机 `providerModelRules` / `manualProviderModelRules` 都是空数组 | 没有缓存账号清单 |
| 运行时会话快照 `settings.model.available` | 带 `{ref:{providerId,modelId}, label, description, providerLabel, reasoning}` | 只有桌面 Host 在场时才非空（见下） |

### 15.2 为什么快照里是空的

按 §12.3 的顺序（create → refreshRegistry → updateAccountConfig）实测：

1. `provider/updateAccountConfig` 被接受：`{"providerCount":1,"status":"received"}`，`basedOnZCodeBuiltinRevision` 与日志里的 `zcode-builtin:43:<sha>` 一致；
2. `provider/refreshRegistry` 只回 `{"refreshed":true}`（§4 方法面），**不返回任何 provider / 模型**；
3. 无论把 account 配置放在 create **之前**还是之后，`session/create` 与 `session/read` 的 `settings.model.available` 恒为 `[]`；
4. `session/setModel` 逐个试内置的 4 个模型，全部报 `-32603 Provider Registry 中不存在 Model: [object Object]` —— registry 里确实一个模型都没有；
5. 换成「同家族 10 个套餐一起标 entitled」也一样。

源码层面能对上：快照设置由 `rDt(context, {modelAvailability})` 生成，`modelAvailability === "current"` 时只返回**当前选中模型**那一条（没选就是空数组），而 `session/read` 把 `"current"` 写死了；`session/create` 走全量分支 `e.listModels()`，但它依赖的 registry 在裸跑下没有被桌面 Host 的 provider 流水线填充（模板里 `account:*` 全是 `entitled:false`，Host 侧还要换取 Project Token / 账号连接态）。

结论：**裸跑 app-server 拿不到账号级模型清单**。想拿到只能复刻桌面 Host 的整条 provider 流水线，成本远大于收益——内置 4 个模型已经覆盖了全部 `account:*` 套餐的可选集。

### 15.3 AgentHub 的做法

`src-tauri/src/agent_models.rs::zcode` 直接读安装包的 `builtinProviderModelRules`，按 `modelId` 去重给出 4 个模型（毫秒级、不需要登录、不消耗额度）；角色里仍然可以手填 `providerId/modelId` 覆盖默认 provider。若将来 CLI 版本把账号可用集暴露出来（例如 `provider/*` 多一个读取方法），再回来把这里换成动态读取即可，接口形状见 `ModelList`。
