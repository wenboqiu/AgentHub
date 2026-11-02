import { useEffect, useMemo, useState } from "react";
import type { Api, Execution, Session } from "./lib/api";

const pad = (n: number) => String(n).padStart(2, "0");
const DAY = 86_400_000;
const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const hm = (iso: string) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
/** 本周周一 0 点 */
const weekStart = (d: Date) => { const s = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (d.getDay() + 6) % 7); return s; };
const AGENT_LABEL = { claude: "Claude", codex: "Codex", doubao: "豆包" } as const;
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

/** 日历条目：API 的执行记录，或由会话合成的"会话活动"（sessionState 有值） */
type CalItem = Execution & { sessionState?: Session["state"] };
const sessionItem = (s: Session): CalItem => ({
  id: `s-${s.id}`, sessionId: s.id, taskId: null, title: s.title, machine: s.machine,
  status: s.state === "running" ? "running" : "stopped", error: "",
  createdAt: s.eventAt || s.updatedAt, updatedAt: s.updatedAt,
  agent: s.agent, project: s.project, state: s.state, taskTitle: null, tasks: [],
  sessionState: s.state,
});
const itemAt = (e: CalItem) => Date.parse(e.createdAt);
const itemDay = (e: CalItem) => dateKey(new Date(e.createdAt));

function execTitle(e: CalItem) {
  const raw = e.taskTitle || e.title || e.tasks[0] || "";
  // 有些会话标题是工具通知原文，读不懂也排不了版，退回项目名
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t || t.length > 80 || /<[^>]+>/.test(t.slice(0, 30))) return e.project || "未命名会话";
  return t || e.project || (e.sessionState ? "会话" : "会话执行");
}
function execMeta(e: CalItem) {
  return [e.agent ? AGENT_LABEL[e.agent] : null, e.project, e.machine || (e.taskId ? "手动计时" : null)].filter(Boolean).join(" · ");
}
type StatusInfo = { label: string; cls: string; detail?: string };
function statusOf(e: CalItem, now: number): StatusInfo {
  // 会话条目：没有精确起止时间，以最后活动时间为准
  if (e.sessionState) {
    const last = `最后活动 ${hm(e.createdAt)}`;
    if (e.sessionState === "running") return { label: "执行中", cls: "running", detail: last };
    if (e.sessionState === "waiting") return { label: "等待中", cls: "waiting", detail: last };
    if (e.sessionState === "idle") return { label: "空闲", cls: "queued", detail: last };
    if (e.sessionState === "aborted") return { label: "已中断", cls: "stopped" };
    if (e.sessionState === "done" || e.sessionState === "ended") return { label: "已结束", cls: "done" };
    return { label: "状态未知", cls: "queued", detail: last };
  }
  const active = e.status === "queued" || e.status === "running";
  if (active) {
    const mins = Math.max(0, Math.round((now - Date.parse(e.createdAt)) / 60000));
    const dur = mins < 60 ? `${mins || "<"}1 分钟` : mins < 1440 ? `${Math.floor(mins / 60)} 小时 ${mins % 60} 分` : `${Math.floor(mins / 1440)} 天 ${Math.floor((mins % 1440) / 60)} 小时`;
    if (e.status === "queued") return { label: "排队中", cls: "queued", detail: `已等待 ${dur}` };
    if (e.state === "waiting") return { label: "等待中", cls: "waiting", detail: `已运行 ${dur}` };
    return { label: "执行中", cls: "running", detail: `已运行 ${dur}` };
  }
  if (e.status === "done") return { label: "已完成", cls: "done" };
  if (e.status === "failed") return { label: "失败", cls: "failed", detail: e.error || undefined };
  return { label: "已中断", cls: "stopped", detail: e.error || undefined };
}
/** 结束时间：进行中的用当前时间兜底 */
const endOf = (e: CalItem, now: number) => e.status === "queued" || e.status === "running" ? now : Date.parse(e.updatedAt);

export default function CalendarView({ api, sessions, runSignal, onOpenSession, onOpenTask }: { api: Api; sessions: Session[]; runSignal: number; onOpenSession(id: string): void; onOpenTask(id: number): void }) {
  const today = dateKey(new Date());
  const [cursor, setCursor] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [selected, setSelected] = useState(today);
  const [mode, setMode] = useState<"month" | "timeline">("month");
  const [scale, setScale] = useState<"week" | "day">("week");
  const [execs, setExecs] = useState<Execution[]>([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 30000); return () => window.clearInterval(t); }, []);

  // 拉取当前月（含跨月仍在执行的记录）；执行事件推送时重新拉取
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const from = new Date(cursor.y, cursor.m, 1), to = new Date(cursor.y, cursor.m + 1, 0, 23, 59, 59, 999);
    api.executions(from.toISOString(), to.toISOString())
      .then(r => { if (alive) { setExecs(r.executions); setErr(""); } })
      .catch(e => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api, cursor, runSignal]);

  // 当月有活动的会话（最后活动时间落在当月）——终端里直接开的会话没有 run 记录，也要出现在日历
  const monthStart = new Date(cursor.y, cursor.m, 1).getTime(), monthEnd = new Date(cursor.y, cursor.m + 1, 1).getTime();
  const sessionItems = useMemo(() => sessions
    .map(sessionItem)
    .filter(e => { const t = itemAt(e); return t >= monthStart && t < monthEnd; }), [sessions, monthStart, monthEnd]);

  // 每天汇总：执行按开始日期归属，会话按最后活动归属
  const byDay = useMemo(() => {
    const map = new Map<string, { total: number; done: number; failed: number; sessions: number }>();
    const bump = (key: string) => map.get(key) ?? map.set(key, { total: 0, done: 0, failed: 0, sessions: 0 }).get(key)!;
    for (const e of execs) {
      const c = bump(dateKey(new Date(e.createdAt)));
      c.total++;
      if (e.status === "done") c.done++;
      if (e.status === "failed" || e.status === "stopped") c.failed++;
    }
    for (const e of sessionItems) bump(itemDay(e)).sessions++;
    return map;
  }, [execs, sessionItems]);

  const monthTotal = [...byDay.values()].reduce((a, c) => ({ total: a.total + c.total, done: a.done + c.done, failed: a.failed + c.failed, sessions: a.sessions + c.sessions }), { total: 0, done: 0, failed: 0, sessions: 0 });
  const maxCount = Math.max(1, ...[...byDay.values()].map(c => c.total + c.sessions));

  // 月历网格：周一开头
  const cells = useMemo(() => {
    const first = new Date(cursor.y, cursor.m, 1);
    const offset = (first.getDay() + 6) % 7;
    const days = new Date(cursor.y, cursor.m + 1, 0).getDate();
    return [...Array(offset).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  }, [cursor]);

  // 选中日的执行日志：与该日有重叠的执行（含昨天开始还在跑的）+ 当天有活动的会话
  const dayLog = useMemo(() => {
    const [y, m, d] = selected.split("-").map(Number);
    const dayStart = new Date(y, m - 1, d).getTime(), dayEnd = dayStart + DAY;
    const runs: CalItem[] = execs.filter(e => Date.parse(e.createdAt) < dayEnd && endOf(e, now) >= dayStart);
    const sess = sessionItems.filter(e => { const t = itemAt(e); return t >= dayStart && t < dayEnd; });
    const log: CalItem[] = [...runs, ...sess];
    return log.sort((a, b) => itemAt(a) - itemAt(b));
  }, [execs, sessionItems, selected, now]);

  // 点执行记录：任务计时直接回任务，会话执行回会话
  const open = (e: CalItem) => e.taskId ? onOpenTask(e.taskId) : e.sessionId ? onOpenSession(e.sessionId) : undefined;

  // 时间轴：周（7 天）或日（24 小时）粒度，按会话（或任务计时）分行
  const timeline = useMemo(() => {
    const [y, m, d] = selected.split("-").map(Number);
    const start = scale === "day" ? new Date(y, m - 1, d).getTime() : weekStart(new Date(y, m - 1, d)).getTime();
    const span = scale === "day" ? DAY : 7 * DAY;
    const end = start + span;
    const rows = new Map<string, { label: string; runs: CalItem[] }>();
    const add = (key: string, label: string, e: CalItem) => {
      if (!rows.has(key)) rows.set(key, { label, runs: [] });
      rows.get(key)!.runs.push(e);
    };
    for (const e of execs) {
      if (Date.parse(e.createdAt) >= end || endOf(e, now) < start) continue;
      add(e.taskId ? `task-${e.taskId}` : `session-${e.sessionId ?? e.id}`, `${execTitle(e)}${e.agent ? ` · ${AGENT_LABEL[e.agent]}` : ""}`, e);
    }
    for (const e of sessionItems) {
      const t = itemAt(e);
      if (t < start || t >= end) continue;
      add(`session-${e.sessionId}`, `${execTitle(e)}${e.agent ? ` · ${AGENT_LABEL[e.agent]}` : ""}`, e);
    }
    return { start, span, rows: [...rows.values()] };
  }, [execs, sessionItems, selected, scale, now]);

  const shiftMonth = (delta: number) => {
    const next = new Date(cursor.y, cursor.m + delta, 1);
    setCursor({ y: next.getFullYear(), m: next.getMonth() });
    const t = dateKey(new Date());
    setSelected(t.startsWith(`${next.getFullYear()}-${pad(next.getMonth()+1)}`) ? t : `${next.getFullYear()}-${pad(next.getMonth()+1)}-01`);
  };
  const timeRange = (e: CalItem) => {
    if (e.sessionState) return `最后活动 ${hm(e.createdAt)}`;
    const s = hm(e.createdAt);
    if (e.status === "queued" || e.status === "running") return `${s}–至今`;
    const end = new Date(e.updatedAt);
    return dateKey(end) === dateKey(new Date(e.createdAt)) ? `${s}–${hm(e.updatedAt)}` : `${s}–${dateKey(end).slice(5)} ${hm(e.updatedAt)}`;
  };

  return <div className="calendar-panel">
    <div className="page-heading"><div><p className="eyebrow">按日期组织的工作执行看板</p><h2>日历</h2><p>{loading ? "加载中…" : `${cursor.y} 年 ${cursor.m + 1} 月：执行 ${monthTotal.total} · 会话 ${monthTotal.sessions} · 完成 ${monthTotal.done} · 失败 ${monthTotal.failed}`}</p></div>
      <div className="action-bar">
        {mode === "timeline" && <div className="seg" role="group" aria-label="时间轴粒度"><button className={scale === "week" ? "active" : ""} onClick={() => setScale("week")}>周</button><button className={scale === "day" ? "active" : ""} onClick={() => setScale("day")}>日</button></div>}
        <div className="seg"><button className={mode === "month" ? "active" : ""} onClick={() => setMode("month")}>月历</button><button className={mode === "timeline" ? "active" : ""} onClick={() => setMode("timeline")}>时间轴</button></div>
      </div>
    </div>
    {err && <p className="form-error" role="alert">{err}</p>}
    <div className="calendar-nav">
      <button onClick={() => shiftMonth(-1)} aria-label="上个月">←</button>
      <strong>{cursor.y} 年 {cursor.m + 1} 月</strong>
      <button onClick={() => shiftMonth(1)} aria-label="下个月">→</button>
    </div>
    {mode === "month" ? <section className="cal-grid-wrap">
      <div className="cal-weekdays">{WEEKDAYS.map(w => <span key={w}>{w}</span>)}</div>
      <div className="cal-grid">
        {cells.map((day, i) => day === null ? <span key={`b${i}`} className="cal-cell blank"/> : (() => {
          const key = `${cursor.y}-${pad(cursor.m+1)}-${pad(day)}`;
          const c = byDay.get(key);
          const total = c ? c.total + c.sessions : 0;
          const level = c ? Math.min(4, Math.ceil(total / maxCount * 4)) : 0;
          return <button key={key} className={`cal-cell heat-${level}${key === selected ? " selected" : ""}${key === today ? " today" : ""}`} onClick={() => setSelected(key)} title={c ? `执行 ${c.total} · 会话 ${c.sessions} · 完成 ${c.done} · 失败 ${c.failed}` : "无记录"}>
            <span className="cal-day">{day}</span>
            {total > 0 && <span className="cal-count">{total} 次{c && c.sessions > 0 && <em className="cal-sess">会话 {c.sessions}</em>}{c && c.failed > 0 && <em className="cal-fail">{c.failed} 失败</em>}</span>}
          </button>;
        })())}
      </div>
    </section> : <section className="cal-timeline">
      <div className={`tl-axis${scale === "day" ? " hours" : ""}`}>{scale === "week"
        ? Array.from({ length: 7 }, (_, i) => { const d = new Date(timeline.start + i * DAY); return <span key={i} className={dateKey(d) === today ? "today" : ""}>{`${d.getMonth()+1}/${d.getDate()}`}</span>; })
        : Array.from({ length: 8 }, (_, i) => <span key={i}>{`${i * 3}:00`}</span>)}</div>
      {timeline.rows.length ? timeline.rows.map(row => <div className="tl-row" key={row.label}>
        <span className="tl-label">{row.label}</span>
        <div className={`tl-track${scale === "day" ? " hours" : ""}`}>{row.runs.map(e => {
          const s = itemAt(e), end = endOf(e, now);
          const left = Math.max(0, (s - timeline.start) / timeline.span * 100);
          const width = Math.min(100 - left, Math.max(0.8, (Math.min(end, timeline.start + timeline.span) - Math.max(s, timeline.start)) / timeline.span * 100));
          const st = statusOf(e, now);
          return <button key={e.id} className={`tl-block ${st.cls}`} style={{ left: `${left}%`, width: `${width}%` }} title={`${timeRange(e)} ${execTitle(e)} · ${st.label}`} onClick={() => open(e)} />;
        })}</div>
      </div>) : <p className="empty">{scale === "day" ? "这一天" : "本周"}没有执行或会话记录</p>}
      {scale === "day" && selected === today && timeline.start <= now && now < timeline.start + timeline.span && (() => {
        const f = Math.min(1, Math.max(0, (now - timeline.start) / timeline.span));
        return <div className="tl-now" style={{ left: `calc(var(--tl-label-w) + 8px + (100% - var(--tl-label-w) - 8px) * ${f.toFixed(4)})` }} aria-hidden="true" title="当前时间"/>;
      })()}
    </section>}
    <section className="day-log">
      <h2>{selected === today ? "今天" : selected} 的执行日志（{dayLog.length}）</h2>
      {dayLog.length ? <ul className="list">{dayLog.map(e => {
        const st = statusOf(e, now);
        return <li key={e.id}><button className="entity-row" onClick={() => open(e)}>
          <span className="entity-main">
            <strong>{execTitle(e)}</strong>
            <span className="dim">{timeRange(e)} · {execMeta(e)}{!e.sessionState && st.detail && st.cls !== "failed" ? ` · ${st.detail}` : ""}</span>
            {st.detail && st.cls === "failed" && <span className="dim exec-error">{st.detail}</span>}
          </span>
          <span className={`exec-status ${st.cls}`}>{st.label}</span>
        </button></li>;
      })}</ul> : <p className="empty">这一天没有执行或会话记录</p>}
    </section>
  </div>;
}
