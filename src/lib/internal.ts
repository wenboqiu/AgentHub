import type { Session } from "./api";

// 内部会话：AgentHub 自己开给电脑端 agent 用的——角色助手（一句话造角色）、意见细化（写任务单）。
// 它们的首条用户消息是 AgentHub 写的契约提示词，不是人说的话，所以：
//   · 标题由服务端钉住（server/src/session-kind.ts 的 isInternalTitle），不会被提示词原文顶掉；
//   · 列表里单独收进「内部会话」分组，不混进待处理 / 进行中。
// 前缀必须与 server/src/session-kind.ts 保持一致，改一处要改两处。
const PREFIXES = ["角色助手：", "意见细化："];

export const isInternalSession = (s: Pick<Session, "title">) => PREFIXES.some((p) => s.title.startsWith(p));

/**
 * 列表副标题：取标题，没有标题才退回最后一句话。
 * 内部会话的最后一句话往往是 agent 回的 JSON 草稿，原样贴出来只是噪音，这种直接吞掉。
 */
export function sessionPreview(s: Pick<Session, "title" | "summary">): string {
  const text = (s.title || s.summary).trim();
  if (!text) return "";
  return text.startsWith("{") || text.startsWith("```") ? "" : text;
}
