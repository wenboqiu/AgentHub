import { useState } from "react";
import type { Goal, Task } from "./lib/api";
import { QuickCreate } from "./TasksPanel";
import { GoalPriorityBadge, GoalPrioritySelect } from "./GoalPriority";
export function Progress({goal,tasks}: {goal:Goal; tasks:Task[]}) {
  const list=tasks.filter(t=>t.goalId===goal.id), done=list.filter(t=>t.status==="done").length;
  return <span className="goal-progress"><progress max={list.length || 1} value={done} aria-label={`${goal.title}完成进度`}/><span>{list.length ? `${done}/${list.length}` : "还没有任务"}</span></span>;
}
export default function GoalsPanel({goals,tasks,onOpen,onCreate}: {goals:Goal[];tasks:Task[];onOpen(id:number):void;onCreate(title:string,priority:Goal["priority"]):Promise<unknown>}) {
  const [priority,setPriority]=useState<Goal["priority"]>("medium");
  const rows=(list:Goal[])=><ul className="list">{list.map(g=><li key={g.id}><button className="entity-row" onClick={()=>onOpen(g.id)}><span className="entity-main"><strong>{g.title}</strong><span className="goal-meta"><GoalPriorityBadge priority={g.priority}/><span className="dim">{{active:"进行中",done:"已完成",archived:"已归档"}[g.status]}</span></span></span><Progress goal={g} tasks={tasks}/></button></li>)}</ul>;
  return <><div className="page-heading"><div><p className="eyebrow">让每一步都有方向</p><h2>目标</h2><p>汇集相关任务，查看整体进度。</p></div></div><QuickCreate placeholder="添加一个目标…" create={title=>onCreate(title,priority)}><GoalPrioritySelect value={priority} onChange={setPriority}/></QuickCreate>{goals.some(g=>g.status!=="archived") ? rows(goals.filter(g=>g.status!=="archived")) : <p className="empty">还没有目标，创建一个目标来组织任务</p>}<details><summary>已归档（{goals.filter(g=>g.status==="archived").length}）</summary>{rows(goals.filter(g=>g.status==="archived"))}</details></>;
}
