import { useCallback, useEffect, useState } from "react";
import type { Api, BriefEntry, Project, ProjectDir, ProjectInput } from "./lib/api";

// 项目管理：一个代码库的身份与背景知识 + 它在各台电脑上的目录。
// 目录列表回答「这个项目在哪些电脑上住在哪」——派活时按当前那台电脑自动挑对应目录，
// 路径不用手改。项目说明会随派活注入给执行端；角色在这个项目上的经验单独记在角色记忆里。

type Form = { name: string; brief: string; dirs: ProjectDir[] };
const BLANK: Form = { name: "", brief: "", dirs: [] };
const toForm = (p: Project): Form => ({ name: p.name, brief: p.brief, dirs: p.dirs.map(d => ({ ...d })) });
const toInput = (f: Form): ProjectInput => ({
  name: f.name.trim(),
  brief: f.brief.trim(),
  dirs: f.dirs.filter(d => d.cwd.trim()),
});

/** 目录列表编辑：一条 = 电脑名（可留空 = 哪台都行）+ 路径。服务端会校验同电脑不重复。 */
function Dirs({ form, busy, onChange }: { form: Form; busy: boolean; onChange(patch: Partial<Form>): void }) {
  const set = (i: number, patch: Partial<ProjectDir>) => onChange({
    dirs: form.dirs.map((d, j) => (j === i ? { ...d, ...patch } : d)),
  });
  return (
    <div className="profile-picks">
      <div className="profile-picks-head">
        目录列表
        <span className="dim">这个项目在各台电脑上住在哪；派活时按当前电脑自动挑，留空电脑名 = 哪台都适用</span>
      </div>
      {form.dirs.length === 0 && <p className="hint">还没有目录。至少登记一条，派活时才能自动定下路径。</p>}
      {form.dirs.map((d, i) => (
        <div key={i} className="form-grid">
          <label>电脑<input value={d.machine ?? ""} maxLength={100} disabled={busy} placeholder="客户端上报的电脑名，留空 = 任意" onChange={e => set(i, { machine: e.target.value.trim() || null })} /></label>
          <label>项目目录<input value={d.cwd} maxLength={4000} disabled={busy} placeholder={"例如 D:\\Work2\\AgentHub"} onChange={e => set(i, { cwd: e.target.value })} /></label>
          <button className="ghost" disabled={busy} onClick={() => onChange({ dirs: form.dirs.filter((_, j) => j !== i) })}>移除</button>
        </div>
      ))}
      <button className="ghost" disabled={busy} onClick={() => onChange({ dirs: [...form.dirs, { machine: null, cwd: "" }] })}>＋ 加一条目录</button>
    </div>
  );
}

function Fields({ form, busy, onChange }: { form: Form; busy: boolean; onChange(patch: Partial<Form>): void }) {
  return (
    <>
      <div className="form-grid">
        <label>项目名<input value={form.name} maxLength={60} disabled={busy} placeholder="例如 AgentHub" onChange={e => onChange({ name: e.target.value })} /></label>
      </div>
      <Dirs form={form} busy={busy} onChange={onChange} />
      <label>项目说明（技术栈、约定、不能碰的东西；最多 4000 字）
        <textarea value={form.brief} rows={4} maxLength={4000} disabled={busy} placeholder={"例如：Fastify + Postgres；接口统一 camelCase；改完跑 npm test 和 tsc；不要动 migrations 里已有的文件。"} onChange={e => onChange({ brief: e.target.value })} />
      </label>
      <p className="hint">项目说明会随派活一起下发给执行端；角色在这个项目上的经验另存在角色记忆里。</p>
    </>
  );
}

// 项目近况：任务完成时服务端自动追加一句结论，派活时取最近几条注入提示。
// 和上面的「项目说明」分工——说明是人写的长期背景，近况是机器记的滚动进展。
function Brief({ api, projectId }: { api: Api; projectId: number }) {
  const [entries, setEntries] = useState<BriefEntry[] | null>(null);
  const [text, setText] = useState(""), [busy, setBusy] = useState(false), [err, setErr] = useState("");
  const load = () => api.projectBrief(projectId).then(setEntries, () => setEntries([]));
  const run = async (fn: () => Promise<BriefEntry[]>) => {
    setBusy(true); setErr("");
    try { setEntries(await fn()); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <details className="brief" onToggle={e => { if (e.currentTarget.open && entries === null) void load(); }}>
      <summary>项目近况<span className="dim">任务跑完自动记一句，派活时最近 8 条随上下文下发</span></summary>
      {entries === null ? <p className="hint">加载中…</p> : (
        <>
          {entries.length === 0
            ? <p className="hint">还没有近况。任务跑完会自动记一条；也可以现在手写一条约定或进展。</p>
            : (
              <ul className="brief-list">
                {entries.map(e => (
                  <li key={e.id}>
                    <span className="dim">{new Date(e.at).toLocaleDateString()}</span>
                    <span className="brief-text">{e.text}</span>
                    <button className="link" disabled={busy} onClick={() => void run(() => api.deleteBrief(projectId, e.id))}>删除</button>
                  </li>
                ))}
              </ul>
            )}
          <form className="brief-add" onSubmit={ev => { ev.preventDefault(); if (!text.trim()) return; void run(async () => { const r = await api.addBrief(projectId, text.trim()); setText(""); return r; }); }}>
            <input value={text} maxLength={240} disabled={busy} placeholder="例如：登录改造已合并，回跳暂时仍走旧参数" onChange={e => setText(e.target.value)} />
            <button disabled={busy || !text.trim()}>记一条</button>
          </form>
          {err && <p className="form-error" role="alert">{err}</p>}
        </>
      )}
    </details>
  );
}

export default function Projects({ api }: { api: Api }) {
  const [list, setList] = useState<Project[] | null>(null);
  const [forms, setForms] = useState<Record<string, Form>>({});
  const [adding, setAdding] = useState(false), [draft, setDraft] = useState<Form>(BLANK);
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState(""), [err, setErr] = useState("");

  const load = useCallback(() => {
    api.projects().then(
      (ps) => { setList(ps); setForms(Object.fromEntries(ps.map((p) => [String(p.id), toForm(p)]))); },
      () => setList([]),
    );
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
      <h2>项目</h2>
      <p className="hint">
        一个项目 = 一个代码库的身份、它的约定、以及它在你各台电脑上的目录。派活时选中项目，说明随上下文下发、目录按当前那台电脑自动挑；
        角色在这个项目上的经验按项目分开记，换个项目不会带过去。
      </p>
      {list === null ? (
        <p className="hint">加载中…</p>
      ) : (
        <>
          {list.length === 0 && !adding && <p className="hint">还没有项目。建一个之后，派活时选项目就能带上它的约定和对应目录。</p>}
          {list.map((p) => {
            const form = forms[String(p.id)] ?? toForm(p);
            const dirty = JSON.stringify(form) !== JSON.stringify(toForm(p));
            return (
              <div key={p.id} className="profile-card">
                <div className="profile-head">
                  <strong>{p.name}</strong>
                  <span className="dim">
                    {`${p.tasks} 个任务`}
                    {p.dirs.length ? ` · ${p.dirs.map(d => `${d.machine ?? "任意"}:${d.cwd}`).join("、")}` : " · 未登记目录"}
                  </span>
                </div>
                <Fields form={form} busy={busy} onChange={(patch) => setForms((m) => ({ ...m, [String(p.id)]: { ...(m[String(p.id)] ?? toForm(p)), ...patch } }))} />
                <Brief api={api} projectId={p.id} />
                <div className="btns">
                  <button className="primary" disabled={busy || !dirty} onClick={() => void run(() => api.updateProject(p.id, toInput(form)), "项目已保存")}>保存</button>
                  <button className="ghost" disabled={busy} onClick={() => void run(() => api.deleteProject(p.id), "项目已删除")}>删除</button>
                </div>
              </div>
            );
          })}
          {adding ? (
            <div className="profile-card">
              <div className="profile-head"><strong>新建项目</strong></div>
              <Fields form={draft} busy={busy} onChange={(patch) => setDraft((f) => ({ ...f, ...patch }))} />
              <div className="btns">
                <button className="primary" disabled={busy || !draft.name.trim()} onClick={() => void run(async () => { await api.createProject(toInput(draft) as ProjectInput & { name: string }); setDraft(BLANK); setAdding(false); }, "项目已创建")}>创建</button>
                <button className="ghost" onClick={() => { setAdding(false); setDraft(BLANK); }}>取消</button>
              </div>
            </div>
          ) : (
            <button className="ghost" onClick={() => setAdding(true)}>＋ 新建项目</button>
          )}
        </>
      )}
      {err && <p className="form-error" role="alert">{err}</p>}
      {msg && <p className="msg">{msg}</p>}
    </section>
  );
}
