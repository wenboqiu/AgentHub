import type { AgentAvatarSpec, Project, Role } from "./lib/api";
import { agentName } from "./lib/agents";
import { agentColor, defaultPresetId, mascotById, presetById, useAgentAvatar } from "./lib/avatars";

type Common = { size?: number; decorative?: boolean };

/**
 * 头像的统一画法：自定义图片 > 内置形象 > emoji > 首字母。
 * spec 认不出（比如删掉的内置 id）时落回首字母，不留空白。
 */
export function AvatarView({ spec, letter, color, label, size = 32, decorative = false }: Common & { spec: AgentAvatarSpec | null; letter: string; color: string; label: string }) {
  const alt = decorative ? "" : `${label} 头像`;
  const a11y = decorative ? { "aria-hidden": true as const } : { role: "img", "aria-label": alt };
  const style = { width: size, height: size, fontSize: Math.round(size * 0.5) };
  if (spec?.kind === "image") return <img className="agent-avatar" src={spec.data} alt={alt} style={style} />;
  const mascot = spec?.kind === "preset" ? mascotById(spec.id) : undefined;
  if (mascot) return <img className="agent-avatar mascot" src={mascot.img} alt={alt} style={style} />;
  const preset = spec?.kind === "preset" ? presetById(spec.id) : undefined;
  if (preset) return <span className="agent-avatar" {...a11y} style={{ ...style, background: preset.bg, fontSize: Math.round(size * 0.58) }}>{preset.emoji}</span>;
  return <span className="agent-avatar initial" {...a11y} style={{ ...style, background: color }}>{(letter.trim().slice(0, 1) || "?").toUpperCase()}</span>;
}

/**
 * agent 头像：账号偏好里选过的 > 这个 agent 的默认形象。
 * spec 不传就读账号偏好；传 null = 看默认形象（设置页预览用）。
 */
export default function AgentAvatar({ agent, spec, ...rest }: Common & { agent: string; spec?: AgentAvatarSpec | null }) {
  const saved = useAgentAvatar(agent);
  const s = (spec === undefined ? saved : spec ?? undefined) ?? { kind: "preset" as const, id: defaultPresetId(agent) };
  const name = agentName(agent);
  return <AvatarView spec={s} letter={name} color={agentColor(agent)} label={name} {...rest} />;
}

/** 角色头像：自己设过的 > 执行工具的 agent 头像（跟着账号偏好走）> 角色名首字母。spec 传了就用它（编辑中预览） */
export function RoleAvatar({ role, spec: override, ...rest }: Common & { role: Pick<Role, "name" | "agent"> & { avatar?: AgentAvatarSpec | null }; spec?: AgentAvatarSpec | null }) {
  const spec = override === undefined ? role.avatar ?? null : override;
  if (spec) return <AvatarView spec={spec} letter={role.name} color="#6b7280" label={role.name} {...rest} />;
  if (role.agent) return <AgentAvatar agent={role.agent} {...rest} />;
  return <AvatarView spec={null} letter={role.name} color="#6b7280" label={role.name} {...rest} />;
}

const PROJECT_COLORS = ["#3c6df0", "#2f9e6e", "#c96442", "#7a4fd6", "#0f8fb3", "#b4529a", "#8a6d1f", "#d0443e"];
/** 同一个项目名永远同一个底色 */
export const projectColor = (name: string) => {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return PROJECT_COLORS[h % PROJECT_COLORS.length];
};

/** 项目头像：自己设过的 > 项目名首字母。spec 传了就用它（编辑中预览） */
export function ProjectAvatar({ project, spec: override, ...rest }: Common & { project: Pick<Project, "name"> & { avatar?: AgentAvatarSpec | null }; spec?: AgentAvatarSpec | null }) {
  const spec = override === undefined ? project.avatar ?? null : override;
  return <AvatarView spec={spec} letter={project.name} color={projectColor(project.name)} label={project.name} {...rest} />;
}
