import { useCallback, useEffect, useState } from "react";
import type { Api, BriefEntry, Profile, Project, ProjectInput } from "./lib/api";

// 项目管理：一个代码库的身份与背景知识。
// 和项目配置（profile）分工——项目说「这是什么、有什么约定」，配置说「在哪台电脑、哪个目录做」；
// 项目可以挂多套配置（家里台式机一套、Mac 一套），派活时按当前那台机器自动挑，路径不用手改。
// 项目里的「约定」会随派活注入给执行端，角色在这个项目上的经验单独记在角色记忆里。

type Form = { name: string; brief: string; profileIds: string[] };
const BLANK: Form = { name: "", brief: "", profileIds: [] };
// 兜底：老服务端 / 预览数据可能只有单个 profileId
const idsOf = (p: Project): string[] =>
  (p.profileIds ?? (p.profileId === null ? [] : [p.profileId])).map(String);
const toForm = (p: Project): Form => ({ name: p.name, brief: p.brief, profileIds: idsOf(p) });
const toInput = (f: Form): ProjectInput => ({
  name: f.name.trim(),
  brief: f.brief.trim(),
  profileIds: f.profileIds.map(Number),
  // 只认单配置的旧服务端也有个说法：第一套当默认
  profileId: f.profileIds.length ? Number(f.profileIds[0]) : null,
});

function Picks({ form, busy, profiles, onChange }: { form: Form; busy: boolean; profiles: Profile[]; onChange(patch: Partial<Form>): void }) {
  return (
    <div className="profile-picks">
      <div className="profile-picks-head">
        执行配置
        <span className="dim">可多选：每台电脑一套，派活时按当前机器自动挑，目录不会串设备</span>
      </div>
      {profiles.length === 0
        ? <p className="hint">还没有配置。先到「配置」里给每台电脑建一套（电脑 + 目录），再回来挂上。</p>
        : profiles.map(p => {
          const on = form.profileIds.includes(String(p.id));
          return (
            <label key={p.id} className={`pick${on ? " on" : ""}`}>
              <input type="checkbox" checked={on} disabled={busy} onChange={e => onChange({
                profileIds: e.target.checked
                  ? [...form.profileIds, String(p.id)]
                  : form.profileIds.filter(x => x !== String(p.id)),
              })} />
              <span className="pick-main">
                <strong>{p.name}</strong>
                <span className="dim">{p.machine ?? "任意电脑"} · {p.cwd ?? "未填目录"}</span>
              </span>
            </label>
          );
        })}
    </div>
  );
}

function Fields({ form, busy, profiles, onChange }: { form: Form; busy: boolean; profiles: Profile[]; onChange(patch: Partial<Form>): void }) {
  return (
    <>
      <div className="form-grid">
        <label>项目名<input value={form.name} maxLength={60} disabled={busy} placeholder="例如 AgentHub" onChange={e => onChange({ name: e.target.value })} /></label>
      </div>
      <Picks form={form} busy={busy} profiles={profiles} onChange={onChange} />
      <label>项目说明（技术栈、约定、不能碰的东西；最多 4000 字）
        <textarea value={form.brief} rows={4} maxLength={4000} disabled={busy} placeholder={"例如：Fastify + Postgres；接口统一 camelCase；改完跑 npm test 和 tsc；不要动 migrations 里已有的文件。"} onChange={e => onChange({ brief: e.target.value })} />
      </label>
      <p className="hint">项目说明会随派活一起下发给执行端；角色在这个项目上的经验另存在角色记忆里。项目本身不存路径，路径跟着配置走。</p>
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
        同一个项目在不同电脑上的目录不同？给每台电脑各建一套配置挂上来就行，派活时按当前那台自动匹配。
      </p>
      {list === null ? (
        <p className="hint">加载中…</p>
      ) : (
        <>
          {list.length === 0 && !adding && <p className="hint">还没有项目。建一个之后，派活时选项目就能带上它的约定和该角色在这个项目上的经验。</p>}
          {list.map((p) => {
            const form = forms[String(p.id)] ?? toForm(p);
            const dirty = JSON.stringify(form) !== JSON.stringify(toForm(p));
            const names = idsOf(p).map(id => profileName(Number(id)) || `配置 ${id}`);
            return (
              <div key={p.id} className="profile-card">
                <div className="profile-head">
                  <strong>{p.name}</strong>
                  <span className="dim">
                    {`${p.tasks} 个任务`}
                    {names.length ? ` · ${names.join("、")}` : " · 未挂配置"}
                  </span>
                </div>
                <Fields form={form} busy={busy} profiles={profiles} onChange={(patch) => setForms((m) => ({ ...m, [String(p.id)]: { ...(m[String(p.id)] ?? toForm(p)), ...patch } }))} />
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
