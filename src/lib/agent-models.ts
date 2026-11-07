import { isDesktop, desktop } from "./platform";

/** 这些执行端的模型清单能真的从本机读出来（Claude / Codex 只有固定别名） */
export const CAN_LIST_MODELS = new Set(["codebuddy", "zcode"]);

export type ModelOption = {
  /** 写进角色的值（ZCode 大小写敏感，CodeBuddy 是全小写 id） */
  id: string;
  label: string;
  /** 右侧补充信息：上下文窗口、计费倍率之类 */
  note?: string;
  /** 悬停说明 */
  hint?: string;
};

export type ModelList = {
  /** account = 账号下发的实际可用；static = 安装包内置；empty = 没有清单 */
  source: "account" | "static" | "empty";
  models: ModelOption[];
  detail?: string;
};

const cache = new Map<string, ModelList>();

/**
 * 读某个执行端的模型清单。同一执行端的成功结果会缓存，`refresh` 时重新读。
 * 非桌面端（手机 / 浏览器）没有本地配置可读，直接给空清单让 UI 退回手填。
 */
export async function loadAgentModels(agent: string, refresh = false): Promise<ModelList> {
  const hit = cache.get(agent);
  if (hit && !refresh) return hit;
  if (!isDesktop) return { source: "empty", models: [], detail: "手机上读不到本机模型清单" };
  const list = await desktop.agentModels(agent, refresh);
  cache.set(agent, list);
  return list;
}
