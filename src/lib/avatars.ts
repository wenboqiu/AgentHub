import { useSyncExternalStore } from "react";
import type { AgentAvatarSpec, Api, Prefs } from "./api";

/** 内置头像：emoji + 底色。id 存进服务端，改 emoji 不影响已选的人；删条目会让选过的人退回首字母 */
export const AVATAR_PRESETS: { id: string; emoji: string; bg: string }[] = [
  { id: "robot", emoji: "🤖", bg: "#dbe7f5" },
  { id: "fox", emoji: "🦊", bg: "#fde3cf" },
  { id: "cat", emoji: "🐱", bg: "#fbe9c6" },
  { id: "panda", emoji: "🐼", bg: "#e6e6e6" },
  { id: "owl", emoji: "🦉", bg: "#eadfd3" },
  { id: "octopus", emoji: "🐙", bg: "#f6d9e4" },
  { id: "whale", emoji: "🐳", bg: "#d4ecf7" },
  { id: "penguin", emoji: "🐧", bg: "#dfe5ee" },
  { id: "unicorn", emoji: "🦄", bg: "#ece0f7" },
  { id: "dragon", emoji: "🐲", bg: "#d8f0d8" },
  { id: "brain", emoji: "🧠", bg: "#f9dde0" },
  { id: "bolt", emoji: "⚡", bg: "#fff1bf" },
  { id: "rocket", emoji: "🚀", bg: "#dde3f8" },
  { id: "star", emoji: "🌟", bg: "#fff4cc" },
  { id: "leaf", emoji: "🍀", bg: "#d9f2df" },
  { id: "fire", emoji: "🔥", bg: "#ffe0cc" },
];
export const presetById = (id: string) => AVATAR_PRESETS.find((p) => p.id === id);

/** 默认头像（首字母）的底色：每个 agent 一种，深浅模式都看得清白字 */
const AGENT_COLOR: Record<string, string> = {
  claude: "#c96442",
  codex: "#3d3d3d",
  doubao: "#3c6df0",
  workbuddy: "#2f9e6e",
  zcode: "#7a4fd6",
  codebuddy: "#0f8fb3",
};
export const agentColor = (agent: string) => AGENT_COLOR[agent] ?? "#6b7280";

// ---- 全局状态：App 拉一次、WS 推来更新，任何组件 useAgentAvatars() 读 ----
let current: Prefs["avatars"] = {};
const subs = new Set<() => void>();
const emit = () => { for (const f of subs) f(); };

export function setAvatarPrefs(p: Prefs | null | undefined) {
  current = p?.avatars ?? {};
  emit();
}
/** 拉不到（老服务端没有 /prefs）就当全是默认头像，不报错 */
export async function loadAvatarPrefs(api: Api) {
  try { setAvatarPrefs(await api.prefs()); } catch { /* 老服务端：用默认头像 */ }
}
export function useAgentAvatars(): Prefs["avatars"] {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => current);
}
export function useAgentAvatar(agent: string): AgentAvatarSpec | undefined {
  return useAgentAvatars()[agent];
}

/** 本地图片 → 居中裁成正方形、缩到 96×96 的 data URL（优先 webp，不支持退回 png） */
export async function imageToAvatar(file: File, size = 96): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => {
      const el = new Image();
      el.onload = () => ok(el);
      el.onerror = () => fail(new Error("图片读不出来，换一张试试"));
      el.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("浏览器不支持图片处理");
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    const webp = canvas.toDataURL("image/webp", 0.85);
    return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}
