import { useEffect, useMemo, useState } from "react";
import type { ActivityBucket, Api, Execution, Goal, Session, Task } from "./lib/api";
import { AGENT_LABEL } from "./lib/agents";

const pad = (n: number) => String(n).padStart(2, "0");
const DAY = 86_400_000;
/** 服务端活动桶粒度：5 分钟 */
const BUCKET = 5 * 60_000;
/** 相邻活动桶间隔不超过这个值就算同一段（中间没人动才断开） */
const MERGE_GAP = 10 * 60_000;
const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const hm = (iso: string) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
/** 本周周一 0 点 */
const weekStart = (d: Date) => { const s = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (d.getDay() + 6) % 7); return s; };
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
/** 日视图缩放档位：可视窗口小时数，24 = 全天 */
const ZOOM_LEVELS = [24, 12, 6, 3];
const WEEKDAY_FULL = ["日", "一", "二", "三", "四", "五", "六"];
/** 2026 年 11 月 3 日 周二 */
const dayLabel = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return `${y} 年 ${m} 月 ${d} 日 周${WEEKDAY_FULL[new Date(y, m - 1, d).getDay()]}`;
};
type DayStat = { total: number; done: number; failed: number; sessions: number };
const EMPTY_STAT: DayStat = { total: 0, done: 0, failed: 0, sessions: 0 };

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

/**
 * 计划区间：任务的 startAt→dueAt，或目标的跨度。
 * start/end 为 null 表示只设了一端——轨道上要画成"敞口"，不能假装有起止。
 */
type PlanInfo = {
  start: number | null;
  end: number | null;
  due: number | null;
  done: number | null;
  status: Task["status"] | "goal";
  overdue: boolean;
  /** 目标没填日期，跨度是从子任务推导出来的 */
  derived?: boolean;
};
/** 时间轴的一行：任务（计划+执行）、纯会话（活动分段）、目标（跨度带） */
type TlRow = {
  key: string;
  kind: "task" | "session" | "goal";
  label: string;
  runs: CalItem[];
  sessionIds: string[];
  marker?: CalItem;
  plan?: PlanInfo;
  /** 没有可画区间时，只标出完成时刻 */
  doneMark?: number;
  taskId?: number;
  goalId?: number;
  sort: number;
};

export default function CalendarView({ api, sessions, tasks, goals, runSignal, onOpenSession, onOpenTask, onOpenGoal }: { api: Api; sessions: Session[]; tasks: Task[]; goals: Goal[]; runSignal: number; onOpenSession(id: string): void; onOpenTask(id: number): void; onOpenGoal(id: number): void }) {
  const today = dateKey(new Date());
  const [cursor, setCursor] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [selected, setSelected] = useState(today);
  // 默认落在"日"粒度的时间轴：打开就是今天这一条时间线，不用先切两次视图
  const [mode, setMode] = useState<"month" | "timeline">("timeline");
  const [scale, setScale] = useState<"week" | "day">("day");
  // 日视图缩放：zoomH 是可视窗口的小时数（24=全天），viewOffset 是窗口相对当日 0 点的偏移
  const [zoomH, setZoomH] = useState(24);
  const [viewOffset, setViewOffset] = useState(0);
  const isDayView = mode === "timeline" && scale === "day";
  const isWeekView = mode === "timeline" && scale === "week";
  const [execs, setExecs] = useState<Execution[]>([]);
  const [activity, setActivity] = useState<ActivityBucket[]>([]);
  const [showDone, setShowDone] = useState(false);
  const [showUnsched, setShowUnsched] = useState(false);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 30000); return () => window.clearInterval(t); }, []);

  /**
   * 拉取区间：月历看整月；时间轴按视图窗口（日 / 周）取，且与当月取并集——
   * 日视图往前翻到上月最后一天时，数据不能因为"当月"而缺失。
   */
  const range = useMemo(() => {
    const mFrom = new Date(cursor.y, cursor.m, 1).getTime();
    const mTo = new Date(cursor.y, cursor.m + 1, 1).getTime();
    if (mode !== "timeline") return { from: mFrom, to: mTo };
    const [y, m, d] = selected.split("-").map(Number);
    const base = new Date(y, m - 1, d);
    const start = scale === "day" ? base.getTime() : weekStart(base).getTime();
    const end = start + (scale === "day" ? DAY : 7 * DAY);
    return { from: Math.min(mFrom, start), to: Math.max(mTo, end) };
  }, [cursor, mode, scale, selected]);

  // 拉取区间内的执行记录（含跨区间边界仍在执行的记录）；执行事件推送时重新拉取
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.executions(new Date(range.from).toISOString(), new Date(range.to - 1).toISOString())
      .then(r => { if (alive) { setExecs(r.executions); setErr(""); } })
      .catch(e => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api, range, runSignal]);

  // 会话真实活动分布：消息时间戳按 5 分钟聚合（老服务端没有这个接口时退化为空，画刻度点）
  useEffect(() => {
    let alive = true;
    api.activity(new Date(range.from).toISOString(), new Date(range.to - 1).toISOString())
      .then(r => { if (alive) setActivity(r.activity); })
      .catch(() => { if (alive) setActivity([]); });
    return () => { alive = false; };
  }, [api, range, runSignal]);

  // 把活动桶合并成片段：间隔 ≤ MERGE_GAP 视为同一次连续工作
  const segments = useMemo(() => {
    const map = new Map<string, { start: number; end: number; count: number }[]>();
    const sorted = [...activity].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    for (const b of sorted) {
      const t = Date.parse(b.at);
      const list = map.get(b.sessionId) ?? map.set(b.sessionId, []).get(b.sessionId)!;
      const last = list[list.length - 1];
      if (last && t - last.end <= MERGE_GAP) { last.end = Math.max(last.end, t + BUCKET); last.count += b.count; }
      else list.push({ start: t, end: t + BUCKET, count: b.count });
    }
    return map;
  }, [activity]);

  // 拉取区间内有活动的会话（最后活动时间落在区间内）——终端里直接开的会话没有 run 记录，也要出现在日历
  const sessionItems = useMemo(() => sessions
    .map(sessionItem)
    .filter(e => { const t = itemAt(e); return t >= range.from && t < range.to; }), [sessions, range]);

  // 每天汇总：执行按开始日期归属，会话按最后活动归属
  const byDay = useMemo(() => {
    const map = new Map<string, DayStat>();
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

  // 统计只算当月（拉取区间可能比当月大），日历热度也按当月峰值归一化
  const monthPrefix = `${cursor.y}-${pad(cursor.m + 1)}`;
  const monthDays = new Date(cursor.y, cursor.m + 1, 0).getDate();
  const monthStat = useMemo(() => {
    const acc = { ...EMPTY_STAT };
    for (let d = 1; d <= monthDays; d++) {
      const c = byDay.get(`${monthPrefix}-${pad(d)}`);
      if (!c) continue;
      acc.total += c.total; acc.done += c.done; acc.failed += c.failed; acc.sessions += c.sessions;
    }
    return acc;
  }, [byDay, monthPrefix, monthDays]);
  const maxCount = Math.max(1, ...Array.from({ length: monthDays }, (_, i) => {
    const c = byDay.get(`${monthPrefix}-${pad(i + 1)}`);
    return c ? c.total + c.sessions : 0;
  }));

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

  // 时间轴：周（7 天）或日（24 小时）粒度。
  // 行 = 任务（计划区间 + 真实执行）／纯会话（消息活动分段）／目标（跨度带，排在最上面）
  const timeline = useMemo(() => {
    const [y, m, d] = selected.split("-").map(Number);
    const start = scale === "day" ? new Date(y, m - 1, d).getTime() : weekStart(new Date(y, m - 1, d)).getTime();
    const span = scale === "day" ? DAY : 7 * DAY;
    const end = start + span;
    const rows = new Map<string, TlRow>();
    const labelOf = (e: CalItem) => `${execTitle(e)}${e.agent ? ` · ${AGENT_LABEL[e.agent]}` : ""}`;
    const planOf = (startAt: string | null, dueAt: string | null, doneAt: string | null, status: Task["status"]): PlanInfo | null => {
      const s = startAt ? Date.parse(startAt) : null, e = dueAt ? Date.parse(dueAt) : null;
      if (s === null && e === null) return null;
      return { start: s, end: e, due: e, done: doneAt ? Date.parse(doneAt) : null, status, overdue: e !== null && e < now && status !== "done" };
    };
    // 只设一端时按视图边界延伸，所以重叠判断也要按延伸后的区间算
    const inView = (p: PlanInfo) => (p.end ?? end) >= start && (p.start ?? start) < end;

    for (const e of execs) {
      if (Date.parse(e.createdAt) >= end || endOf(e, now) < start) continue;
      const key = e.taskId ? `task-${e.taskId}` : `session-${e.sessionId ?? e.id}`;
      let row = rows.get(key);
      if (!row) {
        row = { key, kind: e.taskId ? "task" : "session", label: labelOf(e), runs: [], sessionIds: [], taskId: e.taskId ?? undefined, sort: Date.parse(e.createdAt) };
        rows.set(key, row);
      }
      row.runs.push(e);
      if (e.sessionId && !row.sessionIds.includes(e.sessionId)) row.sessionIds.push(e.sessionId);
      row.sort = Math.min(row.sort, Date.parse(e.createdAt));
    }

    for (const t of tasks) {
      const plan = planOf(t.startAt, t.dueAt, t.doneAt, t.status);
      const doneAt = t.doneAt ? Date.parse(t.doneAt) : null;
      // 在本视图内完成的任务必须留痕：刚勾完就整行消失，会让人以为任务丢了
      const doneHere = doneAt !== null && doneAt >= start && doneAt < end;
      const key = `task-${t.id}`;
      let row = rows.get(key);
      // 既没有落在视图内的计划、又不是在本视图完成的（且没有执行记录），时间轴上没有它的位置
      if (!row && !doneHere && !(plan && inView(plan))) continue;
      // 完成时间早于本视图的旧任务默认折叠，否则时间轴会被历史任务铺满
      if (!row && t.status === "done" && !doneHere && !showDone) continue;
      if (!row) {
        row = { key, kind: "task", label: t.title, runs: [], sessionIds: [], taskId: t.id, sort: start };
        rows.set(key, row);
      }
      if (plan && inView(plan)) {
        row.plan = plan;
        row.sort = Math.min(row.sort, plan.start ?? plan.due ?? start);
      } else if (doneAt !== null && doneHere) {
        // 计划在视图外（或没填日期）：只在完成时刻画一个标记
        row.doneMark = doneAt;
        row.sort = Math.min(row.sort, doneAt);
      }
      row.label = t.title;
      row.taskId = t.id;
      for (const sid of t.sessionIds) if (!row.sessionIds.includes(sid)) row.sessionIds.push(sid);
    }

    for (const e of sessionItems) {
      const t = itemAt(e);
      if (t < start || t >= end) continue;
      const key = `session-${e.sessionId}`;
      if (rows.has(key)) continue; // 已有 run 记录，起止更精确，不再叠加会话合成条目
      rows.set(key, { key, kind: "session", label: labelOf(e), runs: [], sessionIds: e.sessionId ? [e.sessionId] : [], marker: e, sort: t });
    }

    const goalRows: TlRow[] = [];
    for (const g of goals) {
      if (g.status === "archived") continue;
      const kids = tasks.filter(t => t.goalId === g.id);
      const kidStarts = kids.map(t => t.startAt).filter((v): v is string => !!v).map(Date.parse);
      const kidDues = kids.map(t => t.dueAt).filter((v): v is string => !!v).map(Date.parse);
      const gs = g.startAt ? Date.parse(g.startAt) : kidStarts.length ? Math.min(...kidStarts) : null;
      const ge = g.dueAt ? Date.parse(g.dueAt) : kidDues.length ? Math.max(...kidDues) : null;
      if (gs === null && ge === null) continue;
      const plan: PlanInfo = {
        start: gs, end: ge, due: ge, done: g.doneAt ? Date.parse(g.doneAt) : null,
        status: "goal", overdue: ge !== null && ge < now && g.status !== "done",
        derived: !g.startAt && !g.dueAt,
      };
      if (!inView(plan)) continue;
      goalRows.push({ key: `goal-${g.id}`, kind: "goal", label: g.title, runs: [], sessionIds: [], plan, goalId: g.id, sort: gs ?? ge ?? start });
    }

    const bySort = (a: TlRow, b: TlRow) => a.sort - b.sort;
    const list = [...rows.values()];
    return {
      start, span,
      hasGoal: goalRows.length > 0,
      rows: [...goalRows.sort(bySort), ...list.filter(r => r.kind === "task").sort(bySort), ...list.filter(r => r.kind !== "task").sort(bySort)],
    };
  }, [execs, sessionItems, selected, scale, now, tasks, goals, showDone]);

  // 没有开始也没有截止的任务：时间轴上没有坐标，收进"未排期"抽屉
  const unscheduled = useMemo(() => tasks
    .filter(t => t.status !== "done" && !t.startAt && !t.dueAt)
    .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt)), [tasks]);

  const shiftMonth = (delta: number) => {
    const next = new Date(cursor.y, cursor.m + delta, 1);
    setCursor({ y: next.getFullYear(), m: next.getMonth() });
    const t = dateKey(new Date());
    setSelected(t.startsWith(`${next.getFullYear()}-${pad(next.getMonth()+1)}`) ? t : `${next.getFullYear()}-${pad(next.getMonth()+1)}-01`);
  };
  /** 按天平移选中日（跨月时同步 cursor，否则新的一天没有数据） */
  const shiftDay = (delta: number) => {
    const [y, m, d] = selected.split("-").map(Number);
    const next = new Date(y, m - 1, d + delta);
    setSelected(dateKey(next));
    if (next.getFullYear() !== cursor.y || next.getMonth() !== cursor.m) setCursor({ y: next.getFullYear(), m: next.getMonth() });
  };
  /** 上一页 / 下一页：月历翻月，周视图翻周，日视图翻日 */
  const shiftPeriod = (delta: number) => {
    if (isDayView) shiftDay(delta);
    else if (isWeekView) shiftDay(delta * 7);
    else shiftMonth(delta);
  };
  const timeRange = (e: CalItem) => {
    if (e.sessionState) return `最后活动 ${hm(e.createdAt)}`;
    const s = hm(e.createdAt);
    if (e.status === "queued" || e.status === "running") return `${s}–至今`;
    const end = new Date(e.updatedAt);
    return dateKey(end) === dateKey(new Date(e.createdAt)) ? `${s}–${hm(e.updatedAt)}` : `${s}–${dateKey(end).slice(5)} ${hm(e.updatedAt)}`;
  };

  // 日视图缩放窗口：数据始终按整日取，渲染只画可视窗口——缩放/平移不需要重新拉取
  const viewSpan = isDayView ? zoomH * 3600_000 : timeline.span;
  const maxOffset = isDayView ? DAY - viewSpan : 0;
  const clampedOffset = Math.min(maxOffset, Math.max(0, viewOffset));
  const viewStart = timeline.start + clampedOffset;
  const viewEnd = viewStart + viewSpan;
  const pct = (t: number) => Math.min(100, Math.max(0, (t - viewStart) / viewSpan * 100));
  /** 放大 / 缩小：dir=1 放大（窗口变小），以当前窗口中心为锚点，避免内容跳走 */
  const zoomStep = (dir: 1 | -1) => {
    const idx = ZOOM_LEVELS.indexOf(zoomH);
    const next = ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, idx + dir))];
    if (next === zoomH) return;
    const center = viewStart + viewSpan / 2;
    const span = next * 3600_000;
    setZoomH(next);
    setViewOffset(Math.min(DAY - span, Math.max(0, center - span / 2 - timeline.start)));
  };
  /** 半窗平移 */
  const panDay = (dir: -1 | 1) => setViewOffset(Math.min(maxOffset, Math.max(0, clampedOffset + dir * viewSpan / 2)));
  // 刻度间隔随缩放档位变细：24h→3h，12h→2h，6h→1h，3h→30min
  const tickMs = viewSpan > 12 * 3600_000 ? 3 * 3600_000 : viewSpan > 6 * 3600_000 ? 2 * 3600_000 : viewSpan > 3 * 3600_000 ? 3600_000 : 1800_000;
  const tickCount = Math.round(viewSpan / tickMs);
  const md = (t: number) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };
  const planRange = (p: PlanInfo) => `${p.start !== null ? md(p.start) : "未定起"} – ${p.end !== null ? md(p.end) : "未定止"}`;
  const TASK_LABEL: Record<Task["status"], string> = { todo: "待办", doing: "进行中", review: "待验收", done: "已完成" };

  // 视图名称与标题：月历按月、周视图按周、日视图按日
  const [selY, selM, selD] = selected.split("-").map(Number);
  const selDate = new Date(selY, selM - 1, selD);
  const weekFrom = weekStart(selDate), weekTo = new Date(weekFrom.getTime() + 6 * DAY);
  const navTitle = isDayView
    ? `${selected === today ? "今天 · " : ""}${dayLabel(selected)}`
    : isWeekView
      ? `${weekFrom.getFullYear()} 年 ${weekFrom.getMonth() + 1} 月 ${weekFrom.getDate()} 日 – ${weekTo.getMonth() + 1} 月 ${weekTo.getDate()} 日`
      : `${cursor.y} 年 ${cursor.m + 1} 月`;
  const navPrev = isDayView ? "前一日" : isWeekView ? "上一周" : "上个月";
  const navNext = isDayView ? "后一日" : isWeekView ? "下一周" : "下个月";
  const weekStat = Array.from({ length: 7 }, (_, i) => byDay.get(dateKey(new Date(weekFrom.getTime() + i * DAY))) ?? EMPTY_STAT)
    .reduce((a, c) => ({ total: a.total + c.total, done: a.done + c.done, failed: a.failed + c.failed, sessions: a.sessions + c.sessions }), { ...EMPTY_STAT });
  const scoped = isDayView ? (byDay.get(selected) ?? EMPTY_STAT) : isWeekView ? weekStat : monthStat;
  const scopedLabel = isDayView ? `${selM} 月 ${selD} 日` : isWeekView ? `${md(weekFrom.getTime())} – ${md(weekTo.getTime())}` : `${cursor.y} 年 ${cursor.m + 1} 月`;

  return <div className="calendar-panel">
    <div className="page-heading"><div><p className="eyebrow">按日期组织的工作执行看板</p><h2>日历</h2><p>{loading ? "加载中…" : `${scopedLabel}：执行 ${scoped.total} · 会话 ${scoped.sessions} · 完成 ${scoped.done} · 失败 ${scoped.failed}`}</p></div>
      <div className="action-bar">
        {mode === "timeline" && <div className="seg" role="group" aria-label="时间轴粒度"><button className={scale === "week" ? "active" : ""} onClick={() => setScale("week")}>周</button><button className={scale === "day" ? "active" : ""} onClick={() => setScale("day")}>日</button></div>}
        <div className="seg"><button className={mode === "month" ? "active" : ""} onClick={() => setMode("month")}>月历</button><button className={mode === "timeline" ? "active" : ""} onClick={() => setMode("timeline")}>时间轴</button></div>
      </div>
    </div>
    {err && <p className="form-error" role="alert">{err}</p>}
    <div className="calendar-nav">
      <button onClick={() => shiftPeriod(-1)} aria-label={navPrev} title={navPrev}>←</button>
      <strong>{navTitle}</strong>
      <button onClick={() => shiftPeriod(1)} aria-label={navNext} title={navNext}>→</button>
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
    </section> : <section className="cal-timeline" style={isDayView ? { "--tf": String(tickMs / viewSpan) } as React.CSSProperties : undefined}>
      {isDayView && <div className="tl-toolbar">
        <span className="tl-zoom-label">{zoomH >= 24 ? "全天" : `可见 ${zoomH} 小时`}</span>
        <div className="seg tl-zoom" role="group" aria-label="时间轴缩放">
          <button onClick={() => panDay(-1)} disabled={clampedOffset <= 0} aria-label="向前平移" title="向前平移">‹</button>
          <button onClick={() => panDay(1)} disabled={clampedOffset >= maxOffset} aria-label="向后平移" title="向后平移">›</button>
          <button onClick={() => zoomStep(1)} disabled={zoomH <= ZOOM_LEVELS[ZOOM_LEVELS.length - 1]} aria-label="放大" title="放大">＋</button>
          <button onClick={() => zoomStep(-1)} disabled={zoomH >= ZOOM_LEVELS[0]} aria-label="缩小" title="缩小">－</button>
        </div>
      </div>}
      <div className={`tl-axis${scale === "day" ? " hours" : ""}`} style={scale === "day" ? { gridTemplateColumns: `repeat(${tickCount}, 1fr)` } : undefined}>{scale === "week"
        ? Array.from({ length: 7 }, (_, i) => { const d = new Date(timeline.start + i * DAY); return <span key={i} className={dateKey(d) === today ? "today" : ""}>{`${d.getMonth()+1}/${d.getDate()}`}</span>; })
        : Array.from({ length: tickCount }, (_, i) => { const d = new Date(viewStart + i * tickMs); return <span key={i} className={dateKey(d) === today ? "today" : ""}>{`${pad(d.getHours())}:${pad(d.getMinutes())}`}</span>; })}</div>
      <div className="tl-legend">
        <span><i className="lg-plan" aria-hidden="true"/>计划</span>
        <span><i className="lg-act" aria-hidden="true"/>实际执行</span>
        <span><i className="lg-due" aria-hidden="true"/>截止</span>
        <span><i className="lg-done" aria-hidden="true"/>完成</span>
        <label className="tl-check" title="计划跨越当前视图、但完成时间更早的任务；在本视图内完成的始终显示"><input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)}/>显示已完成的旧任务</label>
      </div>
      <div className="tl-rows">
      {timeline.rows.length ? timeline.rows.map(row => {
        // 目标：跨度带，不占任务行
        if (row.kind === "goal" && row.plan) {
          const p = row.plan;
          const from = Math.max(viewStart, p.start ?? viewStart);
          const to = Math.min(viewEnd, p.end ?? viewEnd);
          const left = pct(from), width = Math.max(1, pct(to) - pct(from));
          const cls = p.overdue ? "overdue" : p.done !== null ? "done" : "active";
          if (to <= viewStart || from >= viewEnd) return null; // 跨度不在可视窗口内
          return <div className="tl-row goal" key={row.key}>
            <span className="tl-label" title={row.label}>{row.label}</span>
            <div className={`tl-track${scale === "day" ? " hours" : ""}`}>
              <button className={`tl-goal ${cls}`} style={{ left: `${left}%`, width: `${width}%` }}
                title={`目标 ${planRange(p)}${p.derived ? "（按子任务推导）" : ""}${p.done !== null ? ` · 完成于 ${md(p.done)}` : p.overdue ? " · 已逾期" : ""}`}
                onClick={() => row.goalId && onOpenGoal(row.goalId)}>
                {width > 14 && <span>{planRange(p)}</span>}
              </button>
            </div>
          </div>;
        }
        // 任务/会话：上层计划，下层实际
        const segs = row.runs.length ? [] : row.sessionIds
          .flatMap(id => segments.get(id) ?? [])
          .filter(sg => sg.end > viewStart && sg.start < viewEnd)
          .sort((a, b) => a.start - b.start);
        const markerState = row.marker ? statusOf(row.marker, now) : null;
        const sessionId = row.sessionIds[0];
        const clampPos = (s: number, e: number) => {
          const left = pct(s), right = pct(e);
          return { left, width: Math.max(0.8, Math.min(100 - left, right - left)) };
        };
        const p = row.plan;
        const plan = p ? (() => {
          const left = pct(Math.max(viewStart, p.start ?? viewStart));
          const right = pct(Math.min(viewEnd, p.end ?? viewEnd));
          // 计划完全在可视窗口外时不画，避免在边缘出现误导性的细条
          return { left, width: Math.max(0.8, right - left), openStart: p.start === null, openEnd: p.end === null, visible: right > 0 && left < 100 };
        })() : null;
        const planCls = p ? (p.overdue ? "overdue" : p.done !== null ? "done" : p.status) : "";
        return <div className={`tl-row${p ? " has-plan" : ""}`} key={row.key}>
          <span className="tl-label" title={row.label}>{row.label}</span>
          <div className={`tl-track${scale === "day" ? " hours" : ""}`}>
            {p && plan && plan.visible && <button className={`tl-plan ${planCls}${plan.openStart ? " open-start" : ""}${plan.openEnd ? " open-end" : ""}`}
              style={{ left: `${plan.left}%`, width: `${plan.width}%` }}
              title={`${p.overdue ? "已逾期 · " : ""}计划 ${planRange(p)}${p.done !== null ? ` · 完成于 ${md(p.done)}` : ""}`}
              onClick={() => row.taskId && onOpenTask(row.taskId)} />}
            {p && p.due !== null && p.due >= viewStart && p.due <= viewEnd &&
              <span className={`tl-due${p.overdue ? " overdue" : p.done !== null ? " done" : ""}`} style={{ left: `${pct(p.due)}%` }} aria-hidden="true"/>}
            {p && p.done !== null && p.done >= viewStart && p.done <= viewEnd &&
              <span className="tl-done-flag" style={{ left: `${pct(p.done)}%` }} aria-hidden="true"/>}
            {row.doneMark !== undefined && row.doneMark >= viewStart && row.doneMark <= viewEnd &&
              <span className="tl-done-mark" style={{ left: `${pct(row.doneMark)}%` }} title={`完成于 ${md(row.doneMark)} ${hm(new Date(row.doneMark).toISOString())}`} aria-hidden="true"/>}
            {row.runs.filter(e => endOf(e, now) > viewStart && itemAt(e) < viewEnd).map(e => {
              const st = statusOf(e, now);
              const { left, width } = clampPos(itemAt(e), endOf(e, now));
              return <button key={e.id} className={`tl-block ${st.cls}`} style={{ left: `${left}%`, width: `${width}%` }} title={`${timeRange(e)} ${execTitle(e)} · ${st.label}`} onClick={() => open(e)} />;
            })}
            {segs.map(sg => {
              const { left, width } = clampPos(sg.start, Math.min(sg.end, viewEnd));
              return <button key={sg.start} className={`tl-block act${markerState?.cls === "running" ? " running" : ""}`} style={{ left: `${left}%`, width: `${width}%` }}
                title={`活动 ${hm(new Date(sg.start).toISOString())}–${hm(new Date(Math.min(sg.end, viewEnd)).toISOString())} · ${sg.count} 条消息`}
                onClick={() => sessionId && onOpenSession(sessionId)} />;
            })}
            {!row.runs.length && !segs.length && row.marker && itemAt(row.marker) >= viewStart && itemAt(row.marker) <= viewEnd && (() => {
              const { left } = clampPos(itemAt(row.marker), itemAt(row.marker));
              // 标记点代表"最后活动"这个时刻，右边缘贴住该时刻（向左延展），否则看起来像是发生在之后
              return <button className="tl-block act stopped point" style={{ left: `${left}%`, width: "0.8%" }} title={`最后活动 ${hm(row.marker.createdAt)} · 无活动明细`} onClick={() => sessionId && onOpenSession(sessionId)} />;
            })()}
          </div>
        </div>;
      }) : <p className="empty">{scale === "day" ? "这一天" : "本周"}没有计划、执行或会话记录</p>}
      {/* 当前时间竖线：放在行容器里，用和轨道完全相同的栅格（标签列 + 8px 间隔）定位，避免像素级偏移 */}
      {scale === "day" && selected === today && now >= viewStart && now < viewEnd &&
        <div className="tl-now-layer" aria-hidden="true">
          <span className="tl-now-gutter" />
          <span className="tl-now-rail"><span className="tl-now" style={{ left: `${pct(now)}%` }} /></span>
        </div>}
      </div>
    </section>}
    {mode === "timeline" && unscheduled.length > 0 && <section className="tl-unsched">
      <button className="tl-unsched-head" onClick={() => setShowUnsched(v => !v)} aria-expanded={showUnsched}>
        <strong>未排期 {unscheduled.length}</strong>
        <span className="dim">没有开始或截止时间，放不到时间轴上</span>
        <span className="tl-unsched-caret">{showUnsched ? "收起" : "展开"}</span>
      </button>
      {showUnsched && <ul className="list">{unscheduled.map(t => <li key={t.id}>
        <button className="entity-row" onClick={() => onOpenTask(t.id)}>
          <span className="entity-main">
            <strong>{t.title}</strong>
            <span className="dim">{TASK_LABEL[t.status]}{t.checklist.length ? ` · 清单 ${t.checklist.filter(c => c.done).length}/${t.checklist.length}` : ""} · 最后更新 {md(Date.parse(t.updatedAt))}</span>
          </span>
          <span className="exec-status queued">待排期</span>
        </button>
      </li>)}</ul>}
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
