import { useCallback, useEffect, useState } from "react";
import type { Api, Memory, Project, Role, RoleInput } from "./lib/api";
import { AGENT_LABEL, DISPATCHABLE_AGENTS } from "./lib/agents";
import Assistant from "./Assistant";
import ModelPicker from "./ModelPicker";

/** 只有能真正派活的 agent 才可选；豆包 / WorkBuddy 只做状态监听 */
const DISPATCHABLE = DISPATCHABLE_AGENTS;

// 角色管理：像员工一样——有职责、执行工具、模型、准则、可用工具声明，
// 还有一份按项目分区的记忆（手写的须知 + 验收打回自动沉淀的经验）。
// 角色只管「人」；「在哪台电脑、哪个目录」是项目的事（项目里的目录列表，按当前电脑自动挑）。

type Form = { name: string; title: string; agent: string; model: string; context: string; tools: string; manager: boolean; managerProjects: number[] };
const BLANK: Form = { name: "", title: "", agent: "claude", model: "", context: "", tools: "", manager: false, managerProjects: [] };
const toForm = (r: Role): Form => ({
  name: r.name, title: r.title, agent: r.agent ?? "", model: r.model ?? "", context: r.context,
  tools: r.tools.join("、"),
  manager: r.manager, managerProjects: r.managerProjects,
});
const toInput = (f: Form): RoleInput => ({
  name: f.name.trim(),
  title: f.title.trim(),
  agent: (f.agent || null) as Role["agent"],
  model: f.model.trim() || null,
  context: f.context.trim(),
  // 逗号/顿号/空格都能分隔，方便从文档里直接粘
  tools: f.tools.split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean),
  manager: f.manager,
  // 不担任经理时管辖范围无意义，一律清空（服务端也会清）
  managerProjects: f.manager ? f.managerProjects : [],
});

function Fields({ form, projects, busy, onChange }: {
  form: Form; projects: Project[]; busy: boolean; onChange(patch: Partial<Form>): void;
}) {
  const toggleProject = (id: number) => onChange({
    managerProjects: form.managerProjects.includes(id)
      ? form.managerProjects.filter(x => x !== id)
      : [...form.managerProjects, id],
  });
  return (
    <>
      <div className="form-grid">
        <label>角色名<input value={form.name} maxLength={60} disabled={busy} placeholder="例如 前端实现 / 代码评审" onChange={e => onChange({ name: e.target.value })} /></label>
        <label>职责<input value={form.title} maxLength={120} disabled={busy} placeholder="例如 负责服务端接口与迁移" onChange={e => onChange({ title: e.target.value })} /></label>
        <label>执行工具<select value={form.agent} disabled={busy} onChange={e => onChange({ agent: e.target.value, model: "" })}><option value="">未指定</option>{DISPATCHABLE.map(key => <option key={key} value={key}>{AGENT_LABEL[key]}</option>)}</select></label>
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
      <p className="hint">Claude 走系统提示（--append-system-prompt），Codex 没有等价钩子，执行器会把上下文放在首条消息前面；模型从下拉里挑，留空就用执行端默认（推荐，换版本不用回来改）。可用工具只是声明，方便你和别人看清职责边界，不会真的改变执行端权限。</p>
    </>
  );
}

/** 记忆面板：按项目分区展示，可手写、可删；打回沉淀的条目带标记 */
function Memories({ api, roleId, projects, onError }: { api: Api; roleId: number; projects: Project[]; onError(msg: string): void }) {
  const [list, setList] = useState<Memory[] | null>(null);
  const [text, setText] = useState(""), [projectId, setProjectId] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.memories(roleId).then(setList, () => setList([]));
  }, [api, roleId]);
  useEffect(() => { load(); }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); load(); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const projectName = (id: number | null) => (id === null ? "通用" : projects.find(p => p.id === id)?.name ?? `项目 ${id}`);

  return (
    <div className="memory-block">
      <div className="memory-head">
        <strong>记忆</strong>
        <span className="dim">{list === null ? "…" : `${list.length} 条 · 派活时自动带上`}</span>
      </div>
      {list?.length === 0 && <p className="hint">还没有记忆。手写几条须知，或者等验收打回时自动沉淀。</p>}
      {list?.map(m => (
        <div key={m.id} className="memory-row">
          <div className="memory-main">
            <span className="memory-text">{m.content}</span>
            <span className="dim">
              {projectName(m.projectId)}
              {m.source === "review" ? " · 打回沉淀" : ""}
              {m.weight > 1 ? ` · 出现 ${m.weight} 次` : ""}
              {m.uses > 0 ? ` · 用过 ${m.uses} 次` : " · 还没用过"}
            </span>
          </div>
          <button className="ghost" disabled={busy} aria-label="删除这条记忆" onClick={() => void act(() => api.deleteMemory(roleId, m.id))}>删除</button>
        </div>
      ))}
      <div className="memory-add">
        <input value={text} maxLength={500} disabled={busy} placeholder="记一条经验，例如：改完必须跑一遍全量测试" onChange={e => setText(e.target.value)} />
        <select value={projectId} disabled={busy} onChange={e => setProjectId(e.target.value)}>
          <option value="">通用（所有项目）</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button className="primary" disabled={busy || !text.trim()} onClick={() => void act(async () => {
          await api.addMemory(roleId, text.trim(), projectId ? Number(projectId) : null);
          setText("");
        })}>添加</button>
      </div>
    </div>
  );
}

export default function Roles({ api }: { api: Api }) {
  const [list, setList] = useState<Role[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [forms, setForms] = useState<Record<string, Form>>({});
  const [adding, setAdding] = useState(false), [draft, setDraft] = useState<Form>(BLANK);
  const [openMem, setOpenMem] = useState<number | null>(null);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [assist, setAssist] = useState(false);
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState(""), [err, setErr] = useState("");

  const load = useCallback(() => {
    api.roles().then(
      (rs) => { setList(rs); setForms(Object.fromEntries(rs.map((r) => [String(r.id), toForm(r)]))); },
      () => setList([]),
    );
    api.projects().then(setProjects, () => setProjects([]));
  }, [api]);
  useEffect(() => { load(); }, [load]);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true); setErr(""); setMsg("");
    try { await fn(); setMsg(done); load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <section className="box">
      <div className="box-head">
        <h2>角色</h2>
        <button className="ghost" aria-expanded={assist} onClick={() => setAssist(v => !v)}>
          {assist ? "收起助手" : "让助手建"}
        </button>
      </div>
      <p className="hint">
        把「谁来干、什么职责、用什么模型、按什么准则、记得什么」存成一个名字——像一名员工。建任务或派活时选角色，执行工具就定了，模型、准则、项目背景和这个项目的经验一起下发给电脑端；在哪个目录干活由选中的项目按当前电脑自动挑。
      </p>
      {assist && <Assistant api={api} onCreated={load} onClose={() => setAssist(false)} />}
      {list === null ? (
        <p className="hint">加载中…</p>
      ) : (
        <>
          {list.length === 0 && !adding && <p className="hint">还没有角色。建一个之后，派活时选名字就行，不用每次挑工具填模型。</p>}
          {list.map((r) => {
            const form = forms[String(r.id)] ?? toForm(r);
            const dirty = JSON.stringify(form) !== JSON.stringify(toForm(r));
            const expanded = !!open[r.id];
            return (
              <div key={r.id} className="profile-card">
                <button type="button" className="role-head" aria-expanded={expanded}
                  onClick={() => setOpen((o) => ({ ...o, [r.id]: !o[r.id] }))}>
                  <strong>{r.name}</strong>
                  {r.agent && <span className={`tag ${r.agent}`}>{AGENT_LABEL[r.agent] ?? r.agent}</span>}
                  {r.manager && <span className="tag manager">项目经理</span>}
                  <span className="dim role-title">{r.title || "职责未写"}</span>
                  <span className="role-meta">
                    {r.manager && <span>{r.managerProjects.length === 0 ? "管所有项目" : `管 ${r.managerProjects.map(id => projects.find(p => p.id === id)?.name ?? `项目 ${id}`).join("、")}`}</span>}
                    {r.model && <code>{r.model}</code>}
                    <span>{r.tasks} 个任务</span>
                  </span>
                  {dirty && <span className="badge">未保存</span>}
                  <span className="role-toggle">{expanded ? "收起" : "编辑"}</span>
                </button>
                {expanded && (
                  <>
                    <Fields form={form} projects={projects} busy={busy} onChange={(patch) => setForms((m) => ({ ...m, [String(r.id)]: { ...(m[String(r.id)] ?? toForm(r)), ...patch } }))} />
                    <div className="btns">
                      <button className="primary" disabled={busy || !dirty} onClick={() => void run(() => api.updateRole(r.id, toInput(form)), "角色已保存")}>保存</button>
                      <button className="ghost" disabled={busy} onClick={() => void run(() => api.deleteRole(r.id), "角色已删除")}>删除</button>
                      <button className="ghost" aria-expanded={openMem === r.id} onClick={() => setOpenMem(openMem === r.id ? null : r.id)}>
                        {openMem === r.id ? "收起记忆" : "记忆"}
                      </button>
                    </div>
                    {openMem === r.id && <Memories api={api} roleId={r.id} projects={projects} onError={setErr} />}
                  </>
                )}
              </div>
            );
          })}
          {adding ? (
            <div className="profile-card">
              <div className="profile-head"><strong>新建角色</strong></div>
              <Fields form={draft} projects={projects} busy={busy} onChange={(patch) => setDraft((f) => ({ ...f, ...patch }))} />
              <div className="btns">
                <button className="primary" disabled={busy || !draft.name.trim()} onClick={() => void run(async () => { await api.createRole(toInput(draft) as RoleInput & { name: string }); setDraft(BLANK); setAdding(false); }, "角色已创建")}>创建</button>
                <button className="ghost" onClick={() => { setAdding(false); setDraft(BLANK); }}>取消</button>
              </div>
            </div>
          ) : (
            <button className="ghost" onClick={() => setAdding(true)}>＋ 新建角色</button>
          )}
        </>
      )}
      {err && <p className="form-error" role="alert">{err}</p>}
      {msg && <p className="msg">{msg}</p>}
    </section>
  );
}
