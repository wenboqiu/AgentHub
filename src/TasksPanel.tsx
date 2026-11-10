import { ScheduleSummary } from "./ScheduleFields";
import { useState, type ReactNode } from "react";
import type { Api, Approval, BoardEntry, Goal, Project, Proposal, Role, Session, Task } from "./lib/api";
import { PriorityBadge } from "./GoalPriority";
import { ENTITY_SORTERS, SortBar, type EntitySort } from "./lib/sort";
import Icon from "./Icon";
import DispatchForm from "./DispatchForm";
import ProposalCard from "./ProposalCard";
import { AGENT_LABEL, isDispatchable } from "./lib/agents";
import { parseQuestions } from "./lib/questions";
import { ago } from "./lib/time";
export const TASK_LABEL: Record<Task["status"], string> = { todo: "待办", doing: "进行中", review: "待验收", done: "已完成" };
export function QuickCreate({ placeholder, create, children }: {placeholder: string; create(title: string): Promise<unknown>; children?: ReactNode}) {
  const [title,setTitle] = useState(""), [error,setError] = useState(""), [busy,setBusy] = useState(false);
  return <form className="quick-create" onSubmit={async e => { e.preventDefault(); if (!title.trim() || busy) return; setBusy(true); setError(""); try { await create(title.trim()); setTitle(""); } catch(e) {setError(e instanceof Error ? e.message : String(e));} finally {setBusy(false);} }}>
    <label className="sr-only" htmlFor={`quick-${placeholder}`}>{placeholder}</label><input id={`quick-${placeholder}`} placeholder={placeholder} maxLength={200} value={title} onChange={e=>setTitle(e.target.value)} disabled={busy}/>{children}<button className="primary" disabled={busy || !title.trim()}><Icon name="plus"/>{busy ? "创建中…" : "新建"}</button>{error && <p className="form-error" role="alert">{error}</p>}
  </form>;
}
export function TaskRows({tasks,goals,onOpen}: {tasks: Task[]; goals: Goal[]; onOpen(id:number): void}) {
  return <ul className="list">{tasks.map(t=><li key={t.id}><button className="entity-row" onClick={()=>onOpen(t.id)}><span className="entity-main"><span className="entity-title"><span className="task-no">#{t.id}</span><strong>{t.title}</strong><PriorityBadge priority={t.priority}/></span><span className="dim">{goals.find(g=>g.id===t.goalId)?.title ?? "无目标"}{t.sessionIds.length > 0 ? ` · ${t.sessionIds.length} 个会话` : ""}{t.agent ? ` · ${AGENT_LABEL[t.agent] ?? t.agent}` : ""}</span><ScheduleSummary value={t}/>{t.checklist?.length > 0 && <span className="dim">Checklist {t.checklist.filter(i=>i.done).length}/{t.checklist.length}</span>}</span>{t.timerStartedAt && <span className="timer-badge">计时中</span>}<span className={`task-status ${t.status}`}>{TASK_LABEL[t.status]}</span></button></li>)}</ul>;
}

// 任务页 = 收件箱（等你处理）+ 在跑 + 待办 + 已完成。原来的「看板」并进来：
// 需要人点头的事（授权 / 验收 / 卡住 / 任务单）都在页首一行一件，行内就能处理。

const stop = (fn: () => void) => (e: { stopPropagation(): void }) => { e.stopPropagation(); fn(); };
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const TODO_LIMIT = 8;
const PRIO_LABEL = { high: "高", medium: "中", low: "低" } as const;

type Act = "issue" | "todo" | "unqueue";

export default function TasksPanel({
  api, board, now, projects, roles, proposals, approvals, sessions, autoDispatch, onRefresh, onNotice, onProposal, onSaved, onOpenSession,
  tasks, goals, onOpen, onCreate,
}: {
  api: Api;
  board: { entries: BoardEntry[]; agents: string[] } | null;
  now: number;
  projects: Project[];
  roles: Role[];
  proposals: Proposal[];
  approvals: Approval[];
  sessions: Session[];
  autoDispatch: boolean;
  onRefresh(): void;
  onNotice(msg: string): void;
  onProposal(p: Proposal): void;
  onSaved(t: Task): void;
  onOpenSession(id: string): void;
  tasks: Task[];
  goals: Goal[];
  onOpen(id: number): void;
  onCreate(title: string): Promise<unknown>;
}) {
  const [sort, setSort] = useState<EntitySort>("updated");
  const [projectId, setProjectId] = useState(""), [roleId, setRoleId] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [busyId, setBusyId] = useState<string>("");
  const [busyProposal, setBusyProposal] = useState(0);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showAllTodo, setShowAllTodo] = useState(false);
  /** 刚忽略掉的单：先留着（变成「不用了 · 撤回」），点错了能撤回；重新进页面只列待确认的 */
  const [justIgnored, setJustIgnored] = useState<number[]>([]);

  const taskById = new Map(tasks.map(t => [t.id, t]));
  const passes = (t: Task | undefined) => {
    if (!projectId && !roleId) return true;
    if (!t) return false;
    return (!projectId || String(t.projectId ?? "") === projectId) && (!roleId || String(t.roleId ?? "") === roleId);
  };
  const entries = board?.entries ?? [];
  const entryIds = new Set(entries.map(e => e.taskId));

  // ---- 收件箱 ----
  const pendingApprovals = approvals.filter(a => a.status === "pending");
  const reviewTasks = tasks.filter(t => t.status === "review" && passes(t));
  const stuckEntries = entries.filter(e => e.stuck && passes(taskById.get(e.taskId)));
  const inboxProposals = proposals.filter(p => p.status === "pending" || justIgnored.includes(p.id));
  const waitingProposals = inboxProposals.filter(p => p.status === "pending").length;
  const inboxCount = pendingApprovals.length + reviewTasks.length + stuckEntries.length + waitingProposals;

  // ---- 在跑 / 待办 / 已完成 ----
  const liveEntries = entries.filter(e => !e.stuck && e.status !== "review" && passes(taskById.get(e.taskId)));
  const doingNoEntry = tasks.filter(t => t.status === "doing" && !entryIds.has(t.id) && passes(t));
  const liveTotal = liveEntries.length + doingNoEntry.length;
  const runningN = liveEntries.filter(e => !e.queued).length + doingNoEntry.length;
  const queuedN = liveEntries.filter(e => e.queued).length;
  const todoList = tasks.filter(t => t.status === "todo" && !entryIds.has(t.id) && passes(t)).sort(ENTITY_SORTERS[sort]);
  const doneList = tasks.filter(t => t.status === "done" && passes(t)).sort(ENTITY_SORTERS[sort]);
  const parts = [
    inboxCount > 0 ? `${inboxCount} 件等你处理` : "",
    runningN > 0 ? `${runningN} 个在跑` : "",
    queuedN > 0 ? `${queuedN} 个排队` : "",
    todoList.length > 0 ? `${todoList.length} 个待办` : "",
  ].filter(Boolean);

  const created = (p: Proposal) => { setShowForm(false); onProposal(p); onRefresh(); };
  const fail = (e: unknown) => onNotice(e instanceof Error ? e.message : String(e));

  const act = async (id: number, kind: Act) => {
    setBusyId(`t${id}`);
    const done = { issue: "已重新派发", todo: "已退回待办", unqueue: "已取消排队" }[kind];
    try {
      if (kind === "issue") await api.startTask(id, {});
      else if (kind === "todo") await api.updateTask(id, { status: "todo" });
      else await api.unqueueTask(id);
      onNotice(done);
      onRefresh();
    } catch (e) { fail(e); } finally { setBusyId(""); }
  };
  const decide = async (a: Approval, d: "allow" | "deny") => {
    setBusyId(`a${a.id}`);
    try { await api.decide(a.id, d); } catch (e) { fail(e); } finally { setBusyId(""); }
  };
  const dispatch = async (t: Task) => {
    setBusyId(`t${t.id}`);
    try {
      const r = await api.startTask(t.id, {});
      onSaved(r.task);
      onNotice(r.queued ? "已排队，等那台电脑上线" : "已派发");
      onRefresh();
    } catch (e) { fail(e); } finally { setBusyId(""); }
  };

  const approvalRow = (a: Approval) => {
    const task = tasks.find(t => t.sessionIds.includes(a.sessionId));
    const title = task?.title ?? sessions.find(s => s.id === a.sessionId)?.title ?? "会话";
    const isQuestion = a.tool === "userInput" && !!parseQuestions(a.detail);
    const busy = busyId === `a${a.id}`;
    return (
      <li key={`a${a.id}`} className="inbox-row">
        <span className="kind-chip k-approve">待授权</span>
        <div className="inbox-main">
          <strong className="inbox-title">{task && <span className="task-no">#{task.id} </span>}{title}</strong>
          <span className="dim inbox-sub"><code>{a.tool}</code> {isQuestion ? "它在问你问题" : clip(a.detail, 120)}{a.decisionReason ? ` · ${a.decisionReason}` : ""}</span>
        </div>
        <div className="inbox-actions">
          {isQuestion
            ? <button className="primary" onClick={() => onOpenSession(a.sessionId)}>去回答</button>
            : <>
              <button className="primary" disabled={busy} onClick={() => void decide(a, "allow")}>允许</button>
              <button disabled={busy} onClick={() => void decide(a, "deny")}>拒绝</button>
              <button className="ghost" onClick={() => onOpenSession(a.sessionId)}>打开会话</button>
            </>}
        </div>
      </li>
    );
  };

  const reviewRow = (t: Task) => (
    <li key={`r${t.id}`} className="inbox-row clickable" onClick={() => onOpen(t.id)}>
      <span className="kind-chip k-review">待验收</span>
      <div className="inbox-main">
        <strong className="inbox-title"><span className="task-no">#{t.id} </span>{t.title}</strong>
        <span className="dim inbox-sub">{t.agent ? (AGENT_LABEL[t.agent] ?? t.agent) : "无工具"} · {ago(t.updatedAt, now)}交付</span>
      </div>
      <div className="inbox-actions"><button className="primary" onClick={stop(() => onOpen(t.id))}>去验收</button></div>
    </li>
  );

  const stuckRow = (e: BoardEntry) => {
    const busy = busyId === `t${e.taskId}`;
    return (
      <li key={`s${e.taskId}`} className="inbox-row clickable" onClick={() => onOpen(e.taskId)}>
        <span className="kind-chip k-stuck">卡住</span>
        <div className="inbox-main">
          <strong className="inbox-title"><span className="task-no">#{e.taskId} </span>{e.title}</strong>
          <span className="dim inbox-sub">进行中但没有任何在跑的执行{e.machine && !e.machineOnline ? ` · ${e.machine} 离线` : ""}{e.lastActivityAt ? ` · 最后活动 ${ago(e.lastActivityAt, now)}` : ""}</span>
        </div>
        <div className="inbox-actions">
          <button className="primary" disabled={busy} onClick={stop(() => void act(e.taskId, "issue"))}>重新派发</button>
          <button disabled={busy} onClick={stop(() => void act(e.taskId, "todo"))}>退回待办</button>
        </div>
      </li>
    );
  };

  const proposalRow = (p: Proposal) => {
    const card = (
      <ProposalCard
        api={api} proposal={p} roles={roles} projects={projects} autoDispatch={autoDispatch}
        busy={busyProposal === p.id}
        onBusy={v => setBusyProposal(v ? p.id : 0)}
        onError={onNotice}
        onChanged={next => {
          setJustIgnored(ids => next.status === "discarded" ? (ids.includes(next.id) ? ids : [...ids, next.id]) : ids.filter(x => x !== next.id));
          // 建议 → 任务单：自动展开这一张
          if (p.stage === "suggest" && next.stage === "draft") setExpanded(next.id);
          onProposal(next);
        }}
        onTask={() => { onNotice("任务单已确认，任务建好了"); onRefresh(); }}
      />
    );
    if (p.status !== "pending" || p.stage === "suggest") return <li key={`p${p.id}`} className="inbox-card">{card}</li>;
    if (expanded === p.id) {
      return (
        <li key={`p${p.id}`} className="inbox-card">
          {card}
          <button className="link inbox-collapse" onClick={() => setExpanded(null)}>收起</button>
        </li>
      );
    }
    const a = p.assignee;
    const who = [a.roleName || "执行人待定", a.agent ? (AGENT_LABEL[a.agent] ?? a.agent) : ""].filter(Boolean).join(" · ");
    return (
      <li key={`p${p.id}`} className="inbox-row">
        <span className="kind-chip k-ticket">任务单</span>
        <div className="inbox-main">
          <strong className="inbox-title">{p.taskId !== null && <span className="task-no">#{p.taskId} </span>}{p.title}</strong>
          <span className="dim inbox-sub">{who}</span>
        </div>
        <div className="inbox-actions"><button className="primary" onClick={() => setExpanded(p.id)}>查看并确认</button></div>
      </li>
    );
  };

  const liveRow = (e: BoardEntry) => {
    const busy = busyId === `t${e.taskId}`;
    let badge: string;
    if (e.queued) badge = e.machineOnline ? "排队中" : `等 ${e.machine} 上线`;
    else badge = e.waitingApproval ? "待授权" : `运行中${e.run ? ` ${ago(e.run.startedAt, now).replace("前", "")}` : ""}`;
    if (e.queued && e.attempts > 0) badge += ` · 已试 ${e.attempts} 次`;
    return (
      <li key={`l${e.taskId}`} className="inbox-row clickable" onClick={() => onOpen(e.taskId)}>
        <span className={`kind-chip ${e.queued ? "k-queue" : "k-run"}`}>{badge}</span>
        <div className="inbox-main">
          <strong className="inbox-title"><span className="task-no">#{e.taskId} </span>{e.title}</strong>
          <span className="dim inbox-sub">{[e.agent ? (AGENT_LABEL[e.agent] ?? e.agent) : "", e.machine ? `${e.machine}${e.machineOnline ? "" : " · 离线"}` : "", e.queued ? `排队于 ${ago(e.queuedAt ?? e.updatedAt, now)}` : e.lastActivityAt ? `最后活动 ${ago(e.lastActivityAt, now)}` : ""].filter(Boolean).join(" · ")}</span>
        </div>
        <div className="inbox-actions">
          {!e.queued && e.run?.sessionId && <button onClick={stop(() => onOpenSession(e.run!.sessionId!))}>打开会话</button>}
          {e.queued && <>
            <button disabled={busy} onClick={stop(() => void act(e.taskId, "issue"))}>立即派发</button>
            <button disabled={busy} onClick={stop(() => void act(e.taskId, "unqueue"))}>取消排队</button>
          </>}
        </div>
      </li>
    );
  };

  const doingRow = (t: Task) => (
    <li key={`d${t.id}`} className="inbox-row clickable" onClick={() => onOpen(t.id)}>
      <span className="kind-chip k-run">进行中</span>
      <div className="inbox-main">
        <strong className="inbox-title"><span className="task-no">#{t.id} </span>{t.title}</strong>
        <span className="dim inbox-sub">{t.agent ? (AGENT_LABEL[t.agent] ?? t.agent) : "无工具"}{t.machine ? ` · ${t.machine}` : ""}</span>
      </div>
    </li>
  );

  const todoRow = (t: Task) => {
    const role = roles.find(r => r.id === t.roleId);
    const goal = goals.find(g => g.id === t.goalId);
    const canDispatch = t.roleId !== null || isDispatchable(t.agent);
    return (
      <li key={`o${t.id}`} className="inbox-row clickable" onClick={() => onOpen(t.id)}>
        <span className={`prio-dot ${t.priority}`} title={`${PRIO_LABEL[t.priority]}优先级`} />
        <div className="inbox-main">
          <strong className="inbox-title"><span className="task-no">#{t.id} </span>{t.title}</strong>
          <span className="dim inbox-sub">{[goal?.title ?? "无目标", role?.name ?? (t.agent ? (AGENT_LABEL[t.agent] ?? t.agent) : "")].filter(Boolean).join(" · ")} <ScheduleSummary value={t} /></span>
        </div>
        {canDispatch && <div className="inbox-actions"><button disabled={busyId === `t${t.id}`} onClick={stop(() => void dispatch(t))}>派发</button></div>}
      </li>
    );
  };

  const shownTodo = showAllTodo ? todoList : todoList.slice(0, TODO_LIMIT);

  return <>
    <div className="page-heading">
      <div><p className="eyebrow">一步一步，推进工作</p><h2>任务</h2><p>{parts.length ? parts.join(" · ") : "都处理完了"}</p></div>
      <div className="page-tools">
        <label className="sort-bar">项目<select value={projectId} onChange={e => setProjectId(e.target.value)}><option value="">全部</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="sort-bar">执行人<select value={roleId} onChange={e => setRoleId(e.target.value)}><option value="">全部</option>{roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
        <SortBar sort={sort} onChange={setSort} />
        <button className="primary" aria-expanded={showForm} onClick={() => setShowForm(!showForm)}><Icon name={showForm ? "close" : "plus"} /> {showForm ? "收起" : "发新单"}</button>
      </div>
    </div>
    {showForm && <DispatchForm api={api} projects={projects} roles={roles} autoDispatch={autoDispatch} onCreated={created} onCancel={() => setShowForm(false)} onNotice={onNotice} />}

    <section className="inbox">
      <h2>等你处理 {inboxCount > 0 && <span className="count">{inboxCount}</span>}</h2>
      {pendingApprovals.length + reviewTasks.length + stuckEntries.length + inboxProposals.length === 0 ? <p className="empty">没有等你处理的事</p> : (
        <ul className="list">
          {pendingApprovals.map(approvalRow)}
          {reviewTasks.map(reviewRow)}
          {stuckEntries.map(stuckRow)}
          {inboxProposals.map(proposalRow)}
        </ul>
      )}
    </section>

    <section>
      <h2>在跑 {liveTotal > 0 && <span className="count dim">{liveTotal}</span>}</h2>
      {liveTotal === 0 ? <p className="empty">没有在跑的活</p> : (
        <ul className="list">{liveEntries.map(liveRow)}{doingNoEntry.map(doingRow)}</ul>
      )}
    </section>

    <section>
      <h2>待办（{todoList.length}）</h2>
      <QuickCreate placeholder="添加一项任务…" create={onCreate} />
      {todoList.length === 0 ? <p className="empty">没有待办</p> : <ul className="list">{shownTodo.map(todoRow)}</ul>}
      {todoList.length > TODO_LIMIT && <button className="link" onClick={() => setShowAllTodo(!showAllTodo)}>{showAllTodo ? "收起" : `展开其余 ${todoList.length - TODO_LIMIT} 个`}</button>}
    </section>

    <details><summary>已完成（{doneList.length}）</summary>{doneList.length ? <TaskRows tasks={doneList} goals={goals} onOpen={onOpen} /> : <p className="empty">暂无已完成任务</p>}</details>
  </>;
}
