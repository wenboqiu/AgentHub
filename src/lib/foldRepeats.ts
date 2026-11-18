import type { Message } from "./api";

/**
 * 相邻、内容完全相同的授权消息折成一条。
 * 老版本客户端碰上 ZCode 按退避重发同一个权限请求，会一次次写进「请求授权：…」「已允许：…」，
 * 同一条命令能连着出现五六遍。客户端已经不再重复写，但库里的旧记录还在——显示时折叠，数据不动。
 * 只折 approval：人和 agent 说同一句话是真的说了两次，不能替人合并。
 */
export function foldRepeats(messages: Message[]): { m: Message; count: number }[] {
  const out: { m: Message; count: number }[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && m.role === "approval" && last.m.role === "approval" && last.m.text === m.text && last.m.runId === m.runId) {
      last.count++;
      continue;
    }
    out.push({ m, count: 1 });
  }
  return out;
}
