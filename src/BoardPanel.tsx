import { useState } from "react";
import type { Api, BoardEntry } from "./lib/api";
import { AGENT_LABEL } from "./lib/agents";
// 派活看板：把「排队中 / 在跑 / 卡住」的活聚到一张板上。
// 数据由服务端从任务、队列和执行记录现算，这里只负责分组展示和当场处置：
// 卡住的可以重新派发或退回待办，排队的可以立即派发或取消排队。

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时`;
  return `${Math.floor(s / 86400)} 天`;
}

const stop = (fn: () => void) => (e: { stopPropagation(): void }) => {
  e.stopPropagation();
  fn();
};

function Entry({
  e, now, busy, onOpen, onAct,
}: {
  e: BoardEntry;
  now: number;
  busy: boolean;
  onOpen(id: number): void;
  onAct(id: number, kind: "issue" | "todo" | "unqueue"): void;
}) {
  let badge = "", foot = "";
  if (e.stuck) {
    badge = "无运行";
    foot = `进行中但没有任何在跑的执行${e.machine && !e.machineOnline ? ` · ${e.machine} 离线` : ""}${e.lastActivityAt ? ` · 最后活动 ${ago(e.lastActivityAt, now)}前` : ""}`;
  } else if (e.queued) {
    badge = e.machineOnline ? "排队中" : `等 ${e.machine} 上线`;
    if (e.attempts > 0) badge += ` · 已试 ${e.attempts} 次`;
    foot = `排队于 ${ago(e.queuedAt ?? e.updatedAt, now)}前`;
  } else {
    badge = e.waitingApproval ? "待授权" : "运行中";
    foot = `${e.run ? `已跑 ${ago(e.run.startedAt, now)}` : "执行中"}${e.lastActivityAt ? ` · 最后活动 ${ago(e.lastActivityAt, now)}前` : ""}`;
  }
  return (
    <li className={`row clickable${e.stuck ? " pending" : ""}`} onClick={() => onOpen(e.taskId)}>
      <div className="row-head">
        {e.agent && <span className={`tag ${e.agent}`}>{AGENT_LABEL[e.agent] ?? e.agent}</span>}
        <button className="session-open" onClick={stop(() => onOpen(e.taskId))}>{e.title}</button>
        {e.machine && <span className="machine">{e.machine}{e.machineOnline ? "" : " · 离线"}</span>}
        <span className="badge">{badge}</span>
      </div>
      <div className="row-foot">
        <span>{foot}</span>
        <span className="actions">
          {(e.stuck || e.queued) && <button className="link" disabled={busy} onClick={stop(() => onAct(e.taskId, "issue"))}>{e.stuck ? "重新派发" : "立即派发"}</button>}
          {e.stuck && <button className="link" disabled={busy} onClick={stop(() => onAct(e.taskId, "todo"))}>退回待办</button>}
          {e.queued && <button className="link" disabled={busy} onClick={stop(() => onAct(e.taskId, "unqueue"))}>取消排队</button>}
        </span>
      </div>
    </li>
  );
}

export default function BoardPanel({
  api, board, now, onRefresh, onOpen, onNotice,
}: {
  api: Api;
  /** 看板数据由 App 层统一获取（Tab 角标也要用），这里只展示 */
  board: { entries: BoardEntry[]; agents: string[] };
  now: number;
  onRefresh(): void;
  onOpen(id: number): void;
  onNotice(msg: string): void;
}) {
  const [busyId, setBusyId] = useState(0);
  const act = async (id: number, kind: "issue" | "todo" | "unqueue") => {
    setBusyId(id);
    const done = { issue: "已重新派发", todo: "已退回待办", unqueue: "已取消排队" }[kind];
    try {
      if (kind === "issue") await api.startTask(id, {});
      else if (kind === "todo") await api.updateTask(id, { status: "todo" });
      else await api.unqueueTask(id);
      onNotice(done);
      onRefresh();
    } catch (e) {
      onNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(0);
    }
  };

  if (!board) return <p className="hint">看板加载中…</p>;
  const stuck = board.entries.filter(e => e.stuck);
  const queued = board.entries.filter(e => e.queued && !e.stuck);
  const running = board.entries.filter(e => !e.stuck && !e.queued);
  const rows = (list: BoardEntry[]) => (
    <ul className="list">
      {list.map(e => <Entry key={e.taskId} e={e} now={now} busy={busyId === e.taskId} onOpen={onOpen} onAct={act} />)}
    </ul>
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">谁在干活，一眼看清</p>
          <h2>派活看板</h2>
          <p>{running.length} 个在跑 · {queued.length} 个排队{stuck.length > 0 ? ` · ${stuck.length} 个卡住` : ""}</p>
        </div>
      </div>
      <section>
        <h2>卡住 {stuck.length > 0 && <span className="count">{stuck.length}</span>}</h2>
        {stuck.length ? rows(stuck) : <p className="empty">没有异常，派出去的活都有人接着</p>}
      </section>
      <section>
        <h2>排队中 {queued.length > 0 && <span className="count dim">{queued.length}</span>}</h2>
        {queued.length ? rows(queued) : <p className="empty">没有排队中的活</p>}
      </section>
      <section>
        <h2>运行中 {running.length > 0 && <span className="count dim">{running.length}</span>}</h2>
        {running.length ? rows(running) : <p className="empty">没有在跑的活</p>}
      </section>
    </>
  );
}
