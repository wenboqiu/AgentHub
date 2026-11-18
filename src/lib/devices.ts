import type { Machine } from "./api";
import { AGENT_LABEL, isListenOnly } from "./agents.ts";

/**
 * 设备总览：把 /machines 的清单按「能不能接活」分组。
 *
 * 三种状态要分开说，别混成一个「离线」：
 *  - online：执行器连着，派过去立刻跑；
 *  - listening：AgentHub 开着、但没开远程执行，单会排队等开关打开；
 *  - offline：只剩历史记录（会话 / 运行 / 项目目录里出现过）。
 * 分组抽成纯函数，边界（没活动时间、同名）都能直接测。
 */
export type MachineState = "online" | "listening" | "offline";

export const machineState = (m: Pick<Machine, "online" | "listening">): MachineState =>
  m.online ? "online" : m.listening ? "listening" : "offline";

/** 行内状态胶囊上的短标签（完整说法在分组标题上） */
export const DEVICE_STATE_LABEL: Record<MachineState, string> = {
  online: "在线",
  listening: "没开远程执行",
  offline: "离线",
};

export const DEVICE_GROUP_LABEL: Record<MachineState, string> = {
  online: "在线",
  listening: "开着，没开远程执行",
  offline: "离线",
};

export type DeviceGroup = { key: MachineState; label: string; items: Machine[] };

/** 最近活动近的排前面；没有活动时间的排最后，同时间按名字排 */
function byActivity(a: Machine, b: Machine): number {
  if (a.at !== b.at) {
    if (!a.at) return 1;
    if (!b.at) return -1;
    return b.at.localeCompare(a.at);
  }
  return a.name.localeCompare(b.name);
}

/** 按在线 / 只监听 / 离线分组，空组也返回（调用方自己决定要不要画） */
export function groupDevices(machines: Machine[]): DeviceGroup[] {
  const buckets: Record<MachineState, Machine[]> = { online: [], listening: [], offline: [] };
  for (const m of machines) buckets[machineState(m)].push(m);
  return (["online", "listening", "offline"] as MachineState[]).map((key) => ({
    key,
    label: DEVICE_GROUP_LABEL[key],
    items: buckets[key].sort(byActivity),
  }));
}

export type DeviceSummary = Record<MachineState, number>;

/** 设备页一行里的工具标签：只监听的（WorkBuddy / 豆包）单独标出来，别让人以为能派活 */
export type DeviceTool = { agent: string; label: string; listenOnly: boolean };

export function deviceTools(agents: string[]): DeviceTool[] {
  return agents.map((a) => ({ agent: a, label: AGENT_LABEL[a] ?? a, listenOnly: isListenOnly(a) }));
}

export function deviceSummary(machines: Machine[]): DeviceSummary {
  const sum: DeviceSummary = { online: 0, listening: 0, offline: 0 };
  for (const m of machines) sum[machineState(m)] += 1;
  return sum;
}

/** 设置一级列表上那句现状：null = 还没拉到 */
export function deviceSummaryText(machines: Machine[] | null): string {
  if (machines === null) return "加载中…";
  if (machines.length === 0) return "还没有电脑上报过";
  const s = deviceSummary(machines);
  return [
    s.online > 0 ? `${s.online} 台在线` : "",
    s.listening > 0 ? `${s.listening} 台没开远程执行` : "",
    s.offline > 0 ? `${s.offline} 台离线` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
