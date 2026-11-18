import { useEffect, useMemo, useRef, useState } from "react";
import type { Api, StatsBy, StatsGranularity, StatsMetrics, StatsResponse } from "./lib/api";
import { AGENT_LABEL } from "./lib/agents";

type Series = StatsResponse["series"];

const GRAN_LABEL: Record<StatsGranularity, string> = { day: "日", week: "周", month: "月" };
/** 范围预设：count = 周期个数 */
const PRESETS: Record<StatsGranularity, { label: string; count: number }[]> = {
  day: [{ label: "近 14 天", count: 14 }, { label: "近 30 天", count: 30 }, { label: "近 90 天", count: 90 }],
  week: [{ label: "近 12 周", count: 12 }, { label: "近 26 周", count: 26 }],
  month: [{ label: "近 12 个月", count: 12 }],
};
const BY_LABEL: Record<StatsBy, string> = { none: "不拆分", agent: "工具", project: "项目", model: "模型" };
const DAY = 86_400_000;
const DEFAULT_TZ = "Asia/Shanghai";

/** 统计时区下今天的 YYYY-MM-DD（en-CA 的日期格式恰好是 ISO） */
function todayIn(tz: string): string {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
  catch { return new Date().toISOString().slice(0, 10); }
}
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** 预设 -> from（服务端会再向下对齐到周一 / 1 号）；to 缺省 = 服务端今天 */
function presetFrom(g: StatsGranularity, count: number, tz: string): string {
  const today = Date.parse(`${todayIn(tz)}T00:00:00Z`);
  if (g === "day") return iso(today - (count - 1) * DAY);
  if (g === "week") return iso(today - (count - 1) * 7 * DAY);
  const d = new Date(today);
  return iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (count - 1), 1));
}

const nf = new Intl.NumberFormat("zh-CN");
function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return nf.format(Math.round(n));
}
function durText(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 1) return "不足 1 分钟";
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} 小时 ${m % 60} 分` : `${h} 小时`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} 天 ${h % 24} 小时` : `${d} 天`;
}
function costText(m: Pick<StatsMetrics, "costUsd" | "credits">): string {
  if (m.costUsd > 0) return `$${m.costUsd.toFixed(2)}`;
  if (m.credits > 0) return `${nf.format(Math.round(m.credits))} credits`;
  return "";
}
function periodLabel(p: string, g: StatsGranularity): string {
  return g === "day" ? p.slice(5) : g === "week" ? `${p.slice(5)} 周` : p.slice(0, 7);
}
const successRate = (m: StatsMetrics): number | null => {
  const den = m.runsDone + m.runsFailed + m.runsStopped;
  return den > 0 ? m.runsDone / den : null;
};
const avgDone = (m: StatsMetrics): number | null => (m.tasksDone > 0 ? m.taskDoneSeconds / m.tasksDone : null);

/** 环比：与上期比较，文字 + 箭头表达，不只靠颜色 */
function delta(cur: number | null, prev: number | null): { text: string; label: string } | null {
  if (cur === null) return null;
  if (!prev) return cur ? { text: "新增", label: "上期为 0，本期新增" } : { text: "持平", label: "与上期持平" };
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return { text: "持平", label: "与上期持平" };
  return pct > 0 ? { text: `↑${pct}%`, label: `比上期增加 ${pct}%` } : { text: `↓${-pct}%`, label: `比上期减少 ${-pct}%` };
}

function niceStep(max: number): number {
  return Math.max(1, Math.ceil(max / 4));
}

type Bar = { key: keyof StatsMetrics; label: string; cls: string };

/** 手写 SVG 柱状图：每个周期一组柱子，悬停 / 聚焦 / 点击显示具体数字 */
function BarChart({ title, series, bars, granularity }: { title: string; series: Series; bars: Bar[]; granularity: StatsGranularity }) {
  const [sel, setSel] = useState<number | null>(null);
  // 按容器实际宽度画：viewBox 与显示宽度 1:1，坐标轴文字才是真实的 11px（写死宽度会在手机上缩到 5-6px）
  const [width, setWidth] = useState(640);
  const svgRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const read = () => { const w = Math.round(el.getBoundingClientRect().width); if (w > 0) setWidth(w); };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const W = Math.max(240, width), H = 230, L = 40, R = 8, T = 10, B = 28;
  const pw = W - L - R, ph = H - T - B;
  const max = Math.max(0, ...series.flatMap(s => bars.map(b => s[b.key])));
  const step = niceStep(max);
  const top = step * 4;
  const gw = pw / Math.max(series.length, 1);
  const bw = Math.max(2, Math.min(18, (gw * 0.72) / bars.length));
  // x 轴标签：每个至少留 60px，太密就隔几个标一个
  const every = Math.ceil(series.length / Math.max(2, Math.floor(pw / 60)));
  const text = (i: number) => `${periodLabel(series[i].period, granularity)}：${bars.map(b => `${b.label} ${nf.format(series[i][b.key])}`).join("，")}`;
  const summary = `${title}柱状图，共 ${series.length} 个周期；` + bars.map(b => `${b.label}合计 ${nf.format(series.reduce((a, s) => a + s[b.key], 0))}`).join("，");
  return (
    <section className="stats-chart">
      <div className="stats-chart-head">
        <h3>{title}</h3>
        <span className="stats-legend">{bars.map(b => <span key={b.key}><i className={b.cls} />{b.label}</span>)}</span>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} className="stats-svg">
        {[0, 1, 2, 3, 4].map(k => {
          const y = T + ph - (ph * k) / 4;
          return <g key={k}><line x1={L} x2={W - R} y1={y} y2={y} className="stats-grid" /><text x={L - 6} y={y + 4} textAnchor="end" className="stats-tick">{compact(step * k)}</text></g>;
        })}
        {series.map((s, i) => {
          const gx = L + gw * i + gw / 2;
          return (
            <g key={s.period} tabIndex={0} className={`stats-group${sel === i ? " sel" : ""}`} aria-label={text(i)}
              onMouseEnter={() => setSel(i)} onFocus={() => setSel(i)} onClick={() => setSel(i)}>
              <title>{text(i)}</title>
              <rect x={gx - gw / 2} y={T} width={gw} height={ph} className="stats-hit" />
              {bars.map((b, j) => {
                const h = top ? (ph * s[b.key]) / top : 0;
                const x = gx - (bw * bars.length) / 2 + bw * j;
                return <rect key={b.key} x={x} y={T + ph - h} width={bw - 1} height={h} rx={2} className={`stats-bar ${b.cls}`} />;
              })}
              {i % every === 0 && <text x={gx} y={H - 8} textAnchor="middle" className="stats-tick">{periodLabel(s.period, granularity)}</text>}
            </g>
          );
        })}
      </svg>
      <p className="stats-tip" aria-live="polite">{sel !== null && series[sel] ? text(sel) : "悬停、聚焦或点击柱子查看具体数字"}</p>
      <details className="stats-data">
        <summary>查看数据表</summary>
        <div className="stats-scroll">
          <table>
            <thead><tr><th>周期</th>{bars.map(b => <th key={b.key}>{b.label}</th>)}</tr></thead>
            <tbody>{series.map(s => <tr key={s.period}><td>{periodLabel(s.period, granularity)}</td>{bars.map(b => <td key={b.key}>{nf.format(s[b.key])}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

function Card({ title, value, sub, d }: { title: string; value: string; sub?: string; d: ReturnType<typeof delta> }) {
  return (
    <div className="stats-card">
      <span className="stats-card-title">{title}</span>
      <strong className="stats-card-value">{value}</strong>
      <span className="stats-card-sub">
        {d && <span className="stats-delta" aria-label={d.label}>{d.text}</span>}
        {sub && <span>{sub}</span>}
      </span>
    </div>
  );
}

export default function StatsView({ api, active }: { api: Api; active: boolean }) {
  const [gran, setGran] = useState<StatsGranularity>("day");
  const [presetIdx, setPresetIdx] = useState(0);
  const [by, setBy] = useState<StatsBy>("none");
  const [data, setData] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const tzRef = useRef(DEFAULT_TZ);
  const [reload, setReload] = useState(0);
  const seq = useRef(0);

  const preset = PRESETS[gran][Math.min(presetIdx, PRESETS[gran].length - 1)];

  useEffect(() => {
    if (!active) return;
    const my = ++seq.current;
    setLoading(true);
    setError("");
    api.stats({ from: presetFrom(gran, preset.count, tzRef.current), granularity: gran, by })
      .then(r => { if (my === seq.current) { tzRef.current = r.tz; setData(r); } })
      .catch(e => { if (my === seq.current) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (my === seq.current) setLoading(false); });
  }, [api, active, gran, preset.count, by, reload]);

  const empty = useMemo(() => {
    if (!data) return false;
    const t = data.totals;
    return t.sessionsNew + t.sessionsActive + t.runs + t.tasksCreated + t.tasksDone + t.reviewRejects === 0;
  }, [data]);

  const t = data?.totals, p = data?.previous.totals;
  const cumul = gran !== "day" ? "（按天累计）" : "";
  return (
    <div className="stats-view">
      <div className="page-heading"><div><p className="eyebrow">数据</p><h2>统计</h2><p>会话、运行和任务的数量与趋势。</p></div></div>
      <div className="stats-controls">
        <div className="seg" role="group" aria-label="统计粒度">
          {(["day", "week", "month"] as const).map(g => <button key={g} className={gran === g ? "active" : ""} aria-pressed={gran === g} onClick={() => { setGran(g); setPresetIdx(0); }}>{GRAN_LABEL[g]}</button>)}
        </div>
        <div className="seg" role="group" aria-label="范围">
          {PRESETS[gran].map((x, i) => <button key={x.label} className={presetIdx === i ? "active" : ""} aria-pressed={presetIdx === i} onClick={() => setPresetIdx(i)}>{x.label}</button>)}
        </div>
        <label className="stats-by">拆分
          <select value={by} onChange={e => setBy(e.target.value as StatsBy)}>
            {(Object.keys(BY_LABEL) as StatsBy[]).map(k => <option key={k} value={k}>{BY_LABEL[k]}</option>)}
          </select>
        </label>
      </div>

      {error && <p className="stats-error" role="alert">统计加载失败：{error} <button onClick={() => setReload(n => n + 1)}>重试</button></p>}
      {loading && !data && <p className="empty" role="status">加载中…</p>}
      {data && t && p && (
        <div className={loading ? "stats-body loading" : "stats-body"} aria-busy={loading}>
          {empty ? <p className="empty">这段时间没有数据</p> : (
            <>
              <div className="stats-cards">
                <Card title="会话新建" value={nf.format(t.sessionsNew)} sub={`活跃 ${nf.format(t.sessionsActive)}${cumul}`} d={delta(t.sessionsNew, p.sessionsNew)} />
                <Card title="任务完成" value={nf.format(t.tasksDone)} sub={`新建 ${nf.format(t.tasksCreated)}`} d={delta(t.tasksDone, p.tasksDone)} />
                <Card title="运行成功率" value={successRate(t) === null ? "—" : `${Math.round(successRate(t)! * 100)}%`} sub={`${nf.format(t.runs)} 次运行`} d={delta(successRate(t), successRate(p))} />
                <Card title="Token" value={compact(t.tokensIn + t.tokensOut)} sub={costText(t) || undefined} d={delta(t.tokensIn + t.tokensOut, p.tokensIn + p.tokensOut)} />
                <Card title="平均完成时长" value={avgDone(t) === null ? "—" : durText(avgDone(t)!)} d={delta(avgDone(t), avgDone(p))} />
                <Card title="验收打回" value={nf.format(t.reviewRejects)} d={delta(t.reviewRejects, p.reviewRejects)} />
              </div>
              <BarChart title="会话" series={data.series} granularity={gran} bars={[
                { key: "sessionsNew", label: "新建", cls: "b1" }, { key: "sessionsActive", label: gran === "day" ? "活跃" : "活跃（按天累计）", cls: "b2" }]} />
              <BarChart title="任务" series={data.series} granularity={gran} bars={[
                { key: "tasksCreated", label: "新建", cls: "b1" }, { key: "tasksDone", label: "完成", cls: "b2" }]} />
              {data.breakdown.by !== "none" && (
                <section className="stats-breakdown">
                  <h3>按{BY_LABEL[data.breakdown.by]}拆分</h3>
                  {data.breakdown.rows.length === 0 ? <p className="empty">没有可拆分的数据</p> : (
                    <div className="stats-scroll">
                      <table>
                        <thead><tr><th>{BY_LABEL[data.breakdown.by]}</th><th>运行</th><th>会话新建</th><th>任务新建 / 完成</th><th>Token</th><th>费用</th></tr></thead>
                        <tbody>{data.breakdown.rows.map(r => (
                          <tr key={r.key}>
                            <td>{r.key === "" ? (data.breakdown.by === "model" ? "默认" : "—") : data.breakdown.by === "agent" ? (AGENT_LABEL[r.key as keyof typeof AGENT_LABEL] ?? r.key) : r.key}</td>
                            <td>{nf.format(r.runs)}</td><td>{nf.format(r.sessionsNew)}</td>
                            <td>{nf.format(r.tasksCreated)} / {nf.format(r.tasksDone)}</td>
                            <td>{compact(r.tokensIn + r.tokensOut)}</td><td>{costText(r) || "—"}</td>
                          </tr>))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              )}
            </>
          )}
          <p className="stats-note">
            统计时区 {data.tz}（{data.from} 至 {data.to}）。会话数据最多回溯约 30 天，更早的只有运行和任务。
            {gran !== "day" && "周 / 月的活跃会话是各天活跃数之和，同一会话连续几天活跃会重复计入。"}
            当前任务：待办 {data.snapshot.todo} · 进行中 {data.snapshot.doing} · 待验收 {data.snapshot.review} · 已完成 {data.snapshot.done}。
          </p>
        </div>
      )}
    </div>
  );
}
