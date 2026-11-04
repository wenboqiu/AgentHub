import { useEffect, useRef, useState } from "react";
import type { Api, EvidenceKind, Goal, Review, ReviewItem, Session, Task, TaskDigests, TaskInput, ThreadEvent } from "./lib/api";
import { TASK_LABEL } from "./TasksPanel";
import Icon from "./Icon";
import { localDateTime } from "./ScheduleFields";
import { PrioritySelect } from "./GoalPriority";
import Checklist from "./Checklist";
import InlineField from "./InlineField";
import { AGENT_LABEL, agentName, isListenOnly } from "./lib/agents";

const fmt = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString() : "未设置";
const STATE_LABEL: Record<string, string> = { idle: "空闲", running: "运行中", waiting: "等待授权", done: "已完成", aborted: "已中断", ended: "已结束", unknown: "状态未知" };
const ROLE_LABEL: Record<string, string> = { user: "用户", assistant: "助手", tool: "工具", approval: "授权", system: "系统" };
const RUN_LABEL: Record<string, string> = { queued: "排队中", running: "运行中", done: "完成", failed: "失败", stopped: "已停止" };
const STATUSES = Object.keys(TASK_LABEL) as Task["status"][];
/** 执行工具下拉：Claude / Codex 能远程开跑，豆包 / WorkBuddy 只做状态监听 */
const AGENT_OPTIONS = Object.entries(AGENT_LABEL).map(([value, label]) => ({ value, label }));
const toIso = (v: string) => v ? new Date(v).toISOString() : null;

/**
 * 任务详情：所有字段就地编辑、改动即时保存（参考 Linear / Todoist 的详情页），
 * 「完成」是主操作放在标题左侧，删除这类危险操作沉到页面底部。
 */
export default function TaskView({ task, goals, sessions, agents, api, digest: liveDigest, onBack, onSession, onSaved, onDeleted }: { task: Task; goals: Goal[]; sessions: Session[]; agents: string[]; api: Api; digest?: TaskDigests; onBack(): void; onSession(id: string): void; onSaved(t: Task): void; onDeleted(): void }) {
  const [busy, setBusy] = useState(false), [err, setErr] = useState(""), [saved, setSaved] = useState(false);
  const [starting, setStarting] = useState(false), [message, setMessage] = useState(""), [linking, setLinking] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [fetchedDigest, setFetchedDigest] = useState<TaskDigests | null>(null);
  const [timeline, setTimeline] = useState<ThreadEvent[] | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [failing, setFailing] = useState<number | null>(null), [note, setNote] = useState(""), [newItem, setNewItem] = useState("");
  const flashTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);
  useEffect(() => { if (!task.timerStartedAt) return; const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, [task.timerStartedAt]);
  // 预摘要：打开详情时拉一次，任务更新（如重新进入待验收）后再拉；WS 推送的实时摘要优先
  useEffect(() => {
    let alive = true;
    api.digests(task.id).then(d => { if (alive) setFetchedDigest(d); }).catch(() => {});
    // Thread 时间线：任务为锚点的统一事件流（消息 / 执行 / 提醒 / 摘要）
    api.thread(task.id).then(r => { if (alive) setTimeline(r.events); }).catch(() => { if (alive) setTimeline([]); });
    // 验收：检查项 + 证据 + 打回沉淀的标准
    api.review(task.id).then(r => { if (alive) setReview(r); }).catch(() => { if (alive) setReview(null); });
    return () => { alive = false; };
  }, [api, task.id, task.updatedAt]);
  const digest: TaskDigests | null = liveDigest ?? fetchedDigest;
  const flash = () => { setSaved(true); window.clearTimeout(flashTimer.current); flashTimer.current = window.setTimeout(() => setSaved(false), 1600); };
  const elapsed = (iso: string) => { const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h} 小时 ${m} 分` : `${m} 分 ${s % 60} 秒`; };

  const guard = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(""); try { await fn(); flash(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const patch = (v: TaskInput) => void guard(async () => onSaved(await api.updateTask(task.id, v)));
  // 验收判定：通过 / 打回（打回原因沉淀为账号级标准，下次交付前自查）
  const decide = (it: ReviewItem, status: ReviewItem["status"]) => void guard(async () => {
    await api.decideReviewItem(task.id, it.id, status, status === "fail" ? note : it.note);
    setReview(await api.review(task.id));
    if (status === "fail") { setFailing(null); setNote(""); }
  });
  const addItem = () => void guard(async () => {
    await api.addReviewItem(task.id, newItem.trim());
    setNewItem("");
    setReview(await api.review(task.id));
  });
  const passed = review?.items.filter(i => i.status === "pass").length ?? 0;
  const evidenceGroups = (["test", "command", "file", "shot", "log"] as EvidenceKind[])
    .map(k => ({ k, label: (review?.evidence ?? []).find(e => e.kind === k)?.label ?? k, list: (review?.evidence ?? []).filter(e => e.kind === k) }))
    .filter(g => g.list.length > 0);

  const done = task.status === "done";
  const machine = task.machine || (agents.length === 1 ? agents[0] : "");
  const listenOnly = isListenOnly(task.agent);
  const reason = !task.agent ? "请选择执行工具" : listenOnly ? `${agentName(task.agent ?? "")} 只做状态监听，请在客户端里执行后用「关联已有会话」挂上` : !task.cwd ? "请填写项目目录" : !machine ? "请选择电脑" : !agents.includes(machine) ? "电脑端不在线" : "";
  const machines = [...new Set([...agents, ...(task.machine ? [task.machine] : [])])];
  const items = task.checklist ?? [];
  const goalTitle = goals.find(g => g.id === task.goalId)?.title;

  return <div className="app"><header><button className="back-button" onClick={onBack}><Icon name="back" />返回</button><h1>任务详情</h1>{saved && <span className="save-flash" role="status">已保存</span>}</header><main className="entity-detail">
    <section className="entity-read">
      <div className="detail-head">
        <button className={`complete-toggle ${done ? "done" : ""}`} aria-pressed={done} title={done ? "标记为未完成" : "标记为完成"} aria-label={done ? "标记为未完成" : "标记为完成"} disabled={busy} onClick={() => patch({ status: done ? "todo" : "done" })}><Icon name="check" /></button>
        <InlineField className="title-field" value={task.title} ariaLabel="任务标题" placeholder="任务标题" maxLength={200} disabled={busy} onSave={title => patch({ title })} />
      </div>

      <div className="detail-props">
        <div className="prop"><span className="prop-label">状态</span>
          <div className="seg status" role="group" aria-label="任务状态">{STATUSES.map(s => <button key={s} className={task.status === s ? "active" : ""} aria-pressed={task.status === s} disabled={busy} onClick={() => patch({ status: s })}>{TASK_LABEL[s]}</button>)}</div>
        </div>
        <div className="prop"><span className="prop-label">优先级</span>
          <PrioritySelect value={task.priority ?? "medium"} onChange={priority => patch({ priority })} />
        </div>
        <div className="prop"><span className="prop-label">所属目标</span>
          <select className="inline-control" aria-label="所属目标" value={task.goalId ?? ""} disabled={busy} onChange={e => patch({ goalId: e.target.value ? Number(e.target.value) : null })}><option value="">无目标</option>{goals.map(g => <option key={g.id} value={g.id}>{g.title}</option>)}</select>
        </div>
      </div>

      <div className="detail-props">
        <div className="prop"><span className="prop-label">开始时间</span>
          <input className="inline-control" type="datetime-local" aria-label="开始时间" value={localDateTime(task.startAt)} max={localDateTime(task.dueAt) || undefined} disabled={busy} onChange={e => patch({ startAt: toIso(e.target.value) })} />
          <label className="check"><input type="checkbox" checked={task.remindStart} disabled={busy || !task.startAt} onChange={e => patch({ remindStart: e.target.checked })} />开始时提醒</label>
        </div>
        <div className="prop"><span className="prop-label">截止时间</span>
          <input className={`inline-control ${task.dueAt && !done && Date.parse(task.dueAt) < now ? "overdue" : ""}`} type="datetime-local" aria-label="截止时间" value={localDateTime(task.dueAt)} min={localDateTime(task.startAt) || undefined} disabled={busy} onChange={e => patch({ dueAt: toIso(e.target.value) })} />
          <label className="check"><input type="checkbox" checked={task.remindDue} disabled={busy || !task.dueAt} onChange={e => patch({ remindDue: e.target.checked })} />截止时提醒</label>
        </div>
        {task.doneAt && <div className="prop"><span className="prop-label">完成时间</span><span className="prop-value">{fmt(task.doneAt)}</span></div>}
      </div>

      <InlineField className="notes-field" multiline value={task.notes} ariaLabel="任务备注" placeholder="添加备注…（⌘/Ctrl + 回车保存）" maxLength={4000} required={false} disabled={busy} onSave={notes => patch({ notes })} />

      <Checklist items={items} disabled={busy} onChange={checklist => patch({ checklist })} />
    </section>

    {err && <p className="form-error" role="alert">{err}</p>}

    {review && (review.items.length > 0 || review.evidence.length > 0 || task.status === "review") && (
      <section className="detail-section">
        <h3>验收{review.items.length > 0 ? <span className="dim"> · {passed}/{review.items.length} 通过</span> : null}</h3>
        {review.items.length === 0 && <p className="hint">这个任务还没有检查项。任务清单里的每一项都会自动变成检查项，也可以在这里临时补。</p>}
        <ul className="review-list">
          {review.items.map(it => (
            <li key={it.id} className={`review-item ${it.status}`}>
              <div className="review-row">
                <span className={`review-dot ${it.status}`} aria-hidden />
                <span className="review-title">{it.title}</span>
                <span className="review-actions">
                  <button className="link" disabled={busy} onClick={() => void decide(it, it.status === "pass" ? "pending" : "pass")}>{it.status === "pass" ? "撤销" : "通过"}</button>
                  <button className="link danger" disabled={busy} onClick={() => { setFailing(failing === it.id ? null : it.id); setNote(it.note); }}>{it.status === "fail" ? "重新打回" : "打回"}</button>
                </span>
              </div>
              {it.note && failing !== it.id && <p className="review-note-text">{it.note}</p>}
              {failing === it.id && (
                <div className="review-note">
                  <textarea value={note} maxLength={500} placeholder="打回原因（会沉淀为标准，下次交付前先自查）" onChange={e => setNote(e.target.value)} />
                  <div className="action-bar">
                    <button className="primary" disabled={busy} onClick={() => void decide(it, "fail")}>确认打回</button>
                    <button onClick={() => setFailing(null)}>取消</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
        <form className="review-add" onSubmit={e => { e.preventDefault(); if (newItem.trim()) addItem(); }}>
          <input value={newItem} maxLength={500} placeholder="补一项检查…" onChange={e => setNewItem(e.target.value)} />
          <button disabled={busy || !newItem.trim()}>添加</button>
        </form>

        {evidenceGroups.length > 0 && (
          <div className="evidence">
            <p className="dim">证据（自动摘取自会话记录，只读）</p>
            {evidenceGroups.map(g => (
              <details key={g.k}>
                <summary>{g.label} · {g.list.length}</summary>
                <ul>{g.list.map((e, i) => <li key={i}><code>{e.value}</code></li>)}</ul>
              </details>
            ))}
          </div>
        )}

        {review.standards.length > 0 && (
          <div className="review-standards">
            <p className="dim">打回沉淀的标准（最近 5 条，交付前先自查）</p>
            <ul>{review.standards.map((s, i) => <li key={i}>{s}</li>)}</ul>
          </div>
        )}
      </section>
    )}

    {(digest?.review || digest?.failure) && (
      <section className="detail-section">
        <h3>预摘要</h3>
        {digest?.failure && (
          <div className="digest-card bad">
            <strong>最近一次失败（{new Date(digest.failure.builtAt).toLocaleString()}）</strong>
            <p>{digest.failure.error || "（执行器未返回错误信息）"}</p>
            {digest.failure.tail.length > 0 && (
              <p className="dim">{digest.failure.tail.map(m => `[${m.role}] ${m.text}`).join(" ⏎ ")}</p>
            )}
          </div>
        )}
        {digest?.review && (
          <div className="digest-card">
            <strong>验收摘要{digest.review.sessionTitle ? ` · ${digest.review.sessionTitle}` : ""}</strong>
            <p className="dim">
              {digest.review.messages > 0 ? `已同步 ${digest.review.messages} 条消息` : "会话还没有同步消息"}
              {digest.review.runs.length ? ` · 最近执行 ${digest.review.runs.map(r => r.status).join(" / ")}` : ""}
            </p>
            <p>{digest.review.lastReply || "还没有助手回复内容；打开会话详情加载历史可看全文。"}</p>
            {digest.review.sessionId && <button className="link" onClick={() => onSession(digest.review!.sessionId!)}>打开会话</button>}
          </div>
        )}
        <p className="hint">摘要在会话完成或失败时由服务端后台预生成，打开详情即可看到，不用等终端加载。</p>
      </section>
    )}

    {timeline !== null && timeline.length > 0 && (
      <section className="detail-section">
        <h3>
          时间线
          <button className="link" onClick={() => void api.thread(task.id).then(r => setTimeline(r.events)).catch(() => {})}>刷新</button>
        </h3>
        <ul className="timeline">
          {timeline.slice(0, 50).map((e, i) => (
            <li key={i} className={`tl-item tl-${e.type}`}>
              <span className="tl-time">{new Date(e.at).toLocaleString()}</span>
              <span className="tl-body">
                {e.type === "message" && <>{ROLE_LABEL[e.role] ?? e.role}：{e.text.slice(0, 200)}</>}
                {e.type === "run" && <>执行 {RUN_LABEL[e.status] ?? e.status}{e.error ? ` · ${e.error.slice(0, 120)}` : ""}</>}
                {e.type === "reminder" && <>{e.title}{e.acked ? "（已处理）" : ""}</>}
                {e.type === "digest" && <>{e.kind === "failure" ? "失败上下文" : "验收摘要"}：{e.text.slice(0, 200) || "（无内容）"}</>}
              </span>
            </li>
          ))}
        </ul>
        <p className="hint">以任务为锚点的统一事件流：关联会话的对话、执行记录、时间提醒和摘要按时间合并；最多显示最近 50 条。</p>
      </section>
    )}

    <section className="detail-section">
      <h3>执行</h3>
      <div className="action-bar">
        {task.timerStartedAt
          ? <><button disabled={busy} onClick={() => void guard(async () => onSaved(await api.stopTimer(task.id)))}>结束计时</button><span className="dim">已计时 {elapsed(task.timerStartedAt)}</span></>
          : <button disabled={busy || done} onClick={() => void guard(async () => onSaved(await api.startTimer(task.id)))}><Icon name="timer" />开始计时</button>}
        <button className="primary" disabled={busy || !!reason} onClick={() => { setMessage(task.notes || task.title); setStarting(true); }}>{task.sessionIds.length ? "再开一个会话" : "开始执行"}</button>
        {reason && <span className="dim">{reason}</span>}
      </div>
      {starting && <form className="selection-panel" onSubmit={e => { e.preventDefault(); void guard(async () => { const r = await api.startTask(task.id, { text: message, machine }); onSaved(r.task); onSession(r.sessionId); }); }}>
        <label>第一条消息<textarea value={message} maxLength={8000} onChange={e => setMessage(e.target.value)} /></label>
        <div className="action-bar"><button className="primary" disabled={busy || !!reason || !message.trim()}>确认开始</button><button type="button" onClick={() => setStarting(false)}>取消</button></div>
      </form>}
      <details className="exec-settings" open={!task.agent || !task.cwd}>
        <summary>执行设置（工具 / 电脑 / 目录）</summary>
        <div className="form-grid">
          <label>执行工具<select value={task.agent ?? ""} disabled={busy} onChange={e => patch({ agent: (e.target.value || null) as Task["agent"] })}><option value="">无（普通待办）</option>{AGENT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
          <label>电脑<select value={task.machine ?? ""} disabled={busy} onChange={e => patch({ machine: e.target.value || null })}><option value="">开始时自动选择</option>{machines.map(m => <option key={m} value={m}>{m}{agents.includes(m) ? "" : "（离线）"}</option>)}</select></label>
        </div>
        <label className="cwd-field">项目目录<InlineField value={task.cwd ?? ""} ariaLabel="项目目录" placeholder={"例如 D:\\Work2\\项目"} maxLength={4000} required={false} disabled={busy} onSave={cwd => patch({ cwd: cwd || null })} /></label>
      </details>
    </section>

    <section className="detail-section">
      <h3>关联会话（{task.sessionIds.length}）</h3>
      {task.sessionIds.length > 0
        ? <ul className="list">{task.sessionIds.map(id => { const s = sessions.find(s => s.id === id); return <li className="linked-row" key={id}><button className="entity-row" disabled={!s} onClick={() => onSession(id)}><span className="entity-main"><strong>{s ? `${AGENT_LABEL[s.agent] ?? s.agent} · ${s.project || "未知项目"}` : "会话已清理"}</strong><span className="dim">{s ? `${s.title} · ${STATE_LABEL[s.state] ?? s.state} · ${new Date(s.updatedAt).toLocaleString()}` : id}</span></span></button><button className="icon-ghost" aria-label="取消挂接" title="取消挂接" disabled={busy} onClick={() => void guard(async () => onSaved(await api.unlinkSession(task.id, id)))}><Icon name="close" /></button></li>; })}</ul>
        : <p className="dim">还没有关联会话。开始执行后会自动挂接。</p>}
      <button className="link" disabled={busy} onClick={() => setLinking(!linking)}>关联已有会话</button>
      {linking && <div className="selection-panel"><p>选择会话（最近 30 条）</p>{sessions.filter(s => !task.sessionIds.includes(s.id)).slice(0, 30).map(s => <button className="entity-row" key={s.id} disabled={busy} onClick={() => void guard(async () => { onSaved(await api.linkSession(task.id, s.id)); setLinking(false); })}><span>{AGENT_LABEL[s.agent] ?? s.agent} · {s.project} · {s.title}</span></button>)}</div>}
    </section>

    <section className="danger-zone">
      <button className="danger" disabled={busy} onClick={() => { if (confirm("删除这个任务？关联会话会保留。")) void guard(async () => { await api.deleteTask(task.id); onDeleted(); }); }}>删除任务</button>
      <span className="dim">{goalTitle ? `属于「${goalTitle}」` : "未归属目标"}</span>
    </section>
  </main></div>;
}
