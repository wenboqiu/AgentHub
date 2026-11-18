import { useSyncExternalStore } from "react";
import type { AgentAvatarSpec, Api, Prefs } from "./api";

import clawd from "../assets/avatars/clawd.webp";
import codexImg from "../assets/avatars/codex.webp";
import doubaoImg from "../assets/avatars/doubao.webp";
import glm from "../assets/avatars/glm.webp";
import lobster from "../assets/avatars/lobster.webp";
import tencentPenguin from "../assets/avatars/tencent-penguin.webp";
import qqPenguin from "../assets/avatars/qq-penguin.webp";
import deepseek from "../assets/avatars/deepseek.webp";
import whaleGirl from "../assets/avatars/whale-girl.webp";

/** 网上的 agent 形象（二创 / 官方吉祥物，自用）：图片随包内置，取自 Petdex 精灵图第一帧与 OpenClaw 像素龙虾 */
export const MASCOT_PRESETS: { id: string; img: string; label: string }[] = [
  { id: "clawd", img: clawd, label: "Clawd（Claude Code 吉祥物）" },
  { id: "codex-term", img: codexImg, label: "Codex 终端小钟" },
  { id: "doubao-girl", img: doubaoImg, label: "豆包" },
  { id: "glm-cat", img: glm, label: "GLM 猫耳娘" },
  { id: "lobster", img: lobster, label: "小龙虾（OpenClaw）" },
  { id: "tencent-penguin", img: tencentPenguin, label: "QQ 企鹅" },
  { id: "qq-penguin", img: qqPenguin, label: "QQ 企鹅（像素）" },
  { id: "deepseek-whale", img: deepseek, label: "大肥鱼 · 鲸鱼娘" },
  { id: "whale-girl", img: whaleGirl, label: "鲸鱼娘" },
];
/** 没设过头像时用的形象 */
const AGENT_DEFAULT: Record<string, string> = {
  claude: "clawd",
  codex: "codex-term",
  doubao: "doubao-girl",
  workbuddy: "lobster",
  codebuddy: "tencent-penguin",
  zcode: "glm-cat",
};
export const defaultPresetId = (agent: string): string => AGENT_DEFAULT[agent] ?? INITIAL_PRESET;
/** 首字母头像也作为一个可选项（存 preset id） */
export const INITIAL_PRESET = "initial";
export const mascotById = (id: string) => MASCOT_PRESETS.find((p) => p.id === id);

/** 内置 emoji 头像：emoji + 底色。id 存进服务端，改 emoji 不影响已选的人；删条目会让选过的人退回首字母 */
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
