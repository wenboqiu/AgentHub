import { useCallback, useEffect, useState } from "react";
import type { Api, Profile, Project, ProjectInput } from "./lib/api";

// 项目管理：一个代码库的身份与背景知识。
// 和项目配置（profile）分工——项目说「这是什么、有什么约定」，配置说「在哪台电脑、哪个目录做」；
// 项目可以指一套默认配置，派活时任务没指定配置就用它。
// 项目里的「约定」会随派活注入给执行端，角色在这个项目上的经验单独记在角色记忆里。

type Form = { name: string; brief: string; profileId: string };
const BLANK: Form = { name: "", brief: "", profileId: "" };
const toForm = (p: Project): Form => ({ name: p.name, brief: p.brief, profileId: p.profileId === null ? "" : String(p.profileId) });
const toInput = (f: Form): ProjectInput => ({
  name: f.name.trim(),
  brief: f.brief.trim(),
  profileId: f.profileId ? Number(f.profileId) : null,
});

function Fields({ form, busy, profiles, onChange }: { form: Form; busy: boolean; profiles: Profile[]; onChange(patch: Partial<Form>): void }) {
  return (
    <>
      <div className="form-grid">
        <label>项目名<input value={form.name} maxLength={60} disabled={busy} placeholder="例如 AgentHub" onChange={e => onChange({ name: e.target.value })} /></label>
        <label>默认配置<select value={form.profileId} disabled={busy} onChange={e => onChange({ profileId: e.target.value })}><option value="">不指定</option>{profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      </div>
      <label>项目说明（技术栈、约定、不能碰的东西；最多 4000 字）
        <textarea value={form.brief} rows={4} maxLength={4000} disabled={busy} placeholder={"例如：Fastify + Postgres；接口统一 camelCase；改完跑 npm test 和 tsc；不要动 migrations 里已有的文件。"} onChange={e => onChange({ brief: e.target.value })} />
      </label>
      <p className="hint">项目说明会随派活一起下发给执行端；角色在这个项目上的经验另存在角色记忆里。</p>
    </>
  );
}

export default function Projects({ api }: { api: Api }) {
  const [list, setList] = useState<Project[] | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [forms, setForms] = useState<Record<string, Form>>({});
  const [adding, setAdding] = useState(false), [draft, setDraft] = useState<Form>(BLANK);
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState(""), [err, setErr] = useState("");

  const load = useCallback(() => {
    api.projects().then(
      (ps) => { setList(ps); setForms(Object.fromEntries(ps.map((p) => [String(p.id), toForm(p)]))); },
      () => setList([]),
    );
    api.profiles().then(setProfiles, () => setProfiles([]));
  }, [api]);
  useEffect(() => { load(); }, [load]);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true); setErr(""); setMsg("");
    try { await fn(); setMsg(done); load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const profileName = (id: number | null) => (id === null ? "" : profiles.find(p => p.id === id)?.name ?? "");

  return (
    <section className="box">
      <h2>项目</h2>
      <p className="hint">
        一个项目 = 一个代码库的身份和它的约定。派活时选中项目，项目说明会随上下文一起下发；角色在这个项目上的经验按项目分开记，换个项目不会带过去。
      </p>
      {list === null ? (
        <p className="hint">加载中…</p>
      ) : (
        <>
          {list.length === 0 && !adding && <p className="hint">还没有项目。建一个之后，派活时选项目就能带上它的约定和该角色在这个项目上的经验。</p>}
          {list.map((p) => {
            const form = forms[String(p.id)] ?? toForm(p);
            const dirty = JSON.stringify(form) !== JSON.stringify(toForm(p));
            return (
              <div key={p.id} className="profile-card">
                <div className="profile-head">
                  <strong>{p.name}</strong>
                  <span className="dim">
                    {`${p.tasks} 个任务`}
                    {p.profileId !== null ? ` · 默认配置 ${profileName(p.profileId) || p.profileId}` : ""}
                  </span>
                </div>
                <Fields form={form} busy={busy} profiles={profiles} onChange={(patch) => setForms((m) => ({ ...m, [String(p.id)]: { ...(m[String(p.id)] ?? toForm(p)), ...patch } }))} />
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
              <Fields form={draft} busy={busy} profiles={profiles} onChange={(patch) => setDraft((f) => ({ ...f, ...patch }))} />
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
