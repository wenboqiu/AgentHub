import type { Project, Role, RoleInput } from "./lib/api";
import { AGENT_LABEL, DISPATCHABLE_AGENTS } from "./lib/agents";
import ModelPicker from "./ModelPicker";

// 角色的字段只有这一份：新建 / 编辑 / 助手草稿三处都用它渲染，
// 这样「自己新建」和「让助手建」看到的选项永远一致，不会再一边有项目经理、一边没有。

/** 能真正派活的 agent 才可选；豆包 / WorkBuddy 只做状态监听 */
const DISPATCHABLE = DISPATCHABLE_AGENTS;

export type RoleForm = {
  name: string;
  title: string;
  agent: string;
  model: string;
  context: string;
  tools: string;
  manager: boolean;
  managerProjects: number[];
};

/** 执行工具必填，所以草稿默认停在 claude 上，不留「未指定」这种半成品 */
export const BLANK_ROLE: RoleForm = {
  name: "", title: "", agent: "claude", model: "", context: "", tools: "", manager: false, managerProjects: [],
};

export const roleToForm = (r: Role): RoleForm => ({
  name: r.name, title: r.title, agent: r.agent ?? "", model: r.model ?? "", context: r.context,
  tools: r.tools.join("、"),
  manager: r.manager, managerProjects: r.managerProjects,
});

export const formToInput = (f: RoleForm): RoleInput => ({
  name: f.name.trim(),
  title: f.title.trim(),
  agent: (f.agent || null) as Role["agent"],
  // 模型留空 = 派活时由项目经理按任务复杂度挑；工具没有清单时才落回执行端默认
  model: f.model.trim() || null,
  context: f.context.trim(),
  // 逗号/顿号/空格都能分隔，方便从文档里直接粘
  tools: f.tools.split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean),
  manager: f.manager,
  // 不担任经理时管辖范围无意义，一律清空（服务端也会清）
  managerProjects: f.manager ? f.managerProjects : [],
});

/** 必填项：角色名 + 执行工具；其余都能之后慢慢补 */
export const roleReady = (f: RoleForm) => !!f.name.trim() && !!f.agent;

export default function RoleFields({ form, projects, busy, onChange }: {
  form: RoleForm;
  projects: Project[];
  busy: boolean;
  onChange(patch: Partial<RoleForm>): void;
}) {
  const toggleProject = (id: number) => onChange({
    managerProjects: form.managerProjects.includes(id)
      ? form.managerProjects.filter(x => x !== id)
      : [...form.managerProjects, id],
  });
  return (
    <>
      <div className="form-grid">
        <label>角色名（必填）<input value={form.name} maxLength={60} disabled={busy} placeholder="例如 前端实现 / 代码评审" onChange={e => onChange({ name: e.target.value })} /></label>
        <label>职责<input value={form.title} maxLength={120} disabled={busy} placeholder="例如 负责服务端接口与迁移" onChange={e => onChange({ title: e.target.value })} /></label>
        <label>执行工具（必填）
          <select value={form.agent} disabled={busy} onChange={e => onChange({ agent: e.target.value, model: "" })}>
            <option value="" disabled>选一个能派活的工具</option>
            {DISPATCHABLE.map(key => <option key={key} value={key}>{AGENT_LABEL[key]}</option>)}
          </select>
        </label>
        <label>模型<ModelPicker key={form.agent} agent={form.agent} value={form.model} disabled={busy} onChange={model => onChange({ model })} /></label>
        <label>可用工具<input value={form.tools} maxLength={600} disabled={busy} placeholder="例如 Read、Edit、Bash" onChange={e => onChange({ tools: e.target.value })} /></label>
        <label>项目经理
          <select value={form.manager ? "yes" : "no"} disabled={busy} onChange={e => onChange({ manager: e.target.value === "yes" })}>
            <option value="no">不担任</option>
            <option value="yes">担任（发单先找它补写并派活）</option>
          </select>
        </label>
      </div>
      {form.manager && (
        <div className="profile-picks">
          <div className="profile-picks-head">
            <span>管哪些项目</span>
            <span className="dim">一个都不勾 = 所有项目都管；同一个项目只留一位专属经理</span>
          </div>
          {projects.map(p => {
            const on = form.managerProjects.includes(p.id);
            return (
              <label key={p.id} className={on ? "pick on" : "pick"}>
                <input type="checkbox" checked={on} disabled={busy} onChange={() => toggleProject(p.id)} />
                <span>{p.name}</span>
              </label>
            );
          })}
          {projects.length === 0 && <p className="hint">还没有项目。没有项目时它管所有项目。</p>}
        </div>
      )}
      <label>上下文（角色准则，最多 4000 字）
        <textarea value={form.context} rows={4} maxLength={4000} disabled={busy} placeholder={"例如：只改前端，动手前先读现有写法；改完跑 tsc；不确定的地方先问，不要猜。"} onChange={e => onChange({ context: e.target.value })} />
      </label>
      <p className="hint">Claude 走系统提示（--append-system-prompt），Codex 没有等价钩子，执行器会把上下文放在首条消息前面；模型可以留空：留空后由项目经理在派活时按任务复杂度，从同一个工具的清单里挑一档（Claude 是 haiku / sonnet / opus），挑中的模型和理由记在那次执行记录里；工具没有可挑清单时才落回执行端自己的默认模型。执行工具决定派活时能挑哪些电脑——只有上报装了它的电脑会出现在任务里；角色不绑电脑，具体在哪台、哪个目录由任务定。可用工具只是声明，方便你和别人看清职责边界，不会真的改变执行端权限。</p>
    </>
  );
}
