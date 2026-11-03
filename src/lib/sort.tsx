import type { Goal } from "../lib/api";

export const PRIORITY_RANK = { high: 0, medium: 1, low: 2 } as const;
export type EntitySort = "priority" | "date" | "updated";
export const SORT_LABEL: Record<EntitySort, string> = { priority: "按优先级", date: "按日期", updated: "按更新时间" };
/** 目标和任务共有的排序字段 */
type Sortable = Pick<Goal, "priority" | "dueAt" | "startAt" | "updatedAt">;
const dueOf = (v: Sortable) => v.dueAt ? Date.parse(v.dueAt) : Infinity;
const rankOf = (v: Sortable) => PRIORITY_RANK[v.priority ?? "medium"];
export const ENTITY_SORTERS: Record<EntitySort, (a: Sortable, b: Sortable) => number> = {
  // 高优先级在前；同级再看截止时间（没设的排最后），最后按更新时间
  priority: (a,b)=>rankOf(a)-rankOf(b) || dueOf(a)-dueOf(b) || Date.parse(b.updatedAt)-Date.parse(a.updatedAt),
  // 有截止时间的在前、越早越靠前；没有日期的按优先级兜底
  date: (a,b)=>dueOf(a)-dueOf(b) || rankOf(a)-rankOf(b) || Date.parse(b.updatedAt)-Date.parse(a.updatedAt),
  updated: (a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt),
};
export function SortBar({sort,onChange}:{sort:EntitySort; onChange(sort:EntitySort):void}) {
  return <label className="sort-bar">排序<select value={sort} onChange={e=>onChange(e.target.value as EntitySort)}>{(Object.keys(SORT_LABEL) as EntitySort[]).map(k=><option key={k} value={k}>{SORT_LABEL[k]}</option>)}</select></label>;
}
