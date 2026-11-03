import { useEffect, useRef, useState } from "react";
import type { Api, Goal, Task } from "./lib/api";
import { QuickCreate, TaskRows } from "./TasksPanel";
import Icon from "./Icon";
import { localDateTime } from "./ScheduleFields";
import { PrioritySelect } from "./GoalPriority";
import InlineField from "./InlineField";

const fmt = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString() : "未设置";
const GOAL_STATUS: Record<Goal["status"], string> = { active: "进行中", done: "已完成", archived: "已归档" };
const toIso = (v: string) => v ? new Date(v).toISOString() : null;

/**
 * 目标详情：与任务详情保持一致的操作逻辑——字段就地编辑、即时保存，
 * 「完成目标」是主操作，删除沉到底部。
 */
export default function GoalView({ goal, tasks, api, onBack, onTask, onSaved, onTaskSaved, onDeleted }: { goal: Goal; tasks: Task[]; api: Api; onBack(): void; onTask(id: number): void; onSaved(g: Goal): void; onTaskSaved(t: Task): void; onDeleted(): void }) {
  const [busy, setBusy] = useState(false), [err, setErr] = useState(""), [saved, setSaved] = useState(false);
  const flashTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);
  const flash = () => { setSaved(true); window.clearTimeout(flashTimer.current); flashTimer.current = window.setTimeout(() => setSaved(false), 1600); };
  const guard = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(""); try { await fn(); flash(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const patch = (v: Partial<Pick<Goal, "title" | "notes" | "status" | "priority" | "startAt" | "dueAt" | "remindStart" | "remindDue">>) => void guard(async () => onSaved(await api.updateGoal(goal.id, v)));

  const done = goal.status === "done";
  const list = tasks.filter(t => t.goalId === goal.id), finished = list.filter(t => t.status === "done").length;
  return <div className="app"><header><button className="back-button" onClick={onBack}><Icon name="back" />返回</button><h1>目标详情</h1>{saved && <span className="save-flash" role="status">已保存</span>}</header><main className="entity-detail">
    <section className="entity-read">
      <div className="detail-head">
        <button className={`complete-toggle ${done ? "done" : ""}`} aria-pressed={done} title={done ? "标记为未完成" : "完成目标"} aria-label={done ? "标记为未完成" : "完成目标"} disabled={busy} onClick={() => patch({ status: done ? "active" : "done" })}><Icon name="check" /></button>
        <InlineField className="title-field" value={goal.title} ariaLabel="目标标题" placeholder="目标标题" maxLength={200} disabled={busy} onSave={title => patch({ title })} />
      </div>

      <div className="detail-props">
        <div className="prop"><span className="prop-label">状态</span>
          <div className="seg status" role="group" aria-label="目标状态">{(Object.keys(GOAL_STATUS) as Goal["status"][]).map(s => <button key={s} className={goal.status === s ? "active" : ""} aria-pressed={goal.status === s} disabled={busy} onClick={() => patch({ status: s })}>{GOAL_STATUS[s]}</button>)}</div>
        </div>
        <div className="prop"><span className="prop-label">优先级</span>
          <PrioritySelect value={goal.priority ?? "medium"} onChange={priority => patch({ priority })} />
        </div>
        <div className="prop"><span className="prop-label">任务进度</span>
          <span className="goal-progress detail-progress"><progress max={list.length || 1} value={finished} aria-label={`${goal.title}完成进度`} /><span>{list.length ? `${finished}/${list.length}` : "还没有任务"}</span></span>
        </div>
      </div>

      <div className="detail-props">
        <div className="prop"><span className="prop-label">开始时间</span>
          <input className="inline-control" type="datetime-local" aria-label="开始时间" value={localDateTime(goal.startAt)} max={localDateTime(goal.dueAt) || undefined} disabled={busy} onChange={e => patch({ startAt: toIso(e.target.value) })} />
          <label className="check"><input type="checkbox" checked={goal.remindStart} disabled={busy || !goal.startAt} onChange={e => patch({ remindStart: e.target.checked })} />开始时提醒</label>
        </div>
        <div className="prop"><span className="prop-label">截止时间</span>
          <input className={`inline-control ${goal.dueAt && !done && Date.parse(goal.dueAt) < Date.now() ? "overdue" : ""}`} type="datetime-local" aria-label="截止时间" value={localDateTime(goal.dueAt)} min={localDateTime(goal.startAt) || undefined} disabled={busy} onChange={e => patch({ dueAt: toIso(e.target.value) })} />
          <label className="check"><input type="checkbox" checked={goal.remindDue} disabled={busy || !goal.dueAt} onChange={e => patch({ remindDue: e.target.checked })} />截止时提醒</label>
        </div>
        {goal.doneAt && <div className="prop"><span className="prop-label">完成时间</span><span className="prop-value">{fmt(goal.doneAt)}</span></div>}
      </div>

      <InlineField className="notes-field" multiline value={goal.notes} ariaLabel="目标备注" placeholder="添加备注…（⌘/Ctrl + 回车保存）" maxLength={4000} required={false} disabled={busy} onSave={notes => patch({ notes })} />
    </section>

    {err && <p className="form-error" role="alert">{err}</p>}

    <section className="detail-section">
      <h3>目标下的任务（{finished}/{list.length}）</h3>
      <QuickCreate placeholder="在这个目标下新建任务…" create={async title => onTaskSaved(await api.createTask({ title, goalId: goal.id }))} />
      {list.length > 0 ? <TaskRows tasks={list} goals={[goal]} onOpen={onTask} /> : <p className="empty">还没有任务，添加一个开始拆解目标。</p>}
    </section>

    <section className="danger-zone">
      <button className="danger" disabled={busy} onClick={() => { if (!confirm("删除这个目标？下属任务会保留，并移出目标。")) return; void guard(async () => { await api.deleteGoal(goal.id); onDeleted(); }); }}>删除目标</button>
      <span className="dim">{list.length ? `${list.length} 个任务会保留` : "目标下暂无任务"}</span>
    </section>
  </main></div>;
}
