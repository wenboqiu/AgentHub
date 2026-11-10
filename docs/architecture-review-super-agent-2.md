> 记录日期：2026-11-09
> 背景：复核 `docs/architecture-review-super-agent.md`（2026-11-05，结论「外围控制面、非 agent harness」）是否仍然成立。
> 评审对象：master `a911ca1`（版本 0.12.0，含 0.12.0 之后两个未发版提交 `45bc050` / `a911ca1`）；工作区另有 5 个未提交文件，不影响本文结论。
> 资料边界：**本次读到了 DeepSeek 一手资料**——`dsh-superagent-prototype` 的 README、`docs/000-philosophy.md`、`001-domain.md`、`002-authorization.md`、`003-execution.md`、`005-panel.md` 原文；设计文章《Super-agent 设计探索》以多家转载/解读交叉核对（文章自述部分方向与原型实现不一致，下文分别标注）。11-05 那份评审明确写了「没读过原始资料」，这是两次评估最大的输入差异。

# AgentHub × DeepSeek super agent：二次评估

## 结论（相较 11-05 有实质变化）

**11-05 的结论已经过时。** `docs/super-agent-mandate-design.md`（11-08 设计稿）在 11-08～11-09 已完整落地（`d032dde` / `d9d03ca` / `957b771` / `e17e013` / `8573a81` / `74c01ff`），AgentHub 现在实现了 super agent 的**任务级授权与验收层**：一次授权、不可变范围、结果验收、off/observe/auto 灰度、打回即新 Ticket。这一层不是「借鉴一半」，是实打实的代码、表、守卫、CLI 参数与单测（`server/test/mandate.test.ts` 322 行）。

**但仍不是 super agent。** 缺的是另一半：**事件接入与自主接活的编排层**。DSH 的 super agent 之所以「超级」，核心不是 Mandate，而是把「谁在盯着 Agent」从人手里搬到系统里（常驻 Router、环境事件驱动、主动接活、存算分离、重启恢复）。AgentHub 仍是「人管会话 + 系统管授权与验收」，服务端没有模型凭据、没有外部事件源、没有常驻 Router、执行在用户电脑上且离线即失败。

一句话：**下半身（Ticket / Mandate / Delivery）对齐了，上半身（Source / Trigger / Eval / Router）仍为零。**

---

## 一、相同点

### 1. 一次授权 + 不可变范围（最核心，且已实现）

| DSH 原型 | AgentHub 现状 |
|---|---|
| Ticket 附不可变 Mandate：Policy version、scope、strength、matched rules、sender 身份；扩范围必须新开 Ticket | `task_mandates` append-only 快照：version、`scope`、`ruleset_version`、`authorized_by`、`reason`；`signMandate` 同一任务重复签署直接返回旧快照 |
| 「Messages, comments and quoted documents are inputs to a decision; they cannot change those permissions」 | `assertMandateGuards`：冻结后 PATCH `constraints` 返回 409「范围已冻结，请新开任务」；`net/push/scripts` 默认 false，后续消息不自动打开 |
| 只有三种操作能改 Mandate：accept 创建、person stop 撤回、revalidation 失败撤销 | 只有签署时能创建；没有 stop/撤销路径（人直接在 UI 停止会话），也没有 revalidation |
| 打回/扩范围 → 新 Ticket | `review.ts` `proposeRetry`：验收打回生成新任务单提案，原任务保持 `review`，确认即新任务 + 新 Mandate |

签署入口收口在三处：`POST /proposals/:id/confirm`、`POST /tasks/:id/start`、项目经理自动派发；0.12.0 起任务单确认前可在界面改执行边界，确认时随单冻结。

### 2. 结果验收与「只在需要人时出现」

- DSH：`ready` Report → `person / review`，Panel 只列「需要人行动」的 Ticket；健康状态不占版面（000 Philosophy「A healthy state takes no space」）。
- AgentHub：会话 `done` → 任务 `review`，写 `task_deliveries` 交付物快照（会话 / run / 证据 / digest）；`POST /tasks/:id/accept` 是 `review → done` 的**唯一**入口，门禁为检查项全 pass + 无 pending 审批；0.12.0 把待授权、待验收、卡住、会话建议、任务单五类合成任务页「等你处理」收件箱；`dispatchBoard` 在 `mandate_mode ≠ off` 时只保留需要人的项。

### 3. off / observe / auto 三档 + 「先观察再自动」

`mandate_settings.mode` 默认 `off`；`observe` 只写 `mandate_decisions`（`would_allow` / `in_scope` / `rule` / `tier`，保留 30 天），行为零变更；`auto` 才真正改变行为；老执行器无 `mandate-v1` 自动降级。这与 000 Philosophy「Start narrow / Start in observe and switch to auto after reviewing the recorded Decisions」的工程节奏一致，是全案最值得照抄的一点。

**但两处的三档语义不同，见「不同点 4」。**

### 4. 注意力优先的结果形态

DSH 的第一原则是「Take as little human attention as possible」；AgentHub 的 `notify.ts` Fast Path（agent 静音、免打扰、优先级门槛）、审批/等待授权硬放行、0.12.0 收件箱收敛，客观上都指向「少打扰人」。差别是：DSH 把它写成第一性原理，AgentHub 是从「会话监控提醒工具」演进而来的收敛结果。

### 5. 外部 Watchdog（形似）

两边都有独立于事件流的检测回路：DSH 是定时驱动的独立 agent 会话（文章层面还能用自然语言问故障、在线改提示词）；AgentHub 是 `watchdog.ts` 的卡死检测 + `AbortSpreeTracker`，都只提醒、不干预。原型代码中 Watchdog 与文章描述并不完全对应，这一条按「设计思想对齐、能力不对齐」看待。

### 6. 两级过滤（形似）

`notify.ts` 的 Fast Path 已实现，Slow Path 留了 `setSemanticFilter` 接缝——但**全仓仍无调用方**，是死代码（11-05 已指出，未改）。DSH 的 fast/slow 是「事件要不要接活」的 Eval 前置过滤，AgentHub 的是「提醒要不要弹」的过滤，用途不同。

### 7. 经验沉淀（AgentHub 反而更实）

`review.ts` → `memories.ts` → `composeInstructions`：打回原因沉淀成角色×项目经验，下次派活自动注入（5000 字预算 + 轮换）。DSH 设计文章把「跨月长期记忆」列为**未解开放问题**。这是 AgentHub 比原型走得更远的一处。

---

## 二、不同点

### 1. 运行系统 vs 外围控制面（架构层级，根本差异）

| | DSH super agent | AgentHub |
|---|---|---|
| agent 循环 | 自己的 Harness Session（Router + Worker + Watchdog） | 第三方 CLI：`claude -p` / `codex app-server` / `zcode app-server` / CodeBuddy |
| 服务端 | 云端无状态容器 + 数据库，常驻在线 | Fastify + Postgres，**无任何模型凭据**（`assistant.ts`），只做派活/排队/看状态/验收 |
| 执行环境 | 用户机器上的轻量 daemon，代码与凭据留在本地 | Tauri 桌面执行器，以用户 OS 账户起 CLI 子进程 |
| 离线 | 设备离线任务等待，重连继续 | 离线只能入队，执行器断线 run 标 `failed`，不会自动续跑 |
| 恢复 | 不可变 Trigger / Thread 日志、Outbox 幂等、重启后按真实状态恢复 | 无 Outbox；`AbortSpreeTracker` 内存态重启清零；`watchdog_state` 只做提醒幂等 |

11-05 说「agent 循环在 Claude / Codex / ZCode 手里，AgentHub 只负责派活、排队、看状态、验收」——Mandate 化之后这句话**依然成立**，只是「验收」这一环变强了。

### 2. 事件接入与主动接活（缺失的半身）

- DSH：Source（GitHub / 飞书 / CI）→ 不可变 Trigger → Thread → Gate（确定性准入）→ Assessment（模型研判）→ Decision（accept / stop / ignore / unavailable）→ Ticket。`auto` 档可**无人确认接活**，且必须命中团队写下的规则；默认 `observe` 只记「本来会接」。
- AgentHub：**无任何外部事件源**（`git grep` 全仓 `webhook` / `feishu` / CI 无命中）。唯一的「事件 → 候选工作」是内部的：会话跑完 → 规则档生成一行「建议」（`session_proposals.stage='suggest'`，几十毫秒、不叫模型）→ 人点「生成任务单」→ `draft` → 人确认。模型只用于**重写任务单文本**，不判断「该不该接」。没有任何「无人确认」路径，对应 `dispatch-manager.ts:18` 的既有边界。
- 因此 DSH 的四个目标特征里，**主动、持久**两项 AgentHub 基本没有；**连续、高效**只做到「多会话监控 + 排队派发」的层次。

### 3. Router / Worker 与任务状态归属

- DSH：常驻 Main Session（Router，工具集更小、可用轻量模型）只分派不干活；每 Ticket 一个 `worker-<id>` 会话 + 独立 git worktree；**Ticket 定义自己的状态，不跟随 Executor Session**（001 Domain 明确拒绝「Ticket state that follows the DSH Session」）；Assignment 独立 pending/running/ended，可重试、可交接、可恢复。
- AgentHub：没有常驻 Router 会话（「项目经理」是规则/模型挑选逻辑，不是会话）；一个任务可关联**多个**会话（`task_sessions`），共享项目目录、不做 worktree 隔离；任务状态仍由会话事件驱动——`syncTaskForSession`：会话 `done` → `doing` 改 `review`，会话 `running` → `review` 退回 `doing`。`taskThread` 只是多会话聚合读，没有 Subscription fan-out、没有跨会话上下文续接。
- 也就是说：Session 在 AgentHub 里**仍是用户可见的一等公民**，没有变成实现细节。

### 4. 同名但语义不同：`off / observe / auto`

| | DSH `accept mode` | AgentHub `mandate_mode` |
|---|---|---|
| 管什么 | **接活**：推断出来的候选工作要不要自动变成 Ticket | **执行期放行**：范围内动作要不要自动批准、要不要关 CLI 逐动作审批 |
| 默认 | `observe` | `off` |
| explicit 请求 | 三档都照常接 | 与档位无关，人点确认照常开工 |
| observe 记录 | Decision「would accept」 | `mandate_decisions`「本来会自动放行 N 条 / 会问 M 次」 |

11-08 设计稿写「阶段 1 直接对应 Super-agent 的 off/observe/auto 三档接纳模式」，实现时其实把它用在了另一层。名字一样，别当成同一个东西。真正的「主动接活三档」在 AgentHub 里**尚不存在**。

### 5. Mandate 的执行期语义：入口准入 vs 逐动作裁判

- DSH 原型：`002 Authorization` 写的是 host 在**开工 / 续跑 / resume** 时校验 Mandate；`003 Execution` 明说 Executor Sessions「run commands without approval as the operator's OS user」，预设是 `danger-full-access`，且「These wrappers and directories establish defaults, not a security boundary」。即：**入口把关 + 执行期不再问**。
- AgentHub：`judgeByMandate` 拿冻结 scope 对**每一条 `run.approval`** 做规则裁判；`auto` 档范围内不建审批行、不插消息、不广播、不通知，直接回 `approval.decide allow`；范围外 / danger / unknown 一律交人；每任务每小时 300 次配额防跑飞；`runner.rs` 按 scope 生成 `--allowedTools`、`acceptEdits`、Codex `workspaceWrite`，**任何路径都不默认 `bypassPermissions`**。
- 评价：AgentHub 把 Mandate 用得更细（动作级），代价是依赖 `referee.ts` 的启发式命令解析（注释自承「宁可少抓」），且必须双端同步；DSH 原型的 Mandate 更像是「审计凭证」，运行期权限实际是 ambient authority，第三方分析也指出其授权「stops at the scheduler」。两边安全底座都不对等，但 AgentHub 明显更保守。

### 6. 审计与领域模型粒度

DSH 有 20+ 领域概念（Trigger 不可变、Thread 有序日志、Correlation、Channel、Disposition、Input、Attention、Report、Policy version、strength、matched rules、sender 身份），面板能回答「这活从哪个 Trigger 来、当时按哪版 Policy 判的、历史如何」。AgentHub 的 Mandate 只有 `scope` / `ruleset_version` / `authorized_by='user'` / `reason`，没有 strength、没有发送者身份（只有人点确认这一种入口）、没有 matched rules；收件箱是「待办聚合」，不是 Ticket 全生命周期审计视图。

### 7. 投机执行 / 经验层命名

`digest.ts` 的「投机执行」仍是**任务进入待验收时预生成验收摘要**（正则抓证据），不是 DSH 那种「先在后台静默复现、确认有价值才提 PR」的多路径投机；现在这份 digest 被吸收进 `task_deliveries`，功能更实了，但名字仍名不副实。建议改名「预摘要」，或真做后台预跑。

---

## 三、结论对照表（11-05 → 11-09）

| 11-05 判断 | 11-09 复核 |
|---|---|
| 「没有实现 super agent 意义上的 harness」 | 仍成立，但理由变了：缺的是事件/编排层，不是授权层 |
| Session → Thread：部分 | 未变，仍无订阅与跨会话续接 |
| Watchdog：部分，只提醒 | 未变 |
| Fast/Slow Path：Slow 死接缝 | 未变，`setSemanticFilter` 全仓无调用方 |
| 投机执行：名不副实 | 未变（digest 已并入交付物快照） |
| 经验沉淀：最像 harness 的一环 | 未变，且比 DSH 原型更完整 |
| 规划、自主决策、工具调用、agent 循环：缺失 | 仍缺失；**新增**：Mandate 三件套 + observe/auto + 验收门禁已完整落地 |
| 「只借鉴了 4 个点，都只落地一半」 | 改为：**授权与验收层已从半成品变成完整实现；自主接活层仍是 0** |

---

## 四、下一步（按性价比排序，不改架构天花板）

1. **把「建议 → 任务单」升级为可选的接活三档**：现有 `suggest` 是规则档产出的 inferred candidate，已具备 Trigger 雏形。补一张不可变触发记录 + `accept mode`（off / observe / auto，默认 observe），`auto` 必须命中显式规则才自动建任务。不需要服务端模型凭据，也不需要外部事件源，是通向 Eval 的最小一步。
2. **补审计粒度**：Mandate 增记触发来源（哪条会话事件/建议）、matched rule、`strength`；`ruleset_version` 已随 `RULESET_VERSION` 写入，保持随规则表变更递增。
3. **明确后续消息只送上下文**：`resumeTaskSession` 与 `POST /sessions/:id/messages` 已有链路，把「不改 Mandate」写成协议约束并补测；这是 Subscription 的低成本 AgentHub 版。
4. **Watchdog 从只提醒升级为可配置自动动作**（重派 / 退回待办），默认关闭；顺手把 `AbortSpreeTracker` 落库，与卡死提醒语义一致。
5. **清理名不副实的接缝**：`setSemanticFilter` 要么借用户已登录 agent 接上，要么删；`digest.ts` 的「投机执行」改名「预摘要」。
6. **暂不做**：常驻 Router/Worker 双层、外部 GitHub/IM/CI 事件源、离线继续跑、存算分离。这些都需要服务端模型凭据或常驻云端执行环境，与当前「执行在用户电脑、服务端零凭据」的定位冲突（11-08 设计稿第 31-37 行的边界仍有效）。

---

## 五、需要同步修正的文档

- `docs/architecture-review-super-agent.md`：结论段「没有实现 / 只借鉴 4 个点且都只落地一半」已不成立，应标注为历史快照并指向本文。
- `docs/super-agent-mandate-design.md`：状态「设计稿，未实施」应改为「已实施」；其「资料边界」段（原始资料未抓到）本次已补齐；文中 `maxRuntimeMin` 执行器仍不强制超时、`auto` 配额已改为按任务每小时 300 次，与原文不同。
- `README.md` 首段仍是 0.11.18 的版本流水账，落后于 0.12.0；11-05 已提过，未改。

## 六、验证方式

本文判断来自读代码与读一手文档，未运行测试。可复核：`cd server && npx tsc --noEmit`；`server/test/mandate.test.ts`；`git show d032dde d9d03ca 957b771`；`server/README.md` §一次授权（Mandate）。`npm test` 需本地 Postgres。
