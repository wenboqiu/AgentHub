# 数据统计设计

> 记录日期：2026-11-10。背景：要看每天 / 每周 / 每月的会话、运行、任务数量，但源表保留期很短，不能直接 GROUP BY。

## 为什么要汇总表

| 源表 | 保留期 | 说明 |
|---|---|---|
| `sessions` | 30 天（`purgeOld`，按 `updated_at`） | 原先没有创建时间列，现加 `first_seen_at` |
| `session_activity` | 随会话 | 5 分钟一个桶，count = 消息数 |
| `runs` | 90 天 | `usage` 经常为 null 或只有 credits |
| `tasks` | 不清理 | |
| `approvals` | 7 天 | **本版不统计授权** |

所以定时把最近几天**重算**进 `daily_stats`（维度 agent × project）和 `daily_model_stats`（维度 model），窗口之外的行不再碰，等于封存历史。周 / 月在查询时从日数据合并。

## 重算窗口为什么是 28 天

会话 30 天没更新就被清理。窗口若等于或大于 30 天，窗口最老几天的会话数会随清理往下掉。取 28 天留余量（`ROLLUP_DAYS`）。

## 调度

- 每小时：先 `rollupStats`（全部用户）再 `purgeOld`，顺序不能反；各自 catch，rollup 失败不挡 purge。
- 启动 30 秒后全量 rollup 一次。不在 `buildApp` 里同步跑（测试每个进程都 buildApp）。
- `GET /stats` 对当前用户做节流刷新（默认 60 秒一次，`RouteOptions.statsRefreshMs` 可调）。
- 用户第一次汇总（`daily_stats` 没有任何行）会回填：起点 = 最早任务创建日与 90 天前中较早的一天。会话相关列只能算到源表还剩的部分，更早的天为 0。

## 一天的边界

环境变量 `STATS_TZ`，默认 `Asia/Shanghai`，用 Postgres `(ts AT TIME ZONE tz)::date` 切天。启动时校验时区名，不合法退回默认并打 warn。汇总表是封存的，**改 `STATS_TZ` 后历史不会重算**，所以别随便改。周按周一起算。

## 指标口径

- `sessions_new`：`first_seen_at` 落在这天的会话数（老会话用 `state_since` 近似；`renamePendingSession` 合并时取较早者）。
- `sessions_active` / `messages`：这天 `session_activity` 的不同会话数 / count 之和；会话已不存在的归 `''`。
- `runs*`：`runs.created_at` 在这天；`run_seconds` 只算终态运行；token / 费用缺失按 0。
- `tasks_created` / `tasks_done` / `task_done_seconds`：按 `created_at` / `done_at` 所在天；平均完成时长 = `task_done_seconds / tasks_done`，读取时算。
- `review_rejects`：当前仍为 `fail` 的检查项，按 `updated_at` 所在天（改回 pass 的不再算）。
- 项目维度：会话 = `sessions.project`；任务 = `projects.name`；运行 = 其会话的 `sessions.project`，无会话取任务的项目名。

## 已知限制

- 周 / 月粒度的 `sessionsActive` 是各天之和（同一会话连续几天活跃会重复计），界面标注「按天累计」。
- `by=model` 的拆分行只有 runs / token / 费用。

## 接口

`GET /stats?from=YYYY-MM-DD&to=YYYY-MM-DD&granularity=day|week|month&by=none|agent|project|model`

`from` 向下对齐到周期起点，`to` 不超过今天；跨度上限 day 400 / week 150 / month 60，非法参数返回 400。返回 `series`（补零连续）、`totals`、`previous`（紧邻 from 之前等长一段）、`breakdown`（最多 20 行）、`snapshot`（任务当前各状态数）。

## 验证

```bash
cd server && DATABASE_URL=... node --test test/stats.test.ts
```
