import { useEffect, useState } from "react";
import type { Api, Profile, Project, Proposal, ProposalInput, Role, Task } from "./lib/api";
import { constraintsSummary } from "./lib/api";
import { AGENT_LABEL } from "./lib/agents";

// 任务单卡：会话跑完后，项目经理先替人把「接下来做什么、谁来做、在哪做」排好，
// 人只需要看一眼、改不改都行，点「确认并派发」它就真的开工。
//
// 和执行意见的区别只是多了「执行人」这一层——意见说的是该做什么，任务单说的是这件事归谁。
// 所以卡片上能改的字段和任务详情页一致：标题、说明、验收要点、优先级、执行人、项目。
//
// 「让项目经理重写」只在需要时点：规则档是零成本的拼装，重写才花一次模型调用。

const KIND_LABEL: Record<Proposal["kind"], string> = {
  continue: "接着做",
  followup: "下一步",
  fix: "先修问题",
};

const PRIORITY_LABEL: Record<Task["priority"], string> = { high: "高", medium: "中", low: "低" };

type Form = { title: string; notes: string; checklist: string; priority: Task["priority"]; roleId: string; projectId: string };

const toForm = (p: Proposal): Form => ({
  title: p.title,
  notes: p.notes,
  checklist: p.checklist.join("\n"),
  priority: p.priority,
  roleId: p.assignee.roleId === null ? "" : String(p.assignee.roleId),
  projectId: p.projectId === null ? "" : String(p.projectId),
});

export default function ProposalCard({
  api,
  proposal,
  roles,
  projects,
  autoDispatch,
  busy,
  onBusy,
  onError,
  onChanged,
  onTask,
}: {
  api: Api;
  proposal: Proposal;
  roles: Role[];
  projects: Project[];
  /** 项目经理开了自动派发：只建任务的话它随后会接手 */
  autoDispatch: boolean;
  busy: boolean;
  onBusy(v: boolean): void;
  onError(msg: string): void;
  onChanged(p: Proposal): void;
  onTask(t: Task): void;
}) {
  const [form, setForm] = useState<Form>(() => toForm(proposal));
  const [done, setDone] = useState<null | { kind: "created"; text: string } | { kind: "discarded" }>(null);
  const [refining, setRefining] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const set = (patch: Partial<Form>) => setForm(f => ({ ...f, ...patch }));

  // 配置用来把「执行人」落到具体哪台电脑、哪个目录；卡片里自己拉一次，不往上层传
  useEffect(() => {
    let gone = false;
    api.profiles().then(v => { if (!gone) setProfiles(v); }).catch(() => {});
    return () => { gone = true; };
  }, [api]);

  // 重写结果从 WS 推回来（origin 变 agent）：把「正在看」收掉，表单换成新的
  useEffect(() => {
    setForm(toForm(proposal));
    setRefining(false);
  }, [proposal.id, proposal.updatedAt]);

  if (done?.kind === "created") return <p className="proposal-verdict">{done.text}</p>;
  if (done?.kind === "discarded" || proposal.status === "discarded") return <p className="proposal-verdict dim">这条建议不用了。</p>;
  if (proposal.status === "accepted") return <p className="proposal-verdict">已确认，任务「{proposal.title}」已生成，在任务页继续。</p>;

  const act = async (fn: () => Promise<void>) => {
    onBusy(true); onError("");
    try { await fn(); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { onBusy(false); }
  };

  const role = roles.find(r => String(r.id) === form.roleId);
  const project = projects.find(p => String(p.id) === form.projectId);
  // 换了执行人之后，原来那套机器/目录就不再适用，不能再沿用服务端算好的值
  const sameRole = String(proposal.assignee.roleId ?? "") === form.roleId;
  // 执行人的「地方」：角色的默认配置 > 项目的兜底配置 > 服务端已经算好的那套
  const pid = role?.profileId ?? project?.profileId ?? (sameRole ? proposal.assignee.profileId : null);
  const profile = profiles.find(p => p.id === pid);
  const agent = role?.agent || profile?.agent || (sameRole ? proposal.assignee.agent : "");
  const machine = profile?.machine ?? (sameRole ? proposal.assignee.machine : "");
  const cwd = profile?.cwd ?? (sameRole ? proposal.assignee.cwd : "");

  const fields = (): ProposalInput => ({
    title: form.title.trim(),
    notes: form.notes,
    checklist: form.checklist.split("\n").map(s => s.trim()).filter(Boolean),
    priority: form.priority,
    roleId: form.roleId ? Number(form.roleId) : null,
    projectId: form.projectId ? Number(form.projectId) : null,
  });

  const confirm = (dispatch: boolean) => act(async () => {
    const res = await api.confirmProposal(proposal.id, { ...fields(), dispatch });
    onChanged(res.proposal);
    onTask(res.task);
    const how = res.dispatched ? (res.dispatched.queued ? "已排队，等那台电脑上线就开跑" : "已派发，正在做")
      : autoDispatch ? "已建任务，项目经理会接手派发" : "已建任务，还没派发";
    setDone({ kind: "created", text: `已生成任务「${res.task.title}」，${how}。` });
    if (res.dispatchError) onError(`任务已建好，但派发没成功：${res.dispatchError}`);
  });

  return (
    <div className="proposal-card">
      <div className="proposal-head">
        <span className={`proposal-kind ${proposal.kind}`}>{KIND_LABEL[proposal.kind]}</span>
        <strong>任务单</strong>
        <span className="dim">
          来自「{proposal.sessionTitle || "未命名会话"}」（{AGENT_LABEL[proposal.sessionAgent] ?? proposal.sessionAgent}）
        </span>
        <span className="dim proposal-origin">{proposal.origin === "agent" ? "项目经理整理" : "按会话自动排出"}</span>
      </div>

      <div className="proposal-assignee">
        <div className="form-grid">
          <label>执行人
            <select value={form.roleId} disabled={busy} onChange={e => set({ roleId: e.target.value })}>
              <option value="">不指定角色</option>
              {roles.map(r => <option key={r.id} value={r.id}>{r.name}{r.title ? ` · ${r.title}` : ""}</option>)}
            </select>
          </label>
          <label>项目
            <select value={form.projectId} disabled={busy} onChange={e => set({ projectId: e.target.value })}>
              <option value="">不归属项目</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        </div>
        <p className="dim proposal-place">
          {[agent ? AGENT_LABEL[agent] ?? agent : "执行工具未定", machine || "电脑待定", cwd || "目录待定"].join(" · ")}
          {profile ? `（配置：${profile.name}）` : ""}
        </p>
      </div>

      <label>要做什么
        <input value={form.title} maxLength={200} disabled={busy}
          onChange={e => set({ title: e.target.value })} />
      </label>
      <label>背景与验证方式
        <textarea value={form.notes} rows={4} maxLength={4000} disabled={busy}
          onChange={e => set({ notes: e.target.value })} />
      </label>
      <label>验收要点（一行一条）
        <textarea value={form.checklist} rows={3} maxLength={2000} disabled={busy} placeholder="留空就不带检查项"
          onChange={e => set({ checklist: e.target.value })} />
      </label>
      <div className="form-grid">
        <label>优先级
          <select value={form.priority} disabled={busy} onChange={e => set({ priority: e.target.value as Task["priority"] })}>
            {(["high", "medium", "low"] as const).map(k => <option key={k} value={k}>{PRIORITY_LABEL[k]}</option>)}
          </select>
        </label>
      </div>

      {/* 项目经理排任务单时一并定了「能碰哪」：建任务后就是代批的依据 */}
      {constraintsSummary(proposal.constraints).length > 0 && (
        <p className="proposal-bounds">
          <span className="dim">执行边界</span>
          {constraintsSummary(proposal.constraints).map(c => <span key={c} className="bound-chip">{c}</span>)}
        </p>
      )}

      {proposal.evidence.length > 0 && (
        <details className="proposal-evidence">
          <summary className="dim">会话里留下的证据（{proposal.evidence.length}）</summary>
          <ul>
            {proposal.evidence.slice(0, 8).map((e, i) => (
              <li key={i}><span className="dim">{e.label}：</span>{e.value.slice(0, 160)}</li>
            ))}
          </ul>
        </details>
      )}
      {proposal.note && <p className="hint">{proposal.note}</p>}

      <div className="btns">
        <button className="primary" disabled={busy || !form.title.trim()} onClick={() => void confirm(true)}>
          确认并派发
        </button>
        <button disabled={busy || !form.title.trim()} onClick={() => void confirm(false)}>
          只建任务
        </button>
        <button className="ghost" disabled={busy || refining}
          onClick={() => void act(async () => {
            setRefining(true);
            try { await api.refineProposal(proposal.id); }
            catch (e) { setRefining(false); throw e; }
          })}>
          {refining ? "项目经理正在重写…" : "让项目经理重写"}
        </button>
        <button className="ghost" disabled={busy}
          onClick={() => void act(async () => { await api.discardProposal(proposal.id); setDone({ kind: "discarded" }); })}>
          忽略
        </button>
      </div>
      {autoDispatch && <p className="hint">项目经理已开自动派发：点「只建任务」，它会按并发和每小时上限替你派出去。</p>}
    </div>
  );
}
