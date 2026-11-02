import { useEffect, useMemo, useState } from "react";
import type { Api, Execution } from "./lib/api";

const pad = (n: number) => String(n).padStart(2, "0");
const DAY = 86_400_000;
const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const hm = (iso: string) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
/** 本周周一 0 点 */
const weekStart = (d: Date) => { const s = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (d.getDay() + 6) % 7); return s; };
const AGENT_LABEL = { claude: "Claude", codex: "Codex", doubao: "豆包" } as const;
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function execTitle(e: Execution) {
  return e.taskTitle || e.title || e.tasks[0] || e.project || "会话执行";
}
function execMeta(e: Execution) {
  return [e.agent ? AGENT_LABEL[e.agent] : null, e.project, e.machine || (e.taskId ? "手动计时" : null)].filter(Boolean).join(" · ");
}
type StatusInfo = { label: string; cls: string; detail?: string };
function statusOf(e: Execution, now: number): StatusInfo {
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
const endOf = (e: Execution, now: number) => e.status === "queued" || e.status === "running" ? now : Date.parse(e.updatedAt);

export default function CalendarView({ api, runSignal, onOpenSession, onOpenTask }: { api: Api; runSignal: number; onOpenSession(id: string): void; onOpenTask(id: number): void }) {
  const today = dateKey(new Date());
  const [cursor, setCursor] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [selected, setSelected] = useState(today);
  const [mode, setMode] = useState<"month" | "timeline">("month");
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

  // 每天汇总：按开始日期归属
  const byDay = useMemo(() => {
    const map = new Map<string, { total: number; done: number; failed: number }>();
    for (const e of execs) {
      const key = dateKey(new Date(e.createdAt));
      const c = map.get(key) ?? { total: 0, done: 0, failed: 0 };
      c.total++;
      if (e.status === "done") c.done++;
      if (e.status === "failed" || e.status === "stopped") c.failed++;
      map.set(key, c);
    }
    return map;
  }, [execs]);

  const monthTotal = [...byDay.values()].reduce((a, c) => ({ total: a.total + c.total, done: a.done + c.done, failed: a.failed + c.failed }), { total: 0, done: 0, failed: 0 });
  const maxCount = Math.max(1, ...[...byDay.values()].map(c => c.total));

  // 月历网格：周一开头
  const cells = useMemo(() => {
    const first = new Date(cursor.y, cursor.m, 1);
    const offset = (first.getDay() + 6) % 7;
    const days = new Date(cursor.y, cursor.m + 1, 0).getDate();
    return [...Array(offset).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  }, [cursor]);

  // 选中日的执行日志：与该日有重叠的执行（含昨天开始还在跑的）
  const dayLog = useMemo(() => {
    const [y, m, d] = selected.split("-").map(Number);
    const dayStart = new Date(y, m - 1, d).getTime(), dayEnd = dayStart + DAY;
    return execs.filter(e => Date.parse(e.createdAt) < dayEnd && endOf(e, now) >= dayStart).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }, [execs, selected, now]);

  // 点执行记录：任务计时直接回任务，会话执行回会话
  const open = (e: Execution) => e.taskId ? onOpenTask(e.taskId) : e.sessionId ? onOpenSession(e.sessionId) : undefined;

  // 时间轴：选中日所在一周的执行，按会话（或任务计时）分行
  const timeline = useMemo(() => {
    const start = weekStart(new Date(selected.replace(/-/g, "/"))).getTime();
    const rows = new Map<string, { label: string; runs: Execution[] }>();
    for (const e of execs) {
      if (Date.parse(e.createdAt) >= start + 7 * DAY || endOf(e, now) < start) continue;
      const key = e.taskId ? `task-${e.taskId}` : `session-${e.sessionId ?? e.id}`;
      if (!rows.has(key)) rows.set(key, { label: `${execTitle(e)}${e.agent ? ` · ${AGENT_LABEL[e.agent]}` : ""}`, runs: [] });
      rows.get(key)!.runs.push(e);
    }
    return { start, rows: [...rows.values()] };
  }, [execs, selected, now]);

  const shiftMonth = (delta: number) => {
    const next = new Date(cursor.y, cursor.m + delta, 1);
    setCursor({ y: next.getFullYear(), m: next.getMonth() });
    const t = dateKey(new Date());
    setSelected(t.startsWith(`${next.getFullYear()}-${pad(next.getMonth()+1)}`) ? t : `${next.getFullYear()}-${pad(next.getMonth()+1)}-01`);
  };
  const timeRange = (e: Execution) => {
    const s = hm(e.createdAt);
    if (e.status === "queued" || e.status === "running") return `${s}–至今`;
    const end = new Date(e.updatedAt);
    return dateKey(end) === dateKey(new Date(e.createdAt)) ? `${s}–${hm(e.updatedAt)}` : `${s}–${dateKey(end).slice(5)} ${hm(e.updatedAt)}`;
  };

  return <div className="calendar-panel">
    <div className="page-heading"><div><p className="eyebrow">按日期组织的工作执行看板</p><h2>日历</h2><p>{loading ? "加载中…" : `${cursor.y} 年 ${cursor.m + 1} 月：共 ${monthTotal.total} 次执行 · 完成 ${monthTotal.done} · 失败 ${monthTotal.failed}`}</p></div>
      <div className="action-bar"><div className="seg"><button className={mode === "month" ? "active" : ""} onClick={() => setMode("month")}>月历</button><button className={mode === "timeline" ? "active" : ""} onClick={() => setMode("timeline")}>时间轴</button></div></div>
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
          const level = c ? Math.min(4, Math.ceil(c.total / maxCount * 4)) : 0;
          return <button key={key} className={`cal-cell heat-${level}${key === selected ? " selected" : ""}${key === today ? " today" : ""}`} onClick={() => setSelected(key)} title={c ? `执行 ${c.total} · 完成 ${c.done} · 失败 ${c.failed}` : "无执行记录"}>
            <span className="cal-day">{day}</span>
            {c && <span className="cal-count">{c.total} 次{c.failed > 0 && <em className="cal-fail">{c.failed} 失败</em>}</span>}
          </button>;
        })())}
      </div>
    </section> : <section className="cal-timeline">
      <div className="tl-axis">{Array.from({ length: 7 }, (_, i) => { const d = new Date(timeline.start + i * DAY); return <span key={i} className={dateKey(d) === today ? "today" : ""}>{`${d.getMonth()+1}/${d.getDate()}`}</span>; })}</div>
      {timeline.rows.length ? timeline.rows.map(row => <div className="tl-row" key={row.label}>
        <span className="tl-label">{row.label}</span>
        <div className="tl-track">{row.runs.map(e => {
          const s = Date.parse(e.createdAt), end = endOf(e, now);
          const left = Math.max(0, (s - timeline.start) / (7 * DAY) * 100);
          const width = Math.min(100 - left, Math.max(0.8, (Math.min(end, timeline.start + 7 * DAY) - Math.max(s, timeline.start)) / (7 * DAY) * 100));
          return <button key={e.id} className={`tl-block ${statusOf(e, now).cls}`} style={{ left: `${left}%`, width: `${width}%` }} title={`${timeRange(e)} ${execTitle(e)} · ${statusOf(e, now).label}`} onClick={() => open(e)} />;
        })}</div>
      </div>) : <p className="empty">本周没有执行记录</p>}
    </section>}
    <section className="day-log">
      <h2>{selected === today ? "今天" : selected} 的执行日志（{dayLog.length}）</h2>
      {dayLog.length ? <ul className="list">{dayLog.map(e => {
        const st = statusOf(e, now);
        return <li key={e.id}><button className="entity-row" onClick={() => open(e)}>
          <span className="entity-main">
            <strong>{execTitle(e)}</strong>
            <span className="dim">{timeRange(e)} · {execMeta(e)}{st.detail ? ` · ${st.detail}` : ""}</span>
            {st.detail && st.cls === "failed" && <span className="dim exec-error">{st.detail}</span>}
          </span>
          <span className={`exec-status ${st.cls}`}>{st.label}</span>
        </button></li>;
      })}</ul> : <p className="empty">这一天没有执行记录</p>}
    </section>
  </div>;
}
