import { useEffect, useState } from "react";
import type { Api, Goal, Session, Task, TaskInput } from "./lib/api";
import { TASK_LABEL } from "./TasksPanel";
import Icon from "./Icon";
import ScheduleFields, { scheduleOf } from "./ScheduleFields";
import Checklist from "./Checklist";
const formOf=(t:Task)=>({...scheduleOf(t),checklist:t.checklist ?? [],title:t.title,notes:t.notes,status:t.status,goalId:t.goalId,agent:t.agent,machine:t.machine,cwd:t.cwd});
export default function TaskView({task,goals,sessions,agents,api,onBack,onSession,onSaved,onDeleted}: {task:Task; goals:Goal[]; sessions:Session[]; agents:string[];api:Api;onBack():void;onSession(id:string):void;onSaved(t:Task):void;onDeleted():void}) {
  const [draft,setDraft]=useState(formOf(task)), [dirty,setDirty]=useState(false), [busy,setBusy]=useState(false), [err,setErr]=useState(""), [saved,setSaved]=useState(false), [starting,setStarting]=useState(false), [message,setMessage]=useState(""), [linking,setLinking]=useState(false);
  useEffect(()=>{if(!dirty)setDraft(formOf(task));},[task,dirty]);
  const change=(v:TaskInput)=>{setDraft(d=>({...d,...v}));setDirty(true);setSaved(false);setStarting(false);};
  const guard=async(fn:()=>Promise<unknown>)=>{setBusy(true);setErr("");try{await fn();}catch(e){setErr(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  const machine=task.machine || (agents.length===1 ? agents[0] : "");
  const reason=dirty ? "请先保存修改" : !task.agent ? "请选择 Claude 或 Codex" : !task.cwd ? "请填写项目目录" : !machine ? "请选择电脑" : !agents.includes(machine) ? "电脑端不在线" : "";
  const machines=[...new Set([...agents,...(draft.machine ? [draft.machine] : [])])];
  return <div className="app"><header><button className="back-button" onClick={onBack}><Icon name="back"/>返回</button><h1>任务详情</h1></header><main className="entity-detail">
    <form className="entity-form" onSubmit={e=>{e.preventDefault();void guard(async()=>{onSaved(await api.updateTask(task.id,draft));setDirty(false);setSaved(true);});}}>
      <label>标题<input value={draft.title} maxLength={200} onChange={e=>change({title:e.target.value})} required/></label>
      <label>备注<textarea value={draft.notes} maxLength={4000} onChange={e=>change({notes:e.target.value})}/></label>
      <ScheduleFields value={draft} onChange={change}/>
      <Checklist items={draft.checklist} onChange={checklist=>change({checklist})}/>
      <div className="form-grid"><label>状态<select value={draft.status} onChange={e=>change({status:e.target.value as Task["status"]})}>{Object.entries(TASK_LABEL).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
      <label>所属目标<select value={draft.goalId ?? ""} onChange={e=>change({goalId:e.target.value ? Number(e.target.value) : null})}><option value="">无</option>{goals.map(g=><option key={g.id} value={g.id}>{g.title}</option>)}</select></label>
      <label>执行工具<select value={draft.agent ?? ""} onChange={e=>change({agent:(e.target.value || null) as Task["agent"]})}><option value="">无（普通待办）</option><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
      <label>电脑<select value={draft.machine ?? ""} onChange={e=>change({machine:e.target.value || null})}><option value="">开始时选（仅一台在线时自动选择）</option>{machines.map(m=><option key={m} value={m}>{m}{agents.includes(m) ? "" : "（离线）"}</option>)}</select></label></div>
      <label>项目目录<input value={draft.cwd ?? ""} maxLength={4000} placeholder="例如 D:\Work2\项目" onChange={e=>change({cwd:e.target.value || null})}/></label>
      <div className="action-bar"><button className="primary" disabled={busy || !dirty}>保存</button>{saved&&<span role="status">已保存</span>}</div>
    </form>{err&&<p className="form-error" role="alert">{err}</p>}
    <section><div className="action-bar"><button className="primary" disabled={busy || !!reason} onClick={()=>{setMessage(task.notes || task.title);setStarting(true);}}>{task.sessionIds.length ? "再开一个会话" : "开始"}</button>{reason&&<span className="dim">{reason}</span>}</div>
    {starting&&<form className="selection-panel" onSubmit={e=>{e.preventDefault();void guard(async()=>{const r=await api.startTask(task.id,{text:message,machine});onSaved(r.task);onSession(r.sessionId);});}}><label>第一条消息<textarea value={message} maxLength={8000} onChange={e=>setMessage(e.target.value)}/></label><div className="action-bar"><button className="primary" disabled={busy || !!reason || !message.trim()}>确认开始</button><button type="button" onClick={()=>setStarting(false)}>取消</button></div></form>}</section>
    <h2>关联会话（{task.sessionIds.length}）</h2><ul className="list">{task.sessionIds.map(id=>{const s=sessions.find(s=>s.id===id);return <li className="linked-row" key={id}><button className="entity-row" disabled={!s} onClick={()=>onSession(id)}><span className="entity-main"><strong>{s ? `${s.agent === "claude" ? "Claude" : s.agent === "doubao" ? "豆包" : "Codex"} · ${s.project || "未知项目"}` : "会话已清理"}</strong><span className="dim">{s ? `${s.title} · ${{idle:"空闲",running:"运行中",waiting:"等待授权",done:"已完成",aborted:"已中断",ended:"已结束",unknown:"状态未知"}[s.state]} · ${new Date(s.updatedAt).toLocaleString()}` : id}</span></span></button><button disabled={busy} onClick={()=>void guard(async()=>onSaved(await api.unlinkSession(task.id,id)))}>取消挂接</button></li>;})}</ul>
    <button disabled={busy} onClick={()=>setLinking(!linking)}>关联已有会话</button>
    {linking&&<div className="selection-panel"><p>选择会话（最近 30 条）</p>{sessions.filter(s=>!task.sessionIds.includes(s.id)).slice(0,30).map(s=><button className="entity-row" key={s.id} disabled={busy} onClick={()=>void guard(async()=>{onSaved(await api.linkSession(task.id,s.id));setLinking(false);})}><span>{s.agent === "claude" ? "Claude" : s.agent === "doubao" ? "豆包" : "Codex"} · {s.project} · {s.title}</span></button>)}</div>}
    <div className="action-bar"><button className="danger" disabled={busy} onClick={()=>{if(confirm("删除这个任务？关联会话会保留。"))void guard(async()=>{await api.deleteTask(task.id);onDeleted();});}}>删除任务</button></div>
  </main></div>;
}
