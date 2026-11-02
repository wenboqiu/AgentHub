import { useEffect, useState } from "react";
import type { Api, Goal, Task } from "./lib/api";
import { Progress } from "./GoalsPanel";
import { QuickCreate, TaskRows } from "./TasksPanel";
import Icon from "./Icon";
import ScheduleFields, { scheduleOf } from "./ScheduleFields";
import { GoalPriorityBadge, GoalPrioritySelect } from "./GoalPriority";
const formOf=(g:Goal)=>({...scheduleOf(g),title:g.title,notes:g.notes,status:g.status,priority:g.priority ?? "medium"});
const fmt=(iso:string|null|undefined)=>iso ? new Date(iso).toLocaleString() : "未设置";
const GOAL_STATUS:Record<Goal["status"],string>={active:"进行中",done:"已完成",archived:"已归档"};
export default function GoalView({goal,tasks,api,onBack,onTask,onSaved,onTaskSaved,onDeleted}: {goal:Goal; tasks:Task[]; api:Api; onBack():void; onTask(id:number):void; onSaved(g:Goal):void; onTaskSaved(t:Task):void; onDeleted():void}) {
  const [draft,setDraft]=useState(formOf(goal)), [editing,setEditing]=useState(false), [dirty,setDirty]=useState(false), [busy,setBusy]=useState(false), [err,setErr]=useState(""), [saved,setSaved]=useState(false);
  useEffect(()=>{if(!dirty)setDraft(formOf(goal));},[goal,dirty]);
  const change=(value:Partial<typeof draft>)=>{setDraft(d=>({...d,...value}));setDirty(true);setSaved(false);};
  const guard=async(fn:()=>Promise<unknown>)=>{setBusy(true);setErr("");try{await fn();}catch(e){setErr(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  // 浏览态直接切换状态，不用进入编辑
  const patch=(v:Partial<typeof draft>)=>void guard(async()=>onSaved(await api.updateGoal(goal.id,v)));
  const closeEdit=()=>{if(dirty && !confirm("放弃未保存的修改？"))return;setDraft(formOf(goal));setDirty(false);setEditing(false);};
  return <div className="app"><header><button className="back-button" onClick={onBack}><Icon name="back"/>返回</button><h1>目标详情</h1></header><main className="entity-detail">
    {editing
      ? <form className="entity-form" onSubmit={e=>{e.preventDefault();void guard(async()=>{onSaved(await api.updateGoal(goal.id,draft));setDirty(false);setSaved(true);setEditing(false);});}}>
        <label>标题<input value={draft.title} maxLength={200} onChange={e=>change({title:e.target.value})} required/></label>
        <label>备注<textarea value={draft.notes} maxLength={4000} onChange={e=>change({notes:e.target.value})}/></label>
        <ScheduleFields value={draft} onChange={change}/>
        <label>优先级<GoalPrioritySelect value={draft.priority} onChange={priority=>change({priority})}/><GoalPriorityBadge priority={draft.priority}/></label>
        <label>状态<select value={draft.status} onChange={e=>change({status:e.target.value as Goal["status"]})}><option value="active">进行中</option><option value="done">已完成</option><option value="archived">已归档</option></select></label>
        <div className="action-bar"><button className="primary" disabled={busy || !dirty}>保存</button><button type="button" disabled={busy} onClick={closeEdit}>取消</button>{saved&&<span role="status">已保存</span>}</div>
      </form>
      : <section className="entity-read">
        <div className="read-head"><h2>{goal.title || "未命名目标"}</h2><button className="ghost" onClick={()=>{setSaved(false);setEditing(true);}}><Icon name="edit"/>编辑</button></div>
        <div className="read-tags"><GoalPriorityBadge priority={goal.priority ?? "medium"}/>
          <div className="seg status" role="group" aria-label="目标状态">{(Object.keys(GOAL_STATUS) as Goal["status"][]).map(s=><button key={s} className={goal.status===s ? "active" : ""} aria-pressed={goal.status===s} disabled={busy} onClick={()=>patch({status:s})}>{GOAL_STATUS[s]}</button>)}</div>
        </div>
        {goal.notes.trim() && <p className="read-notes">{goal.notes}</p>}
        <dl className="read-grid">
          <div><dt>开始时间</dt><dd>{fmt(goal.startAt)}</dd></div>
          <div><dt>截止时间</dt><dd>{fmt(goal.dueAt)}</dd></div>
          <div><dt>完成时间</dt><dd>{fmt(goal.doneAt)}</dd></div>
        </dl>
        {saved && <p className="dim" role="status">已保存</p>}
      </section>}
    {err&&<p className="form-error" role="alert">{err}</p>}<Progress goal={goal} tasks={tasks}/><h2>目标下的任务</h2>
    <QuickCreate placeholder="在这个目标下新建任务…" create={async title=>onTaskSaved(await api.createTask({title,goalId:goal.id}))}/>
    <TaskRows tasks={tasks.filter(t=>t.goalId===goal.id)} goals={[goal]} onOpen={onTask}/>
    <button className="danger" disabled={busy} onClick={()=>{if(!confirm("删除这个目标？下属任务会保留，并移出目标。"))return;void guard(async()=>{await api.deleteGoal(goal.id);onDeleted();});}}>删除目标</button>
  </main></div>;
}
