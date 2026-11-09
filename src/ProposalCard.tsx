import { useEffect, useState } from "react";
import type { Api, Delivery, Project, Proposal, ProposalInput, Role, Task } from "./lib/api";
import { constraintsSummary } from "./lib/api";
import { AGENT_LABEL } from "./lib/agents";
import { planDelivery } from "./lib/delivery";

// 任务单卡，两段式：
//   ① 建议（stage=suggest）：会话跑完只给一行——类型 + 标题 + 执行人，两个按钮「生成任务单 / 不用了」。
//      这一步不花模型，人也不必读完整张单就能决定「这件事要不要做」。
//   ② 任务单（stage=draft）：点了「生成任务单」才展开全文（说明 / 验收 / 边界 / 从哪开始），
//      同时项目经理会用模型重写一遍；人改不改都行，点「确认并派发」它就真的开工。
//
// 和执行意见的区别只是多了「执行人」这一层——意见说的是该做什么，任务单说的是这件事归谁。
// 所以任务单上能改的字段和任务详情页一致：标题、说明、验收要点、优先级、执行人、项目。

const KIND_LABEL: Record<Proposal["kind"], string> = {
  continue: "接着做",
  followup: "下一步",
  fix: "先修问题",
  ticket: "发单",
};

const PRIORITY_LABEL: Record<Task["priority"], string> = { high: "高", medium: "中", low: "低" };

type Form = { title: string; notes: string; checklist: string; priority: Task["priority"]; roleId: string; projectId: string; delivery: Delivery };

const toForm = (p: Proposal): Form => ({
  title: p.title,
  notes: p.notes,
  checklist: p.checklist.join("\n"),
  priority: p.priority,
  roleId: p.assignee.roleId === null ? "" : String(p.assignee.roleId),
  projectId: p.projectId === null ? "" : String(p.projectId),
  delivery: p.delivery,
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
  // 建议阶段点「生成任务单」到服务端回来之间：按钮锁住，别让人连点两次
  const [drafting, setDrafting] = useState(false);
  const set = (patch: Partial<Form>) => setForm(f => ({ ...f, ...patch }));
  // 发单没有原会话：不显示「从哪开始」，也不自称来自某个会话
  const isTicket = proposal.kind === "ticket";
  // 项目经理正拿着模型读这张单（细化结果回来时 origin 会变 agent，这行提示自然消失）
  // 建议阶段还没有细化这回事：那时只有一行摘要，谈不上「正在写」
  const writing = proposal.stage === "draft" && proposal.origin === "heuristic" && !!proposal.refineRunId;

  // 重写结果从 WS 推回来（origin 变 agent）：把「正在看」收掉，表单换成新的
  useEffect(() => {
    setForm(toForm(proposal));
    setRefining(false);
  }, [proposal.id, proposal.updatedAt]);

  // 撤回忽略：忽略掉的卡片只留在详情页里（对话流底部的入口会随最后一张单被忽略而消失），
  // 所以「撤回」得放在这张卡上，不然点错了就没地方找回来
  const unignore = async () => {
    onBusy(true); onError("");
    try {
      const res = await api.restoreProposal(proposal.id);
      onChanged(res.proposal);
      setDone(null);
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { onBusy(false); }
  };

  if (done?.kind === "created") return <p className="proposal-verdict">{done.text}</p>;
  if (done?.kind === "discarded" || proposal.status === "discarded") return (
    <p className="proposal-verdict dim">
      这条建议不用了。
      <button className="link proposal-undo" disabled={busy} onClick={() => void unignore()}>撤回</button>
    </p>
  );
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
  // 执行人的「地方」：项目的目录列表（按电脑匹配的优先，其次不绑机器的）> 服务端已经算好的那套
  const dir = (project?.dirs ?? []).find(d => d.machine) ?? (project?.dirs ?? [])[0] ?? null;
  const agent = role?.agent || (sameRole ? proposal.assignee.agent : "");
  const machine = dir?.machine ?? (sameRole ? proposal.assignee.machine : "");
  const cwd = dir?.cwd ?? (sameRole ? proposal.assignee.cwd : "");
  // 去向按「现在选的执行人」预览：换人 / 换机器之后能不能续，当场就能看出来
  const plan = planDelivery(form.delivery, proposal.fork, { agent, machine, cwd });

  // 忽略：只算「这条建议暂时不用」，记录还留在详情页，可以撤回
  const discard = () => act(async () => {
    const res = await api.discardProposal(proposal.id);
    onChanged(res.proposal);
    setDone({ kind: "discarded" });
  });

  // 建议 → 任务单：展开完整草稿，同时让项目经理用模型重写一遍。
  // 先出规则稿是为了「电脑不在线也能继续」，模型回来再替换成更好的版本。
  const makeDraft = () => act(async () => {
    setDrafting(true);
    try {
      const res = await api.draftProposal(proposal.id);
      onChanged(res.proposal);
      if (res.refineError) onError(`任务单已展开，但项目经理没能重写：${res.refineError}`);
    } finally { setDrafting(false); }
  });

  // ---- 建议阶段：只给一行 ----
  // 会话跑完先让人看「做什么 · 谁来做」，不用对着整张表单做阅读理解。
  // 点「生成任务单」才展开全文——这一步才是「确认要做这件事」。
  if (proposal.stage === "suggest") {
    const who = proposal.assignee.roleName
      ? `${proposal.assignee.roleName}${agent ? ` · ${AGENT_LABEL[agent] ?? agent}` : ""}`
      : "执行人待定";
    return (
      <div className="proposal-card proposal-suggest">
        <div className="proposal-suggest-main">
          <span className={`proposal-kind ${proposal.kind}`}>{KIND_LABEL[proposal.kind]}</span>
          <strong className="proposal-suggest-title">{proposal.title}</strong>
          <span className="dim proposal-suggest-who">{who}</span>
        </div>
        <div className="btns">
          <button className="primary" disabled={busy || drafting} onClick={() => void makeDraft()}>
            {drafting ? "正在生成…" : "生成任务单"}
          </button>
          <button className="ghost" disabled={busy || drafting} onClick={() => void discard()}>不用了</button>
        </div>
      </div>
    );
  }

  const fields = (): ProposalInput => ({
    title: form.title.trim(),
    notes: form.notes,
    checklist: form.checklist.split("\n").map(s => s.trim()).filter(Boolean),
    priority: form.priority,
    roleId: form.roleId ? Number(form.roleId) : null,
    projectId: form.projectId ? Number(form.projectId) : null,
  });

  const confirm = (dispatch: boolean) => act(async () => {
    const res = await api.confirmProposal(proposal.id, { ...fields(), dispatch, delivery: form.delivery });
    onChanged(res.proposal);
    onTask(res.task);
    // 服务端按最终的工具/电脑/目录再判一次，这里报的是它实际用的方式
    const d = res.dispatched?.delivery;
    const how = res.dispatched ? (res.dispatched.queued ? "已排队，等那台电脑上线就开跑" : "已派发，正在做")
      : autoDispatch ? "已建任务，项目经理会接手派发" : "已建任务，还没派发";
    setDone({ kind: "created", text: `已生成任务「${res.task.title}」，${how}${d ? `（${d.reason}）` : ""}。` });
    if (res.dispatchError) onError(`任务已建好，但派发没成功：${res.dispatchError}`);
  });

  return (
    <div className="proposal-card">
      <div className="proposal-head">
        <span className={`proposal-kind ${proposal.kind}`}>{KIND_LABEL[proposal.kind]}</span>
        <strong>任务单</strong>
        <span className="dim">
          {isTicket
            ? "来自你发的单"
            : `来自「${proposal.sessionTitle || "未命名会话"}」（${AGENT_LABEL[proposal.sessionAgent] ?? proposal.sessionAgent}）`}
        </span>
        <span className="dim proposal-origin">
          {proposal.origin === "agent" ? "项目经理整理" : isTicket ? "待确认" : "按会话展开的草稿"}
        </span>
      </div>

      {writing && <p className="hint">项目经理正在读这张单，写好后会自动替换下面的内容…</p>}

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
        </p>
      </div>

      {/* 从哪开始：接着原会话的上下文，还是新开一个。换了工具 / 电脑 / 目录就续不上，选项直接灰掉。
          发单没有原会话可续，这块整段不出现。 */}
      {!isTicket && (
        <div className="delivery-pick">
          <span className="delivery-label">从哪开始</span>
          <div className="delivery-opts" role="radiogroup" aria-label="从哪开始">
            <button type="button" role="radio" aria-checked={plan.mode === "fork"}
              className={plan.mode === "fork" ? "delivery-opt on" : "delivery-opt"}
              disabled={busy || plan.blocked} title={plan.blocked ? plan.reason : "把原会话的上下文接过来"}
              onClick={() => set({ delivery: "fork" })}>接着原会话</button>
            <button type="button" role="radio" aria-checked={plan.mode === "fresh"}
              className={plan.mode === "fresh" ? "delivery-opt on" : "delivery-opt"}
              disabled={busy} title="新开一个会话，只带任务单里的说明"
              onClick={() => set({ delivery: "fresh" })}>从零开始</button>
          </div>
          <p className="hint delivery-note">{plan.blocked ? `续不上：${plan.reason}` : plan.reason}</p>
        </div>
      )}

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

      {/* 确认 = 签署授权：范围从这一刻起冻结。没声明的能力（联网 / 推远端 / 跑脚本）就是不授权 */}
      <>
        <p className="proposal-bounds">
          <span className="dim">本次授权范围</span>
          {constraintsSummary(proposal.constraints).length > 0
            ? constraintsSummary(proposal.constraints).map(c => <span key={c} className="bound-chip">{c}</span>)
            : <span className="bound-chip">不限目录 · 不联网 · 不推远端 · 不跑脚本</span>}
        </p>
        <p className="hint">点确认即签署：范围一经确认不可撤销、不可再改，要改只能新开任务。目录声明只是提示，不是安全隔离。</p>
      </>

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
        <button className="ghost" disabled={busy} onClick={() => void discard()}>
          忽略
        </button>
      </div>
      {autoDispatch && <p className="hint">项目经理已开自动派发：点「只建任务」，它会按并发和每小时上限替你派出去。</p>}
    </div>
  );
}
