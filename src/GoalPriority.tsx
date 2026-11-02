import type { Goal } from "./lib/api";

export const GOAL_PRIORITIES = ["high", "medium", "low"] as const;
const LABEL: Record<Goal["priority"], string> = { high: "高", medium: "中", low: "低" };

export function GoalPriorityBadge({ priority = "medium" }: { priority?: Goal["priority"] }) {
  return <span className={`goal-priority ${priority}`}>{LABEL[priority]}优先级</span>;
}

export function GoalPrioritySelect({ value, onChange }: { value: Goal["priority"]; onChange(value: Goal["priority"]): void }) {
  return <select className={`goal-priority-select ${value}`} aria-label="目标优先级" value={value} onChange={e=>onChange(e.target.value as Goal["priority"])}>{GOAL_PRIORITIES.map(priority=><option key={priority} value={priority}>{LABEL[priority]}优先级</option>)}</select>;
}
