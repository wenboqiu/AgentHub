import {test} from "node:test";
import assert from "node:assert/strict";
import {mergeEntity} from "../src/lib/taskSync.ts";
test("开始任务的慢 HTTP 响应不能覆盖已收到的待验收广播",()=>{
  const newer={id:1,updatedAt:"2026-11-01T01:00:01Z",status:"review"};
  const items=new Map([[1,newer]]);
  assert.equal(mergeEntity(items,{...newer,updatedAt:"2026-11-01T01:00:00Z",status:"doing"},"response"),items);
  assert.equal(items.get(1)?.status,"review");
});
test("同毫秒有序广播继续更新，HTTP 响应保留已收到的状态",()=>{
  const initial={id:1,updatedAt:"2026-11-01T01:00:00Z",status:"doing"};
  const items=mergeEntity(new Map([[1,initial]]),{...initial,status:"review"});
  assert.equal(items.get(1)?.status,"review");
  assert.equal(mergeEntity(items,initial,"response"),items);
});
test("新建响应可以立即入表，较新广播覆盖且不修改原 Map",()=>{
  const initial=new Map<number,{id:number;updatedAt:string;title:string}>();
  const item={id:1,updatedAt:"2026-11-01T01:00:00Z",title:"目标"};
  const next=mergeEntity(initial,item,"response");
  assert.equal(initial.size,0);assert.equal(next.get(1)?.title,"目标");
  assert.equal(mergeEntity(next,{...item,updatedAt:"2026-11-01T01:00:01Z",title:"新目标"}).get(1)?.title,"新目标");
});
