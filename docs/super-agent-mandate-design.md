# 一次授权 + 不可变范围 + 结果验收（Mandate 化设计）

> 记录日期：2026-11-08
> 状态：**设计稿，未实施**。本文是落地方案，不是已实现功能的说明；实现时以代码现状为准，文内行号是 2026-11-08 的快照。
> 背景：用户希望把 DeepSeek Harness / Super-agent 的「一次授权 + 不可变范围 + 结果验收」落到 AgentHub。本文是 `docs/architecture-review-super-agent.md`（2026-11-05 的架构评审，结论为「外围控制面、非 agent harness」）的**落地补充**：那份评审回答「是不是」，本文回答「怎么改、改到哪、分几步」。
> 自包含：本文写清了现状代码位置、改动点、SQL、协议、验证清单，交给实现者时不依赖对话上下文。
> 资料边界：DeepSeek 原始公众号文章与 GitHub 仓库未能直接抓取，Super-agent 概念依据多家报道与原型文档（`000 Philosophy` / `001 Domain` / `002 Authorization` / `003 Execution`）的公开解读，彼此一致；AgentHub 部分全部来自本仓库代码与自带文档。

## 结论

**可行，且不需要引入服务端模型凭据。** 约 80% 的零件已存在：`tasks.constraints`、`referee.ts` 规则代批、`/proposals/:id/confirm` 的一次性确认、`review.ts` + `digest.ts` 的验收、`board.ts` 的看板、执行器 `capabilities` 握手。

缺的只有三件事：

1. 把可随意 PATCH 的 `constraints` **冻结成 append-only 的 Mandate 快照**；
2. 把审批判定从「策略 + 声明边界混合」改成「**是否落在冻结范围内**」；
3. 把 `src-tauri/src/runner.rs` 的 **CLI permission mode 按 Mandate 关掉**——否则审批请求仍由 CLI 逐条产生，服务端再怎么自动批准也只是「每条都秒批」，不是「不再问」。

**第 3 点是成败点，也是唯一需要动桌面端的部分。**

## 最大约束（先读这一节）

Super-agent 敢「执行中不再问」，靠的是把安全底座换成了 **host 强制准入 + 专用 OS 账户 + 受保护 merge 规则**；原型自己声明「工作目录和命令包装器只是 defaults，不是安全边界」，并建议专用 OS 账户、只放 agent 凭据、仓库权限收窄。

AgentHub 的执行器跑在**用户自己的电脑**、以用户 OS 账户运行，能读 home 目录、按路径执行任意程序，没有等价隔离。因此：

- **不提供默认的 `bypassPermissions` / `danger-full-access`**。默认只给 `--permission-mode acceptEdits` + 命令/工具白名单 + Codex `sandbox:"workspace-write"`。
- `boundaryLine`（`server/src/routes.ts:667`）只是**提示**，不是隔离；真正约束来自 CLI 白名单与 sandbox。文档与 UI 都必须写清这一点。
- `net` / `push` / `scripts` 默认 false，且**不因后续消息自动打开**（对应 Super-agent「消息、评论、引用文档只是决策输入，不能改变权限」）。

## 明确不做（架构天花板）

- 不做「无人确认的主动接活」：无外部事件源（GitHub / IM / CI webhook），服务端无模型凭据（`server/src/assistant.ts:8-10`）。本方案的「一次授权」= **人点一次**，不是「零次」；保留 `server/src/dispatch-manager.ts:18` 的既有边界「没有『无人确认』的路径」。
- 不做「离线继续跑」：执行在用户电脑，离线只能入队（`server/src/routes.ts:691-696`），执行器断线 run 标 `failed`（`server/README.md:111`）。
- 不做「用模型语义判断后续消息是否扩权」：无服务端凭据。用 L3 的规则替代。
- 不接外部事件源、不引入 Router/Worker 双层会话：那是另一条线，不在本文范围。
- 不改 `docs/architecture-review-super-agent.md` 的结论：本文落地后，AgentHub 仍是「外围控制面」，只是把审批粒度从动作级搬到了任务级。

---

## 一、现状盘点

### 三条 gap

| 目标 | 现有基础 | 缺口 |
|---|---|---|
| 一次授权 | `/proposals/:id/confirm` 已是人一次性确认任务单（含 `constraints`），`autoDispatch` 后自动派发（`server/src/routes.ts:1427-1479`、`server/src/dispatch-manager.ts:260-292`） | 确认后 `constraints` **仍可随时 PATCH**：`server/src/tasks.ts:147-152` 的 `fields()` 对 `constraints` 无任何状态守卫，`saveTask`（`server/src/tasks.ts:212-223`）无条件写入 |
| 不可变范围 | `judgeApproval` 纯规则代批 + `danger` 硬红线（`server/src/referee.ts:174-191`、`server/src/referee.ts:492-542`）+ 每小时配额（`server/src/dispatch-manager.ts:164-170`） | 判定是**逐条事后判**，且读的是可变的 `task.constraints`（`server/src/routes.ts:388-391`）。`docs/approval-referee.md:141` 已承认「执行中因为遇到边界才需要放宽还得人点」 |
| 结果验收 | 会话 `done` 自动 → `review`（`server/src/tasks.ts:244-250`）；`review_items` / 证据 / 打回标准 → 经验（`server/src/review.ts:21-46`、`:125-146`、`:148`）；验收摘要（`server/src/digest.ts:49-93`） | 没有「交付物」实体；`done` 可被手工 PATCH（`server/src/routes.ts:1164-1165` 手动推进也补产物）；打回是在**同一任务**里重跑，不是关闭 Ticket + 新 Ticket |

### 关键发现：审批是 CLI 发起的，不是服务端发起的

- `src-tauri/src/runner.rs:187-204` `claude_args()`：Claude 带 `--permission-prompt-tool stdio --permission-mode default`。
- `src-tauri/src/runner.rs:244`：Codex `thread/start` 用 `approvalPolicy:"on-request"`、`sandbox:"workspace-write"`。
- `src-tauri/src/runner.rs:1138`：每个待批动作上报 `run.approval` → 服务端 `server/src/routes.ts:1838-1850` 建 `approvals` 行、插 `approval` 消息、广播、`refereeHandle`（`server/src/routes.ts:376-411`）再决定自动放行还是弹给人。
- `server/src/notify.ts:8-9` 硬性规定「审批与等待授权永远放行，任何规则都不允许静音」。

也就是说：**现有代批让审批「自动被批准」，但审批请求一条没少**。要真正「不再问」，必须让执行器按 Mandate 关掉 CLI 的逐动作审批（L2-B）；只改服务端（L2-A）最多做到「不打扰人」，做不到「不产生审批」。

---

## 二、目标态

> 任务 = Ticket；确认任务单 = **签署 Mandate**；派发 = 把冻结的 Mandate 下发；执行中范围内动作不产生审批、范围外生成结构化 attention；完成 = 交付物待验收；**验收通过才 done**。人只在两个点出现：开工前一次、交付后一次。

```
todo ──signMandate(人点一次)──► doing ──run done──► review ──POST /tasks/:id/accept──► done
                                  │                     │
                                  │ 范围外 attention     │ 打回
                                  ▼                     ▼
                            新 Ticket + 新 Mandate   新 Ticket + 新 Mandate（带打回原因）
```

`doing` 期间：范围内动作零审批；范围外不「批准这个动作」，而是问「要不要新开一个任务」。

---

## 三、数据模型

启动时照 `server/src/db.ts:205` 的 advisory lock 写法建表；所有表带 `user_id bigint not null references users(id) on delete cascade`。**不要 DROP 任何已有表**。

### 3.1 `task_mandates`（append-only，永不 UPDATE / DELETE）

对应 Super-agent「授权事后可审计，不用从日志还原」。

```sql
CREATE TABLE IF NOT EXISTS task_mandates (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id bigint NOT NULL,
  version integer NOT NULL,               -- 同一任务递增；新 Ticket 从 1 开始
  scope jsonb NOT NULL,                   -- 冻结的 MandateScope 快照
  ruleset_version text NOT NULL,          -- 当时用的规则表版本（如 'referee-2026-11'）
  authorized_by text NOT NULL,            -- 'user'（本方案只有这一种）
  reason text NOT NULL DEFAULT '',        -- 人填/项目经理给的边界理由，对应原 note
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, task_id, version),
  FOREIGN KEY(user_id, task_id) REFERENCES tasks(user_id, id) ON DELETE CASCADE
);
```

### 3.2 `mandate_decisions`（observe 阶段留痕）

```sql
CREATE TABLE IF NOT EXISTS mandate_decisions (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id bigint NOT NULL,
  mandate_id bigint,
  approval_id text,
  would_allow boolean NOT NULL,           -- 按冻结范围判定：本来能不能自动放行
  in_scope boolean NOT NULL,
  rule text NOT NULL DEFAULT '',
  tier text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mandate_decisions_task
  ON mandate_decisions(user_id, task_id, created_at DESC);
```

### 3.3 `task_deliveries`（交付物快照）

```sql
CREATE TABLE IF NOT EXISTS task_deliveries (
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id bigint NOT NULL,
  mandate_id bigint NOT NULL,
  digest jsonb NOT NULL,                  -- 复用 server/src/digest.ts ReviewDigest 结构
  sessions jsonb NOT NULL DEFAULT '[]',  -- 关联会话 id
  runs jsonb NOT NULL DEFAULT '[]',      -- 本任务的 run id + 状态
  evidence jsonb NOT NULL DEFAULT '[]',  -- review.ts harvestEvidence 结果
  accepted_at timestamptz,               -- 验收通过才写
  accepted_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, task_id, mandate_id),
  FOREIGN KEY(user_id, task_id) REFERENCES tasks(user_id, id) ON DELETE CASCADE
);
```

### 3.4 现有表加列

- `tasks`：`mandate_id bigint`、`mandate_frozen_at timestamptz`。
- `approvals`（`server/src/db.ts:191-202`）：`mandate_id bigint`、`in_scope boolean`。
- `dispatch_manager` 或新的 `mandate_settings`：`mandate_mode text NOT NULL DEFAULT 'off'`（`off | observe | auto`），**默认 off**，沿用 `server/src/dispatch-manager.ts:38-41` 的 `enabled:false` 惯例。

### 3.5 `MandateScope`（扩展 `TaskConstraints`）

`server/src/referee.ts:58-69` 的 `TaskConstraints` 扩成完整授权范围；`normalizeConstraints`（`server/src/referee.ts:77-92`）继续做「看不懂一律当没声明」的清洗：

```
{
  paths: string[],        // 允许改的相对目录；空 = 整个工作目录（沿用现有语义）
  net: boolean,           // 联网 / 装依赖
  push: boolean,          // 推远端
  scripts: boolean,       // 跑项目自定义脚本
  commands: string[],     // 新增：允许的命令类（read | test | build | write），空 = 沿用现有规则表
  allowedTools: string[], // 新增：下发给 CLI 的工具白名单
  maxRuntimeMin: number,  // 新增：单任务最长运行分钟数（默认 30）
  note: string            // 边界理由，拼进系统提示
}
```

UI 上把这份范围做成**开工前一次性勾选清单**（不是藏在设置页的策略），并在确认卡片上显示「本次授权范围」+ 不可撤销提示。

---

## 四、分层设计

### L1 一次授权：把 `confirm` 升级成「签署」

统一入口 `signMandate(userId, taskId, scope, by, reason)`，收口三处建任务/开工路径：

- `POST /proposals/:id/confirm`（`server/src/routes.ts:1427-1479`，`:1466` `createTaskWithDefaults`）
- `POST /tasks/:id/start`（`server/src/routes.ts:1303-1304`）
- 发单建任务路径（同样走 `createTaskWithDefaults`）

流程：校验 scope → 写 `task_mandates` 快照（version 从 1）→ 置 `tasks.mandate_id` / `mandate_frozen_at` → 之后才允许派发。

**冻结守卫（核心）**：`server/src/tasks.ts:147-152` 的 `fields()` 加判断——`mandate_frozen_at` 非空时，任何 `constraints` PATCH 抛 409「范围已冻结，请新开任务」；同时 `server/src/tasks.ts:166-170` 的 `status` 校验禁止直接 PATCH 到 `done`（只能到 `review`），收口 `server/src/routes.ts:1164-1165` 的手工推进路径。

保留 `server/src/dispatch-manager.ts:11-18` 的自动化边界不变：任务仍必须由人在卡片上点过确认。

### L2 不可变范围

#### L2-A 服务端规则兜底（低风险，先做）

- `refereeHandle`（`server/src/routes.ts:376-411`）改读**冻结快照**（`task_mandates.scope`），不再读 `tasksForSession(...).constraints`（`server/src/routes.ts:388-391`）。
- 判定语义从「全局 `RefereePolicy` + `grants` 混合」改成「**是否落在 `mandate.scope` 内**」。`judgeApproval`（`server/src/referee.ts:492`）的纯函数可复用，只换输入：`policy` 由 mandate mode 派生，`grants` 换成冻结快照。
- `run.approval` 处理（`server/src/routes.ts:1838-1850`）按结果分流：
  - `in_scope` → 自动放行，**不 `createApproval`、不插 `approval` 消息、不广播、不 notify**；
  - `out_of_scope` / `danger` / `unknown` → 生成一条结构化 attention（不是「批准这个动作」，而是「要不要新开一个任务」），带 `rule` + `tier` + 理由。
- `server/src/notify.ts:8-9` 的硬规则放宽：范围内自动放行根本不进通知管线；只有 attention 项才通知。注意 `server/src/notify.ts:133-139` 的 `setSemanticFilter` 仍是死接缝，本方案不依赖它。
- 保留 `danger` 硬红线（`server/src/referee.ts:174-191`）与 `maxPerHour` 配额（`server/src/dispatch-manager.ts:164-170`）作兜底，**不产出 deny**，判不准一律交人。

#### L2-B 执行器关掉逐动作审批（真正「不再问」）

- Mandate 随 `run.start` 下发，三处都要带：`server/src/routes.ts:505`（`startSession`）、`:556`（`resumeTaskSession`）、`:692`（`enqueueDispatch` 排队 payload，离线投递时 `server/src/routes.ts:738-739` 也要透传）。
- 新增执行器能力握手 `capabilities=mandate-v1`（范例见 `server/README.md:128` 的 `reply-branch-v1`）。**无此能力的老执行器自动退回 L2-A 逐条代批 + observe，不自动关 CLI 审批**。
- `src-tauri/src/runner.rs:187-204` `claude_args()`：按 scope 生成 `--allowedTools` 白名单、`--permission-mode acceptEdits`；`bypassPermissions` 仅在用户显式二次确认且带警示时提供，绝不默认。
- `src-tauri/src/runner.rs:244` Codex：保留 `sandbox:"workspace-write"`，`networkAccess` 对应 `net`，`approvalPolicy` 按 scope 收紧（不建议 `never`）。
- 桌面端与服务端需同步升级；老客户端可继续用（降级路径）。

### L3 上下文不扩权（Subscriptions 的 AgentHub 版）

- `POST /sessions/:id/messages`（`server/src/routes.ts:1544`）与 `resumeTaskSession`（`server/src/routes.ts:541-570`）允许运行中追加消息，明确规范：**后续消息只作为上下文，不改 Mandate**。
- 无服务端模型凭据，用规则替代语义判断：「后续消息不自动变成新工作；要开新工作必须走 `generateProposal`（`server/src/routes.ts:883-903` / `server/src/proposals.ts:529-621`）→ 人确认 → **新任务 + 新 Mandate**」。
- `resumeTaskSession` 限定为「同一 Mandate 内的续跑」；跨范围一律新建 Ticket，复用 `server/src/tasks.ts:82-83` 的 `start_mode` / `fork_from` 机制。
- 这是对 `docs/approval-referee.md:141` 那个缺口的正式回答：**不是「放宽边界」，而是「关闭 Ticket + 新 Ticket 重新授权」**。

### L4 结果验收（改动最小，复用最多）

1. **交付物实体**：扩 `server/src/routes.ts:467-475` 的 `buildReviewDigest` 调用点，任务进入 `review` 时写一条 `task_deliveries`（会话/run 列表/证据/最后回复），复用 `server/src/digest.ts:49-93`、`server/src/review.ts:58-92` `harvestEvidence`、`server/src/artifacts.ts`。
2. **状态机门禁**：`server/src/tasks.ts:244-250` 的 `done → review` 保留；新增 `POST /tasks/:id/accept` 作为 `review → done` 的**唯一**入口，条件为：所有 `review_items.status = 'pass'`（`server/src/review.ts:125-146`）且未解决的 attention 为 0；写 `task_deliveries.accepted_at / accepted_by`。
3. **打回 = 新 Ticket**：`decideReviewItem`（`server/src/review.ts:125`）打回时，除 `addStandard`（`server/src/review.ts:148`，已有经验沉淀）外，生成一条 `session_proposals` 带打回原因 + 原 Mandate 摘要，人确认后新开任务重新授权；**不在原任务里重跑**。
4. **面板收敛**：`server/src/board.ts:12-30` 已有 `waitingApproval` / `stuck` 字段，改成只显示「需要人的项」（attention + 待验收），健康 Ticket 不出现。对应 Super-agent 的 Panel「只显示需要人行动的项目」。

---

## 五、分阶段落地

每阶段可独立上线、可回滚。每账号 `mandate_mode` 默认 `off`。

| 阶段 | 内容 | 依赖 | 上线标准 / 回滚 |
|---|---|---|---|
| **0** | L1：冻结快照 + `saveTask` 守卫 + UI 授权清单显式化 + 新表/新列 | 纯服务端 | 行为与现在一致（仍逐条审批），但范围不可变成立。可统计「历史上被改过多少次边界」为 observe 备数据。回滚＝去掉守卫与 UI |
| **1** | **observe 模式**：不改 CLI，只按冻结 Mandate 判定并落 `mandate_decisions`（`would_allow` / `in_scope`），看板展示「这一轮本来会自动放行 N 条、会问 M 次」 | 阶段 0 | **零行为变更**，是全案的安全阀。跑 1–2 周，看记录顺眼再开 auto。回滚＝mode 置 off |
| **2** | auto：L2-B 执行器按 Mandate 下发 CLI 参数 + L2-A 分流 + `notify.ts` 放宽 | 阶段 1 + 双端同步升级 | 范围内审批请求数从「每条工具调用」降到 0。老执行器自动降级。回滚＝mode 置 observe |
| **3** | L4 验收门禁 + 打回新 Ticket + attention 面板收敛 | 阶段 0（状态机改动独立） | 只剩开工/验收两次人工。回滚＝保留旧 `done` 路径 |

阶段 1 直接对应 Super-agent 的 `off / observe / auto` 三档接纳模式，也是这套方案里最值得照抄的一点：**先在 observe 记录「本来会怎么判」，再逐步扩大自动执行范围**。

---

## 六、协议变更

`run.start`（`server/README.md:108` 的既有结构）新增可选字段：

```
run.start {
  runId, sessionId, agent, sessionKey, cwd, text, mode, model?, instructions?, branchPoint?,
  mandate: { id, version, scope, rulesetVersion }   // 新增；老执行器忽略
}
```

执行器 WS 握手（`server/README.md:104`、`:128`）增加 `capabilities=mandate-v1`。服务端按能力决定是否下发 mandate 并要求 CLI 关审批；无能力时只走 L2-A。

---

## 七、验证

- 单测（`server/test/referee.test.ts`、`tasks.test.ts`、`proposals.test.ts`、`api.test.ts` 扩）：
  - 冻结后 PATCH `constraints` 返回 409；新 Ticket 的 `version` 从 1 重新开始。
  - 范围内动作不产生 `approvals` 行、不插 `approval` 消息、不广播 `approval`。
  - 范围外动作生成 attention 且带 `rule` / `tier`；`danger` 硬红线不可被自动放行。
  - 手工 PATCH `status='done'` 被拒；`POST /tasks/:id/accept` 在检查项未全 pass 时返回 409。
  - 打回后生成新 `session_proposals`，原任务保持 `review`。
  - 老执行器（无 `mandate-v1`）自动降级到 L2-A，不关 CLI 审批。
  - observe 阶段 `mandate_decisions` 落条数与审批数一致。
- 端到端：扩 `server/tools/task-acceptance.ts` 一条「一次授权 → 全程零审批 → 验收通过」场景。
- 兼容：`cd server && npx tsc --noEmit`；`npm test` 需本地 Postgres（`server/README.md:131-143` 的 `agenthub-pg` 容器）。
- 双端：阶段 2 需构建桌面端与 Android，验证 `mandate` 字段在排队投递（`server/src/routes.ts:738-739`）与 `resume` 两条路径都透传。

---

## 八、风险与开放问题

1. **安全底座不对等**（最大风险）：没有专用 OS 账户与 VM，`acceptEdits` 仍可能让 agent 在用户目录内做超出预期的事。缓解：白名单 + sandbox + `net/push/scripts` 默认 false + UI 明确警示「目录声明不是安全隔离」。开放问题：是否要为高敏感账号提供「只在指定 worktree 目录启动」的执行器开关？
2. **规则表 ≠ 权限系统**：`server/src/referee.ts` 是启发式命令解析（注释已承认「宁可少抓」），把它升格为 Mandate 的唯一裁判有漏判风险。缓解：`unknown` 一律交人、`danger` 硬红线不因 mandate 放开、observe 阶段先跑数据。开放问题：是否把 `commands` 白名单做成**显示声明优先**（没声明就不许），而不是「空 = 沿用规则表」？
3. **`review → done` 门禁会改变现有习惯**：`server/src/routes.ts:1164-1165` 手工推进到 `done` 的路径会被收口。需要给「纯人工任务」留一条不经 agent 的完成通道，避免误伤通用待办（见 `docs/task-management-plan.md` 的通用任务目标）。
4. **状态机与 `syncTaskForSession` 的交互**：`server/src/tasks.ts:244-250` 在会话 `running` 时把 `review → doing`，若此时已有交付物快照，要定义「重跑是否覆盖 `task_deliveries`」。
5. **observe 数据量**：`mandate_decisions` 每条审批一行，长任务会涨；参照 `server/src/db.ts:170-179` 的 `session_activity` 做法加定期清理（如 30 天）。
6. **审计口径**：`ruleset_version` 需要真的随规则表变更而递增，否则「当时按哪版规则判的」是假的。建议在 `referee.ts` 导出常量并在 `signMandate` 时写入。

---

## 九、相关文件索引

| 主题 | 位置 |
|---|---|
| 任务模型 / 冻结守卫落点 | `server/src/tasks.ts:10`、`:40-105`、`:119-194`、`:212-223`、`:244-250` |
| 边界定义 / 判定 | `server/src/referee.ts:58-69`、`:77-92`、`:98-107`、`:174-191`、`:492-542` |
| 派发编排 / run.start / 排队 | `server/src/routes.ts:488-517`、`:541-570`、`:576-713`、`:691-696` |
| 审批链路 | `server/src/routes.ts:376-411`、`:1665-1709`、`:1838-1850`、`server/src/db.ts:191-202` |
| 通知硬规则 | `server/src/notify.ts:8-9`、`:133-139`、`:142-162` |
| 确认 / 提案 / 细化 | `server/src/routes.ts:1427-1479`、`:883-903`、`server/src/proposals.ts:529-621`、`:626-650` |
| 验收 | `server/src/review.ts:21-46`、`:58-92`、`:125-148`、`server/src/digest.ts:49-93`、`server/src/routes.ts:1182-1197` |
| 看板 | `server/src/board.ts:12-30` |
| 执行器 CLI 参数 | `src-tauri/src/runner.rs:187-204`、`:244`、`:1106-1188` |
| 能力握手 / 断线语义 | `server/README.md:104`、`:111`、`:128` |
| 既有评审与代批说明 | `docs/architecture-review-super-agent.md`、`docs/approval-referee.md`、`docs/session-to-task.md:47-56` |

## 十、一句话

可行，且不需要引入服务端模型凭据；缺的只有三件事——**把 `constraints` 冻结成 Mandate 快照、把判定从「策略」改成「范围」、把 `runner.rs` 的 CLI permission mode 按 Mandate 关掉**。按 `off → observe → auto` 三档灰度，**observe 阶段不要跳过**。
