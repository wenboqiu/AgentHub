/** Codex 提问（request_user_input）的 questions，存在 approval.detail 里（JSON 字符串） */
export type UserQuestion = { id: string; question: string; options: { label: string; description?: string }[] };
export const parseQuestions = (detail: string): UserQuestion[] | null => {
  try {
    const v = JSON.parse(detail);
    if (!Array.isArray(v) || !v.length) return null;
    const out = v
      .filter((q): q is Record<string, unknown> => !!q && typeof q === "object" && typeof (q as { id?: unknown }).id === "string")
      .map((q) => ({
        id: String(q.id),
        question: typeof q.question === "string" ? q.question : String(q.header ?? ""),
        options: Array.isArray(q.options)
          ? q.options.filter((o): o is { label: string; description?: string } => !!o && typeof o === "object" && typeof (o as { label?: unknown }).label === "string")
          : [],
      }));
    return out.length ? out : null;
  } catch {
    return null;
  }
};
