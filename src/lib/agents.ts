/** agent 展示名与能力标记，前端各处共用 */
export const AGENT_LABEL: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  doubao: "豆包",
  workbuddy: "WorkBuddy",
  zcode: "ZCode",
};

/** 只做状态 / 消息监听，不支持远程续聊、新开、分支的 agent */
const LISTEN_ONLY = new Set(["doubao", "workbuddy", "zcode"]);

export const isListenOnly = (agent: string | null | undefined): boolean => !!agent && LISTEN_ONLY.has(agent);

export const agentName = (agent: string): string => AGENT_LABEL[agent] ?? agent;
