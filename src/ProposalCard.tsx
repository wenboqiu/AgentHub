import { useEffect, useLayoutEffect, useRef, useState, type TextareaHTMLAttributes } from "react";
import BoundsEditor from "./BoundsEditor";
import type { Api, Delivery, Project, Proposal, ProposalInput, Role, Task, TaskConstraints } from "./lib/api";
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

type Form = { title: string; notes: string; checklist: string; priority: Task["priority"]; roleId: string; projectId: string; delivery: Delivery; constraints: TaskConstraints };

// 随内容长高的输入框：任务单的标题、清单、说明经常很长，固定行数会把后半截藏起来。
// single=true 当单行用（标题）：回车不换行，粘进来的换行折成空格，但长了照样折行显示全文。
function AutoText({ value, onChange, single, minRows = 1, ...rest }: {
  value: string; onChange(v: string): void; single?: boolean; minRows?: number;
} & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "rows">) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fit = () => {
    const el = ref.current;
    // 收在 <details> 里没展开时量不到高度，等展开（onToggle）再量
    if (!el || !el.offsetParent) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  };
  useLayoutEffect(fit, [value]);
  useEffect(() => {
    const details = ref.current?.closest("details");
    window.addEventListener("resize", fit);
    details?.addEventListener("toggle", fit);
    return () => { window.removeEventListener("resize", fit); details?.removeEventListener("toggle", fit); };
  }, []);
  return (
    <textarea ref={ref} rows={minRows} value={value} className={single ? "auto-text single" : "auto-text"} {...rest}
      onKeyDown={single ? e => { if (e.key === "Enter") e.preventDefault(); } : undefined}
      onChange={e => onChange(single ? e.target.value.replace(/\s*\n\s*/g, " ") : e.target.value)} />
  );
}

const toForm = (p: Proposal): Form => ({
  title: p.title,
  notes: p.notes,
  checklist: p.checklist.join("\n"),
  priority: p.priority,
  roleId: p.assignee.roleId === null ? "" : String(p.assignee.roleId),
  projectId: p.projectId === null ? "" : String(p.projectId),
  delivery: p.delivery,
  constraints: p.constraints,
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
  // 「谁来做」的详细配置默认收起，只露一行摘要；菜单同理
  const [whoOpen, setWhoOpen] = useState(false), [menuOpen, setMenuOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
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
  if (proposal.status === "accepted") return <p className="proposal-verdict">已确认，任务{proposal.taskId !== null && <span className="task-no"> #{proposal.taskId}</span>}「{proposal.title}」已生成，在任务页继续。</p>;

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
    const hasDetail = !!proposal.notes || proposal.checklist.length > 0 || proposal.evidence.length > 0 || !!proposal.note;
    const who = proposal.assignee.roleName
      ? `${proposal.assignee.roleName}${agent ? ` · ${AGENT_LABEL[agent] ?? agent}` : ""}`
      : "执行人待定";
    return (
      <div className="proposal-card proposal-suggest">
        <div className="proposal-suggest-main">
          <span className={`proposal-kind ${proposal.kind}`}>{KIND_LABEL[proposal.kind]}</span>
          <strong className="proposal-suggest-title">{proposal.taskId !== null && <span className="task-no">#{proposal.taskId} </span>}{proposal.title}</strong>
          <span className="dim proposal-suggest-who">{who}</span>
        </div>
        <div className="btns">
          {hasDetail && (
            <button className="ghost" aria-expanded={detailOpen} onClick={() => setDetailOpen(v => !v)}>
              {detailOpen ? "收起" : "看详情"}
            </button>
          )}
          <button className="primary" disabled={busy || drafting} onClick={() => void makeDraft()}>
            {drafting ? "正在生成…" : "生成任务单"}
          </button>
          <button className="ghost" disabled={busy || drafting} onClick={() => void discard()}>不用了</button>
        </div>
        {/* 一行标题常常不够下判断（尤其兜底稿的标题只是占位），详情就地展开，不必先生成任务单 */}
        {detailOpen && (
          <div className="proposal-suggest-detail">
            {proposal.notes && <div className="proposal-suggest-notes">{proposal.notes}</div>}
            {proposal.checklist.length > 0 && (
              <ul>{proposal.checklist.map((c, i) => <li key={i}>{c}</li>)}</ul>
            )}
            {proposal.evidence.length > 0 && (
              <ul className="dim">
                {proposal.evidence.slice(0, 8).map((e, i) => <li key={i}>{e.label}：{e.value.slice(0, 160)}</li>)}
              </ul>
            )}
            {proposal.note && <p className="hint">{proposal.note}</p>}
          </div>
        )}
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
    constraints: form.constraints,
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

  const roleName = role?.name ?? (sameRole ? proposal.assignee.roleName : "");
  const whoDim = [agent ? AGENT_LABEL[agent] ?? agent : "工具未定", machine || "电脑待定", cwd || "目录待定", ...(isTicket ? [] : [plan.mode === "fork" ? "接着原会话" : "从零开始"])].join(" · ");
  const origin = writing ? "项目经理正在重写…" : proposal.origin === "agent" ? "✓ 项目经理已重写" : isTicket ? "待确认" : "按会话展开的草稿";

  return (
    <div className="proposal-card">
      <div className="proposal-head">
        <span className={`proposal-kind ${proposal.kind}`}>{KIND_LABEL[proposal.kind]}</span>
        <span className="dim">
          {isTicket
            ? "来自你发的单"
            : `来自「${proposal.sessionTitle || "未命名会话"}」（${AGENT_LABEL[proposal.sessionAgent] ?? proposal.sessionAgent}）`}
        </span>
        <span className="dim proposal-origin">{origin}</span>
      </div>

      <label className="proposal-what">要做什么
        <AutoText single value={form.title} maxLength={200} disabled={busy}
          onChange={v => set({ title: v })} />
      </label>

      <div className="who-line">
        <span className="who-label">谁来做</span>
        <span className="who-sum">
          <strong>{roleName || "执行人未定"}</strong>
          <span className="dim"> {whoDim}</span>
          {!isTicket && plan.blocked && <span className="who-warn"> 续不上：{plan.reason}</span>}
        </span>
        <button type="button" className="link" aria-expanded={whoOpen} onClick={() => setWhoOpen(v => !v)}>{whoOpen ? "收起" : "改"}</button>
      </div>
      {whoOpen && (
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
        </div>
      )}
      {/* 目录只能来自项目登记的配置：项目一条都没有，这一单确认了也派不出去，先在这儿说清 */}
      {project && !project.dirs.length && (
        <p className="hint">项目「{project.name}」还没登记目录：这样确认会派不出去，先去「设置 → 项目 → 编辑」加一条（电脑 + 目录）。</p>
      )}

      <label>怎么算完（一行一条，每条会变成验收检查项）
        <AutoText value={form.checklist} minRows={3} maxLength={2000} disabled={busy} placeholder="留空就不带检查项"
          onChange={v => set({ checklist: v })} />
      </label>

      <details className="proposal-more">
        <summary>{`更多：说明 · 优先级 · 执行边界${proposal.evidence.length ? ` · 证据 ${proposal.evidence.length} 条` : ""}`}</summary>
        <label>背景与验证方式
          <AutoText value={form.notes} minRows={4} maxLength={4000} disabled={busy}
            onChange={v => set({ notes: v })} />
        </label>
        <label>优先级
          <select value={form.priority} disabled={busy} onChange={e => set({ priority: e.target.value as Task["priority"] })}>
            {(["high", "medium", "low"] as const).map(k => <option key={k} value={k}>{PRIORITY_LABEL[k]}</option>)}
          </select>
        </label>
        <div className="proposal-bounds-edit">
          <span className="dim">执行边界 · 一般不用改，确认后冻结</span>
          <BoundsEditor value={form.constraints} disabled={busy} onChange={c => set({ constraints: c })} />
        </div>
        {proposal.evidence.length > 0 && (
          <div className="proposal-evidence">
            <span className="dim">会话里留下的证据（{proposal.evidence.length}）</span>
            <ul>
              {proposal.evidence.slice(0, 8).map((e, i) => (
                <li key={i}><span className="dim">{e.label}：</span>{e.value.slice(0, 160)}</li>
              ))}
            </ul>
          </div>
        )}
        {proposal.note && <p className="hint">{proposal.note}</p>}
      </details>

      <div className="btns proposal-btns">
        <button className="primary" disabled={busy || !form.title.trim()} onClick={() => void confirm(true)}>
          确认并派发
        </button>
        <button disabled={busy || !form.title.trim()} onClick={() => void confirm(false)}
          title={autoDispatch ? "建好任务，项目经理会按限额替你派出去" : "建好任务，之后自己派"}>
          先存为待办
        </button>
        <span className="spacer" />
        <div className="head-menu">
          <button className="icon-button" aria-label="更多操作" title="更多操作" disabled={busy} onClick={() => setMenuOpen(v => !v)}>···</button>
          {menuOpen && <>
            <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
            <div className="menu-pop" role="menu">
              <button className="ghost" disabled={busy || refining}
                onClick={() => { setMenuOpen(false); void act(async () => {
                  setRefining(true);
                  try { await api.refineProposal(proposal.id); }
                  catch (e) { setRefining(false); throw e; }
                }); }}>
                {refining ? "项目经理正在重写…" : "让项目经理重写"}
              </button>
              <button className="ghost" disabled={busy} onClick={() => { setMenuOpen(false); void discard(); }}>忽略</button>
            </div>
          </>}
        </div>
      </div>
    </div>
  );
}
