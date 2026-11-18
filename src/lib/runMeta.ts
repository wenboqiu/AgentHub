import type { Run, RunActivity, RunUsage } from "./api";

/** token 数按人读的方式缩写：980 / 1.2k / 34k / 1.4M */
export function shortTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const trim = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}

/** 用时：18 秒 / 2 分 05 秒 / 1 小时 12 分 */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m < 60) return sec ? `${m} 分 ${String(sec).padStart(2, "0")} 秒` : `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/** 一次运行的耗时：跑完按起止时间算，还在跑就按到现在算 */
export function runElapsed(run: Run, now = Date.now()): number {
  const start = Date.parse(run.createdAt);
  const end = run.status === "queued" || run.status === "running" ? now : Date.parse(run.updatedAt);
  return Number.isNaN(start) || Number.isNaN(end) ? 0 : Math.max(0, end - start);
}

/** 花费：小额多给一位小数，免得 0.004 全被抹成 0.00 */
const money = (usd: number) => `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(3)}`;

/** 积分：整数不加小数点，小数给两位 */
const fmtCredits = (c: number) => (Number.isInteger(c) ? String(c) : c.toFixed(2));

/** 用量说明：输入 1.2k · 输出 345 · 缓存 8k tokens · $0.031 · 12.5 积分 */
export function usageText(u: RunUsage): string {
  const parts = [`输入 ${shortTokens(u.input)}`, `输出 ${shortTokens(u.output)}`];
  if (u.cached) parts.push(`缓存 ${shortTokens(u.cached)}`);
  let text = `${parts.join(" · ")} tokens`;
  if (u.costUsd) text += ` · ${money(u.costUsd)}`;
  if (u.credits) text += ` · ${fmtCredits(u.credits)} 积分`;
  return text;
}

/** 跑完之后那行结尾说明：本次完成 · 用时 1 分 20 秒 · 输入… */
export function runSummary(run: Run, now = Date.now()): string {
  const state =
    run.status === "failed" ? "运行失败"
    : run.status === "stopped" ? "已停止"
    : run.status === "done" ? "本次完成"
    : "运行中";
  const parts = [state, `用时 ${formatElapsed(runElapsed(run, now))}`];
  if (run.model) parts.push(`模型 ${run.model}`);
  if (run.usage) parts.push(usageText(run.usage));
  return parts.join(" · ");
}

/** 一句话压成单行并按长度截断：状态行只有一行，太长就省略 */
function hintText(s: string, max = 80): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * 运行中那行：只说 agent 自己给出的内容（思考原文 / 正在跑的工具 / 正在写的正文），
 * 不再由界面编「正在深度思考」。没有可播报的内容时只报「等待 X 回应」。
 */
export function liveLabel(activity: RunActivity | null, agentLabel: string): string {
  const text = activity && activity.kind !== "idle" ? hintText(activity.text) : "";
  if (!text) return `等待 ${agentLabel} 回应`;
  switch (activity!.kind) {
    case "thinking": return `思考：${text}`;
    case "tool": return `执行：${text}`;
    case "text": return `输出：${text}`;
    default: return text;
  }
}

/** 只读监听会话：超过这么久没有新记录就不再暗示「还在动」，把话说白 */
export const LISTEN_QUIET_MS = 5 * 60_000;

/**
 * 只读监听会话（WorkBuddy / 豆包 / 只挂记录的那种）运行中那行。
 * 这一类没有 run、拿不到 agent 的逐条活动（思考 / 工具 / 正文），只有服务端最后一条上报的时间，
 * 所以只说「这一轮还没结束」和「多久没有新记录」，不编「思考中」。
 */
export function listenLabel(eventAt: string, agentLabel: string, now = Date.now()): string {
  const quiet = now - Date.parse(eventAt);
  const head = `${agentLabel} 这一轮还没结束`;
  if (!Number.isFinite(quiet) || quiet <= 5_000) return head;
  const sec = Math.round(quiet / 1000);
  if (quiet < LISTEN_QUIET_MS) return `${head} · ${sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分钟`}前有新记录`;
  return `${head} · ${Math.floor(sec / 60)} 分钟没有新记录`;
}
