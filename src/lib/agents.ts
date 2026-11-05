/** agent 展示名与能力标记，前端各处共用 */
export const AGENT_LABEL: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  doubao: "豆包",
  workbuddy: "WorkBuddy",
  zcode: "ZCode",
};

/** 只做状态 / 消息监听，不支持远程续聊、新开、分支的 agent */
const LISTEN_ONLY = new Set(["doubao", "workbuddy"]);

export const isListenOnly = (agent: string | null | undefined): boolean => !!agent && LISTEN_ONLY.has(agent);

export const agentName = (agent: string): string => AGENT_LABEL[agent] ?? agent;

/** 能真正被派去执行的 agent；只做监听的不要出现在任务 / 角色 / 配置的执行工具下拉里 */
export const DISPATCHABLE_AGENTS: string[] = Object.keys(AGENT_LABEL).filter((key) => !LISTEN_ONLY.has(key));

export const isDispatchable = (agent: string | null | undefined): boolean => !!agent && !LISTEN_ONLY.has(agent);
