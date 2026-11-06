import { useState } from "react";
import type { Api, Project, Proposal, Role } from "./lib/api";

// 发新单：只让人填「只有人知道的那几格」，其余交给项目经理。
// 项目是必填的那一格——它决定在哪做、项目说明随单下发；配置（电脑 + 目录）、角色、正文
// 都可以留空：派发时项目经理按项目目录与在线机器挑地方、按角色清单挑人，正文空着它会补。
// 表单顺序刻意如此：先定项目，再谈这个项目在哪台机器哪个目录，然后才是派给谁。
//
// 提交出去的不是任务，是一张待确认的任务单：项目经理先用模型补成人话，出卡片给人过一眼，
// 人点了确认才建任务并派发。建了再改，等于让人对着半成品做验收。

type Form = { projectId: string; machine: string; cwd: string; roleId: string; title: string; body: string };
const BLANK: Form = { projectId: "", machine: "", cwd: "", roleId: "", title: "", body: "" };

const Label = ({ text, note }: { text: string; note: string }) => (
  <span className="field-label">{text}<span className="dim">{note}</span></span>
);

export default function DispatchForm({
  api, projects, roles, canRefine, autoDispatch, onCreated, onCancel, onNotice,
}: {
  api: Api;
  projects: Project[];
  roles: Role[];
  /** 配了项目经理角色：它能用模型把这单补成任务单；没配就只能用你的原话 */
  canRefine: boolean;
  /** 项目经理开了自动派发：确认时点「只建任务」它会接手 */
  autoDispatch: boolean;
  onCreated(proposal: Proposal): void;
  onCancel(): void;
  onNotice(msg: string): void;
}) {
  const [f, setF] = useState<Form>(BLANK);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (patch: Partial<Form>) => setF((v) => ({ ...v, ...patch }));

  const project = projects.find((p) => String(p.id) === f.projectId) ?? null;
  const dirs = project?.dirs ?? [];
  const machines = [...new Set(dirs.map((d) => d.machine).filter((m): m is string => !!m))];
  // 定了电脑就只给这台上的目录，免得把路径选串
  const cwds = (f.machine ? dirs.filter((d) => d.machine === f.machine) : dirs).map((d) => d.cwd);

  const submit = async () => {
    if (!f.projectId) return setErr("先选一个项目");
    if (!f.title.trim()) return setErr("工单至少要有一句话标题");
    setBusy(true);
    setErr("");
    try {
      const res = await api.createTicket({
        title: f.title.trim(),
        // 留空不等于没内容：项目经理会按项目说明和近况补一份能开工的说明
        notes: f.body.trim(),
        projectId: Number(f.projectId),
        ...(f.roleId ? { roleId: Number(f.roleId) } : {}),
        ...(f.machine.trim() ? { machine: f.machine.trim() } : {}),
        ...(f.cwd.trim() ? { cwd: f.cwd.trim() } : {}),
      });
      setF(BLANK);
      onNotice(res.refineError
        ? `工单已建好，但项目经理没能开写：${res.refineError}`
        : "已发单：项目经理正在补成任务单，写好后在这儿确认");
      onCreated(res.proposal);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="entity-form dispatch-form" aria-label="发新单">
      <label>
        <Label text="项目" note="在哪做。项目说明和近况会随单下发给执行端" />
        <select value={f.projectId} disabled={busy} onChange={(e) => set({ projectId: e.target.value, machine: "", cwd: "" })}>
          <option value="">{projects.length ? "选择项目…" : "还没有项目，先去设置里建一个"}</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>

      <div className="form-grid">
        <label>
          <Label text="项目配置 · 电脑" note="留空 = 项目经理挑一台在线机器" />
          <input value={f.machine} list="dispatch-machines" disabled={busy || !project} placeholder="留空自动挑" spellCheck={false} onChange={(e) => set({ machine: e.target.value })} />
          <datalist id="dispatch-machines">{machines.map((m) => <option key={m} value={m} />)}</datalist>
        </label>
        <label>
          <Label text="项目配置 · 目录" note="留空 = 按项目登记的目录和最终那台电脑挑" />
          <input value={f.cwd} list="dispatch-cwds" disabled={busy || !project} placeholder="留空自动挑" spellCheck={false} onChange={(e) => set({ cwd: e.target.value })} />
          <datalist id="dispatch-cwds">{cwds.map((c) => <option key={c} value={c} />)}</datalist>
        </label>
      </div>

      <label>
        <Label text="派给谁" note="选一个角色；留空 = 项目经理按角色清单挑" />
        <select value={f.roleId} disabled={busy} onChange={(e) => set({ roleId: e.target.value })}>
          <option value="">不指定（项目经理挑）</option>
          {roles.map((r) => <option key={r.id} value={r.id}>{r.name}{r.title ? ` · ${r.title}` : ""}</option>)}
        </select>
      </label>

      <label>
        <Label text="工单标题" note="一句话说清要做什么，任务列表就显示这句" />
        <input value={f.title} maxLength={200} disabled={busy} placeholder="例如：给 README 补安装说明" onChange={(e) => set({ title: e.target.value })} />
      </label>

      <label>
        <Label text="工单正文" note="可以留空：项目经理会按项目说明和近况补目标、背景与交付要求" />
        <textarea value={f.body} rows={6} maxLength={4000} disabled={busy} spellCheck={false} placeholder="留空也行。填的话：背景 / 约束 / 验收标准" onChange={(e) => set({ body: e.target.value })} />
      </label>

      <p className="hint">发单后项目经理会先把这单补成能开工的任务单，你过一眼，确认了才真的派出去。</p>
      {!canRefine && <p className="hint">还没配项目经理角色：没人能补写，卡片里就是你的原话；想让它补，去设置里挑一个角色。</p>}
      {!autoDispatch && <p className="hint">项目经理没开自动派发：确认时点「只建任务」不会自己出去，要派就在卡片上点「确认并派发」。</p>}
      {err && <p className="form-error" role="alert">{err}</p>}
      <div className="action-bar">
        <button className="primary" disabled={busy || !projects.length || !f.title.trim()} onClick={() => void submit()}>发单</button>
        <button className="ghost" disabled={busy} onClick={onCancel}>取消</button>
      </div>
    </section>
  );
}
