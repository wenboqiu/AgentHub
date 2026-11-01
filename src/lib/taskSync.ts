// WS 在同一连接上有序；HTTP 响应可能晚于后续的状态广播。
export function mergeEntity<T extends {id:number;updatedAt:string}>(items:Map<number,T>,item:T,source:"event"|"response"="event"):Map<number,T> {
  const current=items.get(item.id);
  if(current) {
    const delta=Date.parse(current.updatedAt)-Date.parse(item.updatedAt);
    if(delta>0 || delta===0 && source==="response") return items;
  }
  return new Map(items).set(item.id,item);
}
