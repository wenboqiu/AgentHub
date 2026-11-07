import type { Machine } from "./api";

/**
 * 派活时挑电脑：候选怎么来、哪些能跑当前工具、默认选哪台、选中的这台装没装这个工具。
 *
 * 原来这些都摊在 TaskView 的渲染体内，改一行就得靠人肉回归；抽成纯函数后
 * 边界（老电脑端没上报工具 / 任务上存的机器没装工具 / 只有一台能跑）都能直接测。
 */
export type MachineCandidate = { name: string; online: boolean; agents: string[] };

export type MachinePick = {
  /** 所有看得见的电脑（含明确没装这个工具的，下拉里要标出来） */
  candidates: MachineCandidate[];
  /** 能跑当前工具的：上报过清单且含它，或者压根没上报过（老电脑端，当「不知道」放行） */
  usable: MachineCandidate[];
  /** 下拉选项：任务上已经存着的那台始终留着，哪怕它没装现在的工具，不然界面会静默清空 */
  options: MachineCandidate[];
  /** 这次派给谁：任务上存的优先，否则「能跑这个工具的只有一台在线」就自动选它 */
  machine: string;
  /** 选中的那台此刻没连着（派活会入队等它上线） */
  offline: boolean;
  /** 选中的那台明确没装当前工具 */
  machineLacks: boolean;
};

export function pickMachine(input: {
  /** /machines 拉回来的清单（可能还没拉到，空数组就退回在线名单） */
  machines: Machine[];
  /** 此刻连着的电脑名 */
  online: string[];
  /** 任务上存着的电脑（没存就是 null） */
  stored: string | null;
  /** 当前执行工具（角色绑定的优先）；null = 还没定，不按工具过滤 */
  tool: string | null;
}): MachinePick {
  const { machines, online, stored, tool } = input;
  const candidates: MachineCandidate[] = machines.length
    ? machines.map(m => ({ name: m.name, online: m.online, agents: m.agents }))
    : [...new Set([...online, ...(stored ? [stored] : [])])]
      .map(name => ({ name, online: online.includes(name), agents: [] }));
  // 任务上存着的那台可能已经不在这份清单里（改过名 / 老记录）：也要列出来，
  // 否则下拉会显示「自动选择」而任务其实钉在它上面，看不出实际派给谁
  if (stored && !candidates.some(c => c.name === stored)) {
    candidates.push({ name: stored, online: online.includes(stored), agents: [] });
  }
  const fits = (c: MachineCandidate) => !tool || c.agents.length === 0 || c.agents.includes(tool);
  const usable = candidates.filter(fits);
  const options = stored && !usable.some(c => c.name === stored)
    ? [...usable, ...candidates.filter(c => c.name === stored)]
    : usable;
  const usableOnline = usable.filter(c => c.online);
  const machine = stored || (usableOnline.length === 1 ? usableOnline[0].name : "");
  const caps = candidates.find(c => c.name === machine)?.agents ?? [];
  return {
    candidates,
    usable,
    options,
    machine,
    offline: !!machine && !online.includes(machine),
    // 上报过清单、且清单里没有它 = 明确没装；没上报过（空清单）不算
    machineLacks: !!tool && caps.length > 0 && !caps.includes(tool),
  };
}
