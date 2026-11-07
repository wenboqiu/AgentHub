import { useCallback, useEffect, useState } from "react";
import type { Api, Memory, Project, Role, RoleInput } from "./lib/api";
import { AGENT_LABEL } from "./lib/agents";
import { autoModelRange } from "./lib/models";
import Assistant from "./Assistant";
import RoleFields, { BLANK_ROLE, formToInput, roleReady, roleToForm } from "./RoleFields";

// 角色管理：像员工一样——有职责、执行工具、模型、准则、可用工具声明，
// 还有一份按项目分区的记忆（手写的须知 + 验收打回自动沉淀的经验）。
// 角色只管「人」；「在哪台电脑、哪个目录」是项目 / 任务的事。
// 列表页只管浏览和入口：点一条进详情页改，新建也走同一个详情页——
// 表单长、还有记忆一大块，摊在列表里会把别的角色挤出屏幕。
// 字段本身由 RoleFields 统一提供：助手草稿卡用的是同一套，不会两处不一样。

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

/**
 * 角色详情：独立一页，字段就地编辑 + 记忆 + 删除。
 * 新建也走这里（role = null）：建完不跳走，直接变成这个角色的详情页，接着补记忆。
 */
export function RoleEditor({ api, role: initial, onBack, onSaved, onDeleted }: {
  api: Api;
  /** null = 新建 */
  role: Role | null;
  onBack(): void;
  /** 建好 / 保存后回传最新角色（外层用它的名字做页标题） */
  onSaved(r: Role): void;
  onDeleted(): void;
}) {
  const [role, setRole] = useState<Role | null>(initial);
  const [form, setForm] = useState(() => (initial ? roleToForm(initial) : BLANK_ROLE));
  const [projects, setProjects] = useState<Project[]>([]);
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState(""), [err, setErr] = useState("");

  // 经理管辖范围的下拉选项
  useEffect(() => { api.projects().then(setProjects, () => setProjects([])); }, [api]);

  // 与上次保存下来的那份比，才判断得出有没有改动
  const dirty = JSON.stringify(form) !== JSON.stringify(role ? roleToForm(role) : BLANK_ROLE);

  const save = async () => {
    setBusy(true); setErr(""); setMsg("");
    const creating = !role;
    try {
      const r = creating
        ? await api.createRole(formToInput(form) as RoleInput & { name: string })
        : await api.updateRole(role.id, formToInput(form));
      setRole(r);
      setForm(roleToForm(r));
      onSaved(r);
      setMsg(creating ? "角色已创建，接着补记忆或直接返回" : "角色已保存");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!role) return;
    setBusy(true); setErr(""); setMsg("");
    try {
      await api.deleteRole(role.id);
      onDeleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <>
      <section className="box">
        <div className="box-head">
          <h2>基本信息</h2>
          {dirty && <span className="badge">未保存</span>}
        </div>
        <RoleFields form={form} projects={projects} busy={busy} onChange={(patch) => setForm((f) => ({ ...f, ...patch }))} />
        <div className="btns">
          <button className="primary" disabled={busy || !dirty || !roleReady(form)} onClick={() => void save()}>
            {role ? "保存" : "创建角色"}
          </button>
          <button className="ghost" disabled={busy} onClick={onBack}>返回列表</button>
          {!roleReady(form) && <span className="dim">角色名和执行工具必填，其余可以之后慢慢补。</span>}
        </div>
        {msg && <p className="msg">{msg}</p>}
        {err && <p className="form-error" role="alert">{err}</p>}
      </section>

      {role && (
        <section className="box role-memories">
          <Memories api={api} roleId={role.id} projects={projects} onError={setErr} />
        </section>
      )}

      {role && (
        <section className="box">
          <div className="btns">
            <button className="ghost" disabled={busy} onClick={() => void remove()}>删除角色</button>
            <span className="dim">已经派出去的任务不会被删掉，只是不再带这个角色；当前有 {role.tasks} 个任务用过它。</span>
          </div>
        </section>
      )}
    </>
  );
}

/** 角色列表：一条一行，点进去才是编辑页 */
export default function Roles({ api, onEdit }: { api: Api; onEdit(role: Role | null): void }) {
  const [list, setList] = useState<Role[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [assist, setAssist] = useState(false);

  const load = useCallback(() => {
    api.roles().then(setList, () => setList([]));
    api.projects().then(setProjects, () => setProjects([]));
  }, [api]);
  useEffect(() => { load(); }, [load]);

  return (
    <section className="box">
      <div className="box-head">
        <h2>角色</h2>
        <button className="ghost" aria-expanded={assist} onClick={() => setAssist(v => !v)}>
          {assist ? "收起助手" : "让助手建"}
        </button>
      </div>
      <p className="hint">
        把「谁来干、什么职责、用什么模型、按什么准则、记得什么」存成一个名字——像一名员工。角色绑执行工具和模型，但不绑电脑：派活时只在「装了该工具的电脑」里挑，具体在哪台、哪个目录由任务定。建任务或派活时选角色，工具、模型、准则和这个项目的经验一起下发。
      </p>
      {assist && <Assistant api={api} onCreated={r => { load(); onEdit(r); }} onClose={() => setAssist(false)} />}
      {list === null ? (
        <p className="hint">加载中…</p>
      ) : (
        <>
          {list.length === 0 && <p className="hint">还没有角色。建一个之后，派活时选名字就行，不用每次挑工具填模型。</p>}
          {list.map((r) => (
            <div key={r.id} className="profile-card">
              <button type="button" className="role-head" onClick={() => onEdit(r)}>
                <strong>{r.name}</strong>
                {r.agent && <span className={`tag ${r.agent}`}>{AGENT_LABEL[r.agent] ?? r.agent}</span>}
                {!r.agent && <span className="badge">缺执行工具</span>}
                {r.manager && <span className="tag manager">项目经理</span>}
                <span className="dim role-title">{r.title || "职责未写"}</span>
                <span className="role-meta">
                  {r.manager && <span>{r.managerProjects.length === 0 ? "管所有项目" : `管 ${r.managerProjects.map(id => projects.find(p => p.id === id)?.name ?? `项目 ${id}`).join("、")}`}</span>}
                  {r.model ? <code>{r.model}</code> : autoModelRange(r.agent).length > 0 && <span title="派活时由项目经理按任务复杂度挑">模型代挑</span>}
                  <span>{r.tasks} 个任务</span>
                </span>
                <span className="role-toggle">编辑</span>
              </button>
            </div>
          ))}
          <button className="ghost" onClick={() => onEdit(null)}>＋ 新建角色</button>
        </>
      )}
    </section>
  );
}
