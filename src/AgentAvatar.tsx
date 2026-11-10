import type { AgentAvatarSpec } from "./lib/api";
import { agentName } from "./lib/agents";
import { agentColor, presetById, useAgentAvatar } from "./lib/avatars";

/** agent 头像：自定义图片 > 内置 emoji > 首字母。spec 不传就读账号偏好（设置页预览时显式传） */
export default function AgentAvatar({ agent, size = 32, spec, decorative = false }: { agent: string; size?: number; spec?: AgentAvatarSpec | null; decorative?: boolean }) {
  const saved = useAgentAvatar(agent);
  const s = spec === undefined ? saved : spec ?? undefined;
  const name = agentName(agent);
  const a11y = decorative ? { "aria-hidden": true as const } : { role: "img", "aria-label": `${name} 头像` };
  const style = { width: size, height: size, fontSize: Math.round(size * 0.5) };
  if (s?.kind === "image") return <img className="agent-avatar" src={s.data} alt={decorative ? "" : `${name} 头像`} style={style} />;
  const preset = s?.kind === "preset" ? presetById(s.id) : undefined;
  if (preset) return <span className="agent-avatar" {...a11y} style={{ ...style, background: preset.bg, fontSize: Math.round(size * 0.58) }}>{preset.emoji}</span>;
  return <span className="agent-avatar initial" {...a11y} style={{ ...style, background: agentColor(agent) }}>{name.slice(0, 1).toUpperCase()}</span>;
}
