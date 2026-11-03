import type { Goal } from "./lib/api";

export const GOAL_PRIORITIES = ["high", "medium", "low"] as const;
export type Priority = Goal["priority"];
const LABEL: Record<Priority, string> = { high: "高", medium: "中", low: "低" };

export function PriorityBadge({ priority = "medium" }: { priority?: Priority }) {
  return <span className={`goal-priority ${priority}`}>{LABEL[priority]}优先级</span>;
}

export function PrioritySelect({ value, onChange, label = "优先级" }: { value: Priority; onChange(value: Priority): void; label?: string }) {
  return <select className={`goal-priority-select ${value}`} aria-label={label} value={value} onChange={e=>onChange(e.target.value as Priority)}>{GOAL_PRIORITIES.map(priority=><option key={priority} value={priority}>{LABEL[priority]}优先级</option>)}</select>;
}

/* 兼容旧命名：目标优先级组件现在任务也能直接复用 */
export const GoalPriorityBadge = PriorityBadge;
export const GoalPrioritySelect = PrioritySelect;
