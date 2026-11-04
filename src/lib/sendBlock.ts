import type { Session } from "./api.ts";
import { agentName, isListenOnly } from "./agents.ts";

/** 新开会话的临时 id（<agent>:pending-<runId>） */
export const isPendingSession = (id: string) => id.includes(":pending-");

/**
 * Codex Desktop 结束一轮时不一定会写终态：直接关窗口、进程被杀，日志最后只留下 task_started，
 * 会话就会永远停在 running，把手机端的发送按钮锁死。超过这个时长没有任何新事件就不再拦发送。
 * 服务端 routes.ts 的 STALE_RUNNING_MS 必须一致。
 */
export const STALE_RUNNING_MS = 30 * 60_000;

/** 状态是 running，但已经很久没有新事件：基本可以认定是残留状态，不是真的在跑 */
export const isStuckRunning = (s: Pick<Session, "state" | "eventAt">, now = Date.now()) =>
  s.state === "running" && now - Date.parse(s.eventAt) > STALE_RUNNING_MS;

/** 不能发消息的原因；null 表示可以发 */
export function sendBlockReason(p: { session: Session; agents: string[]; running: boolean }, now = Date.now()): string | null {
  if (isListenOnly(p.session.agent)) return `${agentName(p.session.agent)} 目前支持状态监听，请在 ${agentName(p.session.agent)} 中继续对话`;
  if (isPendingSession(p.session.id)) return p.session.state === "running" ? "新会话正在启动…" : "这个新会话没能启动";
  if (!p.agents.includes(p.session.machine)) return "电脑端不在线";
  if (p.running) return "这个会话正在运行";
  if (p.session.agent === "codex" && p.session.state === "running" && !isStuckRunning(p.session, now)) {
    return "这个 Codex 会话正在 Desktop 里运行，等它结束后再发";
  }
  return null;
}
