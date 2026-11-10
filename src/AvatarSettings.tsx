import { useState } from "react";
import type { AgentAvatarSpec, Api } from "./lib/api";
import { AGENT_LABEL, agentName } from "./lib/agents";
import { defaultPresetId, mascotById, setAvatarPrefs, useAgentAvatars } from "./lib/avatars";
import AgentAvatar from "./AgentAvatar";
import AvatarPicker from "./AvatarPicker";

/** 设置 → agent 头像：先点选 agent，再挑头像；点了就存，跨设备同步 */
export default function AvatarSettings({ api }: { api: Api | null }) {
  const avatars = useAgentAvatars();
  const agents = Object.keys(AGENT_LABEL);
  const [agent, setAgent] = useState(agents[0]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const save = async (spec: AgentAvatarSpec | null) => {
    if (!api) return setErr("还没登录，登录后才能设置头像");
    setBusy(true);
    setErr("");
    try {
      setAvatarPrefs(await api.savePrefs({ avatars: { [agent]: spec } }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="box avatar-settings">
      <p className="hint">会话里每条回复前面显示这个头像；角色没设自己的头像时也用它。电脑和手机用同一套。</p>
      <div className="avatar-agents" role="radiogroup" aria-label="选择 agent">
        {agents.map((a) => (
          <button key={a} type="button" role="radio" aria-checked={a === agent} className={a === agent ? "on" : ""} onClick={() => { setAgent(a); setErr(""); }}>
            <AgentAvatar agent={a} size={36} decorative />
            <span>{agentName(a)}</span>
          </button>
        ))}
      </div>
      <h3>{agentName(agent)} 的头像</h3>
      <AvatarPicker
        value={avatars[agent] ?? null}
        busy={busy}
        preview={(s) => <AgentAvatar agent={agent} size={40} spec={s} decorative />}
        defaultTitle={`默认：${mascotById(defaultPresetId(agent))?.label ?? "首字母"}`}
        hideMascot={defaultPresetId(agent)}
        onPick={(s) => void save(s)}
        onError={setErr}
      />
      {err && <p className="msg bad">{err}</p>}
    </section>
  );
}
