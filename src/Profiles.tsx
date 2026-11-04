import { useCallback, useEffect, useState } from "react";
import type { Api, Profile, ProfileInput } from "./lib/api";
import { AGENT_LABEL } from "./lib/agents";

/** 只有这两个能真正派活；豆包 / WorkBuddy 只做状态监听，放进默认值只会让派活报错 */
const DISPATCHABLE = ["claude", "codex"];

// 项目配置管理：一条配置 = 用哪个 agent、哪台电脑、哪个目录、默认优先级、验收要看哪几项。
// 它不给人格和 prompt——那是执行端的事；这里只是把「派活要填的三个格 + 验收标准」命名复用。

type Form = { name: string; agent: string; machine: string; cwd: string; priority: Profile["priority"]; checklist: string };
const BLANK: Form = { name: "", agent: "", machine: "", cwd: "", priority: "medium", checklist: "" };
const toForm = (p: Profile): Form => ({ name: p.name, agent: p.agent ?? "", machine: p.machine ?? "", cwd: p.cwd ?? "", priority: p.priority, checklist: p.checklist.join("\n") });
const toInput = (f: Form): ProfileInput => ({
  name: f.name.trim(),
  agent: (f.agent || null) as Profile["agent"],
  machine: f.machine.trim() || null,
  cwd: f.cwd.trim() || null,
  priority: f.priority,
  // 一行一条：检查项模板会自动并入任务清单，再同步成验收检查项
  checklist: f.checklist.split("\n").map(s => s.trim()).filter(Boolean),
});

function Fields({ form, busy, onChange }: { form: Form; busy: boolean; onChange(patch: Partial<Form>): void }) {
  return (
    <>
      <div className="form-grid">
        <label>配置名<input value={form.name} maxLength={60} disabled={busy} placeholder="例如 AgentHub 前端" onChange={e => onChange({ name: e.target.value })} /></label>
        <label>执行工具<select value={form.agent} disabled={busy} onChange={e => onChange({ agent: e.target.value })}><option value="">未指定</option>{DISPATCHABLE.map(key => <option key={key} value={key}>{AGENT_LABEL[key]}</option>)}</select></label>
        <label>电脑<input value={form.machine} maxLength={4000} disabled={busy} placeholder="例如 台机" onChange={e => onChange({ machine: e.target.value })} /></label>
        <label>项目目录<input value={form.cwd} maxLength={4000} disabled={busy} placeholder={"例如 D:\\Work2\\AgentHub"} onChange={e => onChange({ cwd: e.target.value })} /></label>
        <label>默认优先级<select value={form.priority} disabled={busy} onChange={e => onChange({ priority: e.target.value as Profile["priority"] })}><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label>
      </div>
      <label>检查项模板（一行一条，最多 30 条）
        <textarea value={form.checklist} rows={4} maxLength={6000} disabled={busy} placeholder={"tsc 通过\nbuild 通过\n手动点一遍主流程"} onChange={e => onChange({ checklist: e.target.value })} />
      </label>
    </>
  );
}

export default function Profiles({ api }: { api: Api }) {
  const [list, setList] = useState<Profile[] | null>(null);
  const [forms, setForms] = useState<Record<string, Form>>({});
  const [adding, setAdding] = useState(false), [draft, setDraft] = useState<Form>(BLANK);
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState(""), [err, setErr] = useState("");

  const load = useCallback(() => {
    api.profiles().then(
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
      <h2>项目配置</h2>
      <p className="hint">
        把「用哪个 agent、哪台电脑、哪个目录、默认优先级、验收要看哪几项」存成一个名字。建任务或派活时选配置，空着的字段自动补齐（已填的不覆盖），检查项模板会自动成为验收检查项。
      </p>
      {list === null ? (
        <p className="hint">加载中…</p>
      ) : (
        <>
          {list.length === 0 && !adding && <p className="hint">还没有配置。建一条之后，派活就不用每次填三格了。</p>}
          {list.map((p) => {
            const form = forms[String(p.id)] ?? toForm(p);
            const dirty = JSON.stringify(form) !== JSON.stringify(toForm(p));
            return (
              <div key={p.id} className="profile-card">
                <div className="profile-head">
                  <strong>{p.name}</strong>
                  <span className="dim">{p.tasks} 个任务{p.checklist.length ? ` · ${p.checklist.length} 条检查项` : ""}</span>
                </div>
                <Fields form={form} busy={busy} onChange={(patch) => setForms((m) => ({ ...m, [String(p.id)]: { ...(m[String(p.id)] ?? toForm(p)), ...patch } }))} />
                <div className="btns">
                  <button className="primary" disabled={busy || !dirty} onClick={() => void run(() => api.updateProfile(p.id, toInput(form)), "配置已保存")}>保存</button>
                  <button className="ghost" disabled={busy} onClick={() => void run(() => api.deleteProfile(p.id), "配置已删除")}>删除</button>
                </div>
              </div>
            );
          })}
          {adding ? (
            <div className="profile-card">
              <div className="profile-head"><strong>新建配置</strong></div>
              <Fields form={draft} busy={busy} onChange={(patch) => setDraft((f) => ({ ...f, ...patch }))} />
              <div className="btns">
                <button className="primary" disabled={busy || !draft.name.trim()} onClick={() => void run(async () => { await api.createProfile(toInput(draft) as ProfileInput & { name: string }); setDraft(BLANK); setAdding(false); }, "配置已创建")}>创建</button>
                <button className="ghost" onClick={() => { setAdding(false); setDraft(BLANK); }}>取消</button>
              </div>
            </div>
          ) : (
            <button className="ghost" onClick={() => setAdding(true)}>＋ 新建配置</button>
          )}
        </>
      )}
      {err && <p className="form-error" role="alert">{err}</p>}
      {msg && <p className="msg">{msg}</p>}
    </section>
  );
}
