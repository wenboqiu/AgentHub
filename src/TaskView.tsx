import { useEffect, useRef, useState } from "react";
import type { Api, Goal, Session, Task, TaskInput } from "./lib/api";
import { TASK_LABEL } from "./TasksPanel";
import Icon from "./Icon";
import { localDateTime } from "./ScheduleFields";
import { PrioritySelect } from "./GoalPriority";
import Checklist from "./Checklist";
import InlineField from "./InlineField";
import { AGENT_LABEL } from "./lib/agents";

const fmt = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString() : "未设置";
const STATE_LABEL: Record<string, string> = { idle: "空闲", running: "运行中", waiting: "等待授权", done: "已完成", aborted: "已中断", ended: "已结束", unknown: "状态未知" };
const STATUSES = Object.keys(TASK_LABEL) as Task["status"][];
const toIso = (v: string) => v ? new Date(v).toISOString() : null;

/**
 * 任务详情：所有字段就地编辑、改动即时保存（参考 Linear / Todoist 的详情页），
 * 「完成」是主操作放在标题左侧，删除这类危险操作沉到页面底部。
 */
export default function TaskView({ task, goals, sessions, agents, api, onBack, onSession, onSaved, onDeleted }: { task: Task; goals: Goal[]; sessions: Session[]; agents: string[]; api: Api; onBack(): void; onSession(id: string): void; onSaved(t: Task): void; onDeleted(): void }) {
  const [busy, setBusy] = useState(false), [err, setErr] = useState(""), [saved, setSaved] = useState(false);
  const [starting, setStarting] = useState(false), [message, setMessage] = useState(""), [linking, setLinking] = useState(false);
  const [now, setNow] = useState(Date.now());
  const flashTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);
  useEffect(() => { if (!task.timerStartedAt) return; const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, [task.timerStartedAt]);
  const flash = () => { setSaved(true); window.clearTimeout(flashTimer.current); flashTimer.current = window.setTimeout(() => setSaved(false), 1600); };
  const elapsed = (iso: string) => { const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h} 小时 ${m} 分` : `${m} 分 ${s % 60} 秒`; };

  const guard = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(""); try { await fn(); flash(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const patch = (v: TaskInput) => void guard(async () => onSaved(await api.updateTask(task.id, v)));

  const done = task.status === "done";
  const machine = task.machine || (agents.length === 1 ? agents[0] : "");
  const reason = !task.agent ? "请选择 Claude 或 Codex" : !task.cwd ? "请填写项目目录" : !machine ? "请选择电脑" : !agents.includes(machine) ? "电脑端不在线" : "";
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
          <label>执行工具<select value={task.agent ?? ""} disabled={busy} onChange={e => patch({ agent: (e.target.value || null) as Task["agent"] })}><option value="">无（普通待办）</option><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
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
