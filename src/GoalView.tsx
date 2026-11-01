import { useEffect, useState } from "react";
import type { Api, Goal, Task } from "./lib/api";
import { Progress } from "./GoalsPanel";
import { QuickCreate, TaskRows } from "./TasksPanel";
import Icon from "./Icon";
export default function GoalView({goal,tasks,api,onBack,onTask,onSaved,onTaskSaved,onDeleted}: {goal:Goal; tasks:Task[]; api:Api; onBack():void; onTask(id:number):void; onSaved(g:Goal):void; onTaskSaved(t:Task):void; onDeleted():void}) {
  const [draft,setDraft]=useState({title:goal.title,notes:goal.notes,status:goal.status}), [dirty,setDirty]=useState(false), [busy,setBusy]=useState(false), [err,setErr]=useState(""), [saved,setSaved]=useState(false);
  useEffect(()=>{if(!dirty)setDraft({title:goal.title,notes:goal.notes,status:goal.status});},[goal,dirty]);
  const change=(value:Partial<typeof draft>)=>{setDraft(d=>({...d,...value}));setDirty(true);setSaved(false);};
  return <div className="app"><header><button className="back-button" onClick={onBack}><Icon name="back"/>返回</button><h1>目标详情</h1></header><main className="entity-detail">
    <form className="entity-form" onSubmit={async e=>{e.preventDefault();setBusy(true);setErr("");try{onSaved(await api.updateGoal(goal.id,draft));setDirty(false);setSaved(true);}catch(e){setErr(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}}>
      <label>标题<input value={draft.title} maxLength={200} onChange={e=>change({title:e.target.value})} required/></label>
      <label>备注<textarea value={draft.notes} maxLength={4000} onChange={e=>change({notes:e.target.value})}/></label>
      <label>状态<select value={draft.status} onChange={e=>change({status:e.target.value as Goal["status"]})}><option value="active">进行中</option><option value="done">已完成</option><option value="archived">已归档</option></select></label>
      <button className="primary" disabled={busy || !dirty}>保存</button>{saved&&<span role="status">已保存</span>}
    </form>{err&&<p className="form-error" role="alert">{err}</p>}<Progress goal={goal} tasks={tasks}/><h2>目标下的任务</h2>
    <QuickCreate placeholder="在这个目标下新建任务…" create={async title=>onTaskSaved(await api.createTask({title,goalId:goal.id}))}/>
    <TaskRows tasks={tasks.filter(t=>t.goalId===goal.id)} goals={[goal]} onOpen={onTask}/>
    <button className="danger" disabled={busy} onClick={async()=>{if(!confirm("删除这个目标？下属任务会保留，并移出目标。"))return;setBusy(true);setErr("");try{await api.deleteGoal(goal.id);onDeleted();}catch(e){setErr(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}}>删除目标</button>
  </main></div>;
}
