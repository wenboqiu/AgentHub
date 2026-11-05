/** 各执行端的常用模型：留空 = 用执行端自己的默认，避免把版本写死 */
export const MODEL_HINTS: Record<string, string[]> = {
  // Claude Code 别名：opus/sonnet/haiku/fable 已解析到 5.5 家族与 Fable 5.1（2026-11 核对）
  claude: ["opus", "sonnet", "haiku", "fable"],
  // Codex 目录现行：gpt-6.1-sol 为默认，gpt-5.6 三档仍在售；旧 gpt-5.x codex 系已弃用
  codex: ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
};

export const modelHints = (agent: string | null | undefined): string[] =>
  (agent ? MODEL_HINTS[agent] : undefined) ?? [];
