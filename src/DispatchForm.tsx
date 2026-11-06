import { useState } from "react";
import type { Api, Project, ProjectDir, Proposal, Role } from "./lib/api";

// 发新单：只让人填「只有人知道的那几格」，其余交给项目经理。
// 项目是必填的那一格——它决定在哪做、项目说明随单下发；项目配置（电脑 + 目录）、角色、正文
// 都可以留空：派发时项目经理按项目目录与在线机器挑地方、按角色清单挑人，正文空着它会补。
// 表单顺序刻意如此：先定项目，再谈这个项目在哪台机器哪个目录，然后才是派给谁。
//
// 「项目配置」直接列设置里给这个项目登记的目录，一条一项，选中就同时定下电脑和路径；
// 不选 = 交给项目经理挑。项目经理是发单的人，不会出现在「派给谁」里。
//
// 提交出去的不是任务，是一张待确认的任务单：项目经理先用模型补成人话，出卡片给人过一眼，
// 人点了确认才建任务并派发。建了再改，等于让人对着半成品做验收。

type Form = { projectId: string; profile: string; roleId: string; title: string; body: string };
const BLANK: Form = { projectId: "", profile: "", roleId: "", title: "", body: "" };

/** 一条配置的唯一标识：电脑可能为空（哪台都行），拼上目录才不重 */
const dirKey = (d: ProjectDir) => `${d.machine ?? ""}\u0000${d.cwd}`;

const Label = ({ text, note }: { text: string; note: string }) => (
  <span className="field-label">{text}<span className="dim">{note}</span></span>
);

/** 这一单会交给谁管：本项目专属经理 → 管所有项目的经理 → 只剩一位经理时由它兜底（与服务端同规则） */
function pickOwner(roles: Role[], projectId: number | null): Role | null {
  const managers = roles.filter((r) => r.manager).sort((a, b) => a.id - b.id);
  if (projectId !== null) {
    const own = managers.find((r) => r.managerProjects.includes(projectId));
    if (own) return own;
  }
  const all = managers.find((r) => r.managerProjects.length === 0);
  if (all) return all;
  return managers.length === 1 ? managers[0] : null;
}

export default function DispatchForm({
  api, projects, roles, autoDispatch, onCreated, onCancel, onNotice,
}: {
  api: Api;
  projects: Project[];
  roles: Role[];
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
  // 设置里给这个项目登记过的配置（电脑 + 目录），发单时直接挑一条
  const dirs = project?.dirs ?? [];
  const chosen = dirs.find((d) => dirKey(d) === f.profile) ?? null;
  // 项目经理是补单派活的人，不是被派活的人——「派给谁」里不出现
  const workers = roles.filter((r) => !r.manager);
  const hasManager = roles.some((r) => r.manager);
  // 选了项目才知道归谁管；没选项目时先按「有没有经理」判断能不能发
  const owner = pickOwner(roles, project?.id ?? null);
  const blocked = !hasManager ? "还没有项目经理：先去「设置 → 角色」把某个角色设为项目经理，否则这单没人补、没人派。" : "";

  const submit = async () => {
    if (!f.projectId) return setErr("先选一个项目");
    if (!f.title.trim()) return setErr("工单至少要有一句话标题");
    if (!hasManager) return setErr("还没有项目经理，先把某个角色设为项目经理");
    if (!owner) return setErr("这个项目还没有对应的项目经理：去角色里给它指定一位，或设一位管所有项目的");
    setBusy(true);
    setErr("");
    try {
      const res = await api.createTicket({
        title: f.title.trim(),
        // 留空不等于没内容：项目经理会按项目说明和近况补一份能开工的说明
        notes: f.body.trim(),
        projectId: Number(f.projectId),
        ...(f.roleId ? { roleId: Number(f.roleId) } : {}),
        ...(chosen?.machine ? { machine: chosen.machine } : {}),
        ...(chosen?.cwd ? { cwd: chosen.cwd } : {}),
      });
      setF(BLANK);
      onNotice(res.refineError
        ? `工单已建好，但项目经理没能开写：${res.refineError}`
        : `已发单：${owner.name}正在补成任务单，写好后在这儿确认`);
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
        <select value={f.projectId} disabled={busy} onChange={(e) => set({ projectId: e.target.value, profile: "" })}>
          <option value="">{projects.length ? "选择项目…" : "还没有项目，先去设置里建一个"}</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>

      <label>
        <Label text="项目配置" note="这个项目在设置里登记的电脑 + 目录；不选 = 项目经理按登记的目录和在线电脑挑" />
        <select value={f.profile} disabled={busy || !project || !dirs.length} onChange={(e) => set({ profile: e.target.value })}>
          <option value="">{dirs.length ? "不选（项目经理挑）" : "这个项目还没配过目录"}</option>
          {dirs.map((d) => (
            <option key={dirKey(d)} value={dirKey(d)}>
              {`${d.machine ?? "任意电脑"} · ${d.cwd}`}
            </option>
          ))}
        </select>
      </label>

      <label>
        <Label text="派给谁" note="选一个角色；不选 = 项目经理按角色清单挑" />
        <select value={f.roleId} disabled={busy} onChange={(e) => set({ roleId: e.target.value })}>
          <option value="">{workers.length ? "不指定（项目经理挑）" : "还没有可派的角色"}</option>
          {workers.map((r) => <option key={r.id} value={r.id}>{r.name}{r.title ? ` · ${r.title}` : ""}</option>)}
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
      {project && !dirs.length && <p className="hint">这个项目还没配过目录：去「设置 → 项目 → 编辑」加一条配置（电脑 + 目录）；不配也能发，地方由项目经理现挑。</p>}
      {blocked && <p className="hint">{blocked}</p>}
      {!blocked && !owner && <p className="hint">选中的项目还没有对应的项目经理：去「设置 → 角色」给它指定一位，或设一位管所有项目的。</p>}
      {!blocked && owner && <p className="hint">这单会交给 <strong>{owner.name}</strong>（{owner.managerProjects.length === 0 ? "管所有项目" : "管这个项目"}）补写；想换人在角色里改管辖范围。</p>}
      {!autoDispatch && <p className="hint">项目经理没开自动派发：确认时点「只建任务」不会自己出去，要派就在卡片上点「确认并派发」。</p>}
      {err && <p className="form-error" role="alert">{err}</p>}
      <div className="action-bar">
        <button className="primary" disabled={busy || !projects.length || !f.title.trim() || !!blocked || !owner} onClick={() => void submit()}>发单</button>
        <button className="ghost" disabled={busy} onClick={onCancel}>取消</button>
      </div>
    </section>
  );
}
