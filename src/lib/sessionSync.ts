import type { Api, Message, Run, RunActivity } from "./api.ts";

export type BusEvent =
  | { kind: "message"; m: Message }
  | { kind: "run"; r: Run }
  | { kind: "activity"; a: RunActivity }
  | { kind: "resync" };
export type Bus = { subscribe(fn: (e: BusEvent) => void): () => void; emit(e: BusEvent): void };
export function makeBus(): Bus {
  const subs = new Set<(e: BusEvent) => void>();
  return {
    subscribe: (fn) => {
      subs.add(fn);
      return () => { subs.delete(fn); };
    },
    emit: (e) => subs.forEach((f) => f(e)),
  };
}

type Data = { messages: Message[]; run: Run | null; activity: RunActivity | null };
type Update = Exclude<BusEvent, { kind: "resync" }>;

function apply(data: Data, e: Update): Data {
  if (e.kind === "message") {
    if (data.messages.some((m) => m.id === e.m.id)) return { ...data, messages: data.messages.map(m=>m.id===e.m.id ? e.m : m) };
    return { ...data, messages: [...data.messages, e.m].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id).slice(-200) };
  }
  if (e.kind === "activity") {
    // 只认当前这次 run 的状态：上一个 run 的尾巴不能贴到新一轮上
    return e.a.runId === data.run?.id ? { ...data, activity: e.a.kind === "idle" ? null : e.a } : data;
  }
  const cur = data.run;
  if (cur && (cur.id === e.r.id ? Date.parse(cur.updatedAt) > Date.parse(e.r.updatedAt) : Date.parse(cur.createdAt) > Date.parse(e.r.createdAt))) return data;
  // 同一毫秒的终态也不能被旧的 running/queued 覆盖。
  if (cur?.id === e.r.id && !["queued", "running"].includes(cur.status) && ["queued", "running"].includes(e.r.status)) return data;
  // 换了一次 run：上一轮的「正在做什么」作废
  return { ...data, run: e.r, activity: cur?.id === e.r.id ? data.activity : null };
}

/** 重连补拉快照；请求期间收到的实时事件重放，避免慢响应覆盖新消息或终态。 */
export function syncSession(
  api: Pick<Api, "messages">, id: string, bus: Bus,
  onData: (data: Data) => void, onError: (error: unknown) => void, onLoaded: () => void,
) {
  let data: Data = { messages: [], run: null, activity: null };
  let generation = 0;
  let disposed = false;
  let duringLoad: Update[] | null = null;

  const reload = async () => {
    const request = ++generation;
    duringLoad = [];
    try {
      const result = await api.messages(id);
      if (disposed || request !== generation) return;
      data = { messages: result.messages, run: result.run, activity: result.activity ?? null };
      for (const event of duringLoad ?? []) data = apply(data, event);
      onData(data);
    } catch (error) {
      if (!disposed && request === generation) onError(error);
    } finally {
      if (!disposed && request === generation) {
        duringLoad = null;
        onLoaded();
      }
    }
  };
  const unsubscribe = bus.subscribe((event) => {
    if (event.kind === "resync") { void reload(); return; }
    const owner = event.kind === "message" ? event.m.sessionId : event.kind === "activity" ? event.a.sessionId : event.r.sessionId;
    if (owner !== id) return;
    duringLoad?.push(event);
    data = apply(data, event);
    onData(data);
  });
  return {
    reload,
    dispose: () => { disposed = true; unsubscribe(); },
  };
}
