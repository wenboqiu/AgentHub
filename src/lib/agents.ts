/** agent 展示名与能力标记，前端各处共用 */
export const AGENT_LABEL: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  doubao: "豆包",
  workbuddy: "WorkBuddy",
  zcode: "ZCode",
  codebuddy: "CodeBuddy",
};

/** 只做状态 / 消息监听，不支持远程续聊、新开、分支的 agent。
 *  - doubao：本来只有状态上报；
 *  - workbuddy：桌面端内置的是 lite-wb bundle，没有独立登录态（实测 `-p` 直接
 *    `Authentication required`），而能自己 `/login` 的那份就是 npm 完整版，也就是 codebuddy。
 *    所以它在派活入口里没有独立价值，只保留「看桌面端会话」，派活用 CodeBuddy。 */
const LISTEN_ONLY = new Set(["doubao", "workbuddy"]);

export const isListenOnly = (agent: string | null | undefined): boolean => !!agent && LISTEN_ONLY.has(agent);

export const agentName = (agent: string): string => AGENT_LABEL[agent] ?? agent;

/** 能真正被派去执行的 agent；只做监听的不要出现在任务 / 角色 / 配置的执行工具下拉里 */
export const DISPATCHABLE_AGENTS: string[] = Object.keys(AGENT_LABEL).filter((key) => !LISTEN_ONLY.has(key));

export const isDispatchable = (agent: string | null | undefined): boolean => !!agent && !LISTEN_ONLY.has(agent);
