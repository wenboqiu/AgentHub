import { ScheduleSummary } from "./ScheduleFields";
import { useState, type ReactNode } from "react";
import type { Goal, Task } from "./lib/api";
import { PriorityBadge } from "./GoalPriority";
import { ENTITY_SORTERS, SortBar, type EntitySort } from "./lib/sort";
import Icon from "./Icon";
export const TASK_LABEL: Record<Task["status"], string> = { todo: "待办", doing: "进行中", review: "待验收", done: "已完成" };
export function QuickCreate({ placeholder, create, children }: {placeholder: string; create(title: string): Promise<unknown>; children?: ReactNode}) {
  const [title,setTitle] = useState(""), [error,setError] = useState(""), [busy,setBusy] = useState(false);
  return <form className="quick-create" onSubmit={async e => { e.preventDefault(); if (!title.trim() || busy) return; setBusy(true); setError(""); try { await create(title.trim()); setTitle(""); } catch(e) {setError(e instanceof Error ? e.message : String(e));} finally {setBusy(false);} }}>
    <label className="sr-only" htmlFor={`quick-${placeholder}`}>{placeholder}</label><input id={`quick-${placeholder}`} placeholder={placeholder} maxLength={200} value={title} onChange={e=>setTitle(e.target.value)} disabled={busy}/>{children}<button className="primary" disabled={busy || !title.trim()}><Icon name="plus"/>{busy ? "创建中…" : "新建"}</button>{error && <p className="form-error" role="alert">{error}</p>}
  </form>;
}
export function TaskRows({tasks,goals,onOpen}: {tasks: Task[]; goals: Goal[]; onOpen(id:number): void}) {
  return <ul className="list">{tasks.map(t=><li key={t.id}><button className="entity-row" onClick={()=>onOpen(t.id)}><span className="entity-main"><span className="entity-title"><strong>{t.title}</strong><PriorityBadge priority={t.priority}/></span><span className="dim">{goals.find(g=>g.id===t.goalId)?.title ?? "无目标"}{t.sessionIds.length > 0 ? ` · ${t.sessionIds.length} 个会话` : ""}{t.agent ? ` · ${t.agent === "claude" ? "Claude" : "Codex"}` : ""}</span><ScheduleSummary value={t}/>{t.checklist?.length > 0 && <span className="dim">Checklist {t.checklist.filter(i=>i.done).length}/{t.checklist.length}</span>}</span>{t.timerStartedAt && <span className="timer-badge">计时中</span>}<span className={`task-status ${t.status}`}>{TASK_LABEL[t.status]}</span></button></li>)}</ul>;
}
export default function TasksPanel({tasks,goals,onOpen,onCreate}: {tasks: Task[]; goals: Goal[]; onOpen(id:number):void; onCreate(title:string):Promise<unknown>}) {
  const [sort,setSort]=useState<EntitySort>("updated");
  return <><div className="page-heading"><div><p className="eyebrow">一步一步，推进工作</p><h2>任务</h2><p>{tasks.filter(t=>t.status!=="done").length} 个未完成 · {tasks.filter(t=>t.status==="review").length} 个待验收</p></div><SortBar sort={sort} onChange={setSort}/></div><QuickCreate placeholder="添加一项任务…" create={onCreate}/>{(["review","doing","todo","done"] as const).map(status=>{
    const list=tasks.filter(t=>t.status===status).sort(ENTITY_SORTERS[sort]), content=list.length ? <TaskRows tasks={list} goals={goals} onOpen={onOpen}/> : <p className="empty">暂无{TASK_LABEL[status]}任务</p>;
    return status==="done" ? <details key={status}><summary>已完成（{list.length}）</summary>{content}</details> : <section key={status}><h2>{TASK_LABEL[status]}（{list.length}）</h2>{content}</section>;
  })}</>;
}
