> **复核提示（2026-11-09）**：本文结论已过时。Mandate 化设计（`docs/super-agent-mandate-design.md`）已落地，授权与验收层不再是「半成品」。请以 `docs/architecture-review-super-agent-2.md` 为准；本文保留为 11-05 当时的历史快照。
>
> 记录日期：2026-11-05
> 背景：评审 AgentHub 当前架构，判断是否实现了 DeepSeek harness / Super-agent 的思想。评审对象是 master（91ba914）现状，不是某次 diff。

# AgentHub 架构评审：是否实现 Super-agent 思想

## 结论

**没有实现 DeepSeek harness 意义上的 super agent。** AgentHub 是 super agent 周边机制的"外围控制面"，只借鉴了其中 4 个点，且都只落地一半。

说明：我没读过 DeepSeek Super-agent 的原始资料。对照依据是仓库自己的注释和发布说明（`threads.ts`、`watchdog.ts`、`notify.ts`、`digest.ts`、`0.6.0.md`、`0.7.0.md`），加上通用 agent harness 特征（agent 循环、规划、工具与记忆、自主决策）。

验证：`cd server && npx tsc --noEmit` 通过；`npm test` 需要 Postgres，本次未运行，行为判断来自读代码。

## 架构概览

- **中枢服务**（`server/`）：Fastify + Postgres。服务端没有任何模型凭据（`assistant.ts` 头部注释）。
- **桌面端 Rust 执行器**（`src-tauri/`）：包装 `claude -p` / `codex app-server` / `zcode app-server`。
- **UI**：桌面和 Android 共用一套前端。

agent 循环在 Claude / Codex / ZCode 手里，AgentHub 只负责派活、排队、看状态、验收。

## 与 Super-agent 思想的对照

| 思想 | 落地位置 | 实现程度 |
|---|---|---|
| Session 是实现细节，用户面对 Thread | `threads.ts` `taskThread` | 部分：只在任务维度做聚合读；没挂任务的会话没有 Thread，也没有跨会话上下文续接 |
| 外部 Watchdog | `watchdog.ts`，`routes.ts:1253` | 部分：只检测卡死和反复中止，只提醒不干预，无自动重派或换工具重试 |
| 事件过滤 Fast/Slow Path | `notify.ts` | Fast Path 已实现；Slow Path 只有接缝，未实现 |
| 投机执行 | `digest.ts` | 名不副实：进入待验收/失败时预算一份缓存，用正则抓证据，不是投机多路径执行 |
| 经验沉淀（接近 harness 记忆层） | `review.ts` → `memories.ts` → `composeInstructions`（`routes.ts:769`） | 最像 harness 的一环：验收打回原因沉淀为角色×项目经验，下次派活自动注入（5000 字预算 + 轮换） |
| 规划、自主决策、工具调用、agent 循环 | 无 | 缺失：无任务分解，无"agent 决定下一步"，一切由人触发 |

## 审查意见

### 必须改
无。

### 建议改
1. **`server/src/notify.ts:134-158`**：`setSemanticFilter` 全仓无调用方，是预留的空抽象，Slow Path（super agent 的核心）等于死代码。
   建议：用 `assistant.ts` 已有的"借用户已登录 agent"通道接上；或删除接缝，避免文档显得已实现。
2. **`server/src/routes.ts`（1281 行）**：HTTP 路由、WS、4 个定时器（提醒、Watchdog、排队清扫、ping）、派活编排都在 `registerRoutes` 一个闭包里。
   建议：把 Watchdog、排队、摘要等后台回路拆成独立 scheduler 模块，由 `index.ts` 注册；利于单测，也是往"自治"方向演进的前提。
3. **`server/src/watchdog.ts` 的 `AbortSpreeTracker`（`routes.ts:228`、`:440`）**：内存态，重启清零；而卡死提醒落库，两者语义不一致。
   建议：落到 `watchdog_state`，或至少在文档里写明。

### 可选
4. **`server/src/threads.ts:26`**：每个关联会话各查一次 `listMessages`（N+1），每会话只取最近 100 条，会话多或消息长时时间线静默截断。可改成单条 SQL 加总上限。
5. **`server/src/digest.ts`**：证据抽取是正则启发式（注释已承认"宁可少抓"）。若要宣称"投机执行"，建议改名为"预摘要"，或真的增加后台预跑。

## 应补测试
- Watchdog 重新武装（`event_at` 变化后重新提醒）；重启后不重复提醒。
- `evaluateNotify` 的语义过滤：抛错放行、返回 false 静音。
- `taskThread` 在多会话、消息超过 100 条时的排序与截断。

## 向 Super-agent 靠近的最小路径
1. Watchdog 从"只提醒"升级为"可配置的自动动作"（重派、退回待办），默认关闭。
2. 经派活链路接上 Slow Path 语义过滤。
3. Thread 跨会话续上下文：新会话启动时注入 Thread 摘要，与现有角色经验注入合并。

三步都复用现有链路，不需要引入服务端模型凭据。

## 合并结论
本次评审对象是现状而非 diff：无必须改的缺陷，可继续。主要风险是文档和注释把"借鉴思路"写得像"已实现"，建议 README 明确写成"外围控制面，非 agent harness"。

## 历史问题（与本次结论无关）
- `README.md` 首段是一整段连续的版本流水账，且"最新合并版本为 0.5.1"已落后于 0.9.9。
