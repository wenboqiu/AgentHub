import type { Delivery, ForkInfo } from "./api";
// 带 .ts 后缀是为了让 node --test 能直接跑这个文件（Vite 与 tsc 都允许显式后缀）
import { agentName } from "./agents.ts";

// 任务单上「从哪开始」的预览判断。
//
// 权威判定在服务端（server/src/proposals.ts 的 planDelivery）——派发那一刻按最终的工具、
// 电脑、目录再算一遍，续不上就退回新会话。这里只负责让人在点确认之前就看见结果：
// 换执行人、换机器之后按钮该不该灰、灰了为什么，别等人点完才在结果里看到「其实没能续上」。
// 两边的比较规则必须保持一致（目录归一化、电脑名大小写）。

export type DeliveryPlan = {
  /** 真要按这个去向开跑时的实际方式 */
  mode: Delivery;
  /** 给界面看的一句话 */
  reason: string;
  /** true = 想续但续不上（选项该灰掉并说明原因） */
  blocked: boolean;
};

/** 目录比较前先归一化：反斜杠、末尾斜杠、Windows 盘符大小写，否则同一目录会被误判成两个 */
export function normalizeCwd(p: string): string {
  const p2 = (p ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:/.test(p2) ? p2[0].toLowerCase() + p2.slice(1) : p2;
}

export function planDelivery(want: Delivery, fork: ForkInfo, target: { agent: string; machine: string; cwd: string }): DeliveryPlan {
  if (want === "fresh") return { mode: "fresh", reason: "新建会话，从这个任务本身开始", blocked: false };
  if (!fork.ok) return { mode: "fresh", reason: fork.reason, blocked: true };
  if (target.agent && target.agent !== fork.agent) {
    return { mode: "fresh", reason: `执行人是 ${agentName(target.agent)}，原会话是 ${agentName(fork.agent)}，续不上`, blocked: true };
  }
  if (target.machine && target.machine.toLowerCase() !== fork.machine.toLowerCase()) {
    return { mode: "fresh", reason: `换了电脑，原会话在 ${fork.machine}`, blocked: true };
  }
  if (target.cwd && normalizeCwd(target.cwd) !== normalizeCwd(fork.cwd)) {
    return { mode: "fresh", reason: "任务目录和原会话不同，续不上上下文", blocked: true };
  }
  if (want === "resume") {
    return { mode: "resume", reason: `接着上次派发的会话继续（${agentName(fork.agent)} · ${fork.machine}）`, blocked: false };
  }
  return { mode: "fork", reason: `接着原会话的上下文（${agentName(fork.agent)} · ${fork.machine}）`, blocked: false };
}
