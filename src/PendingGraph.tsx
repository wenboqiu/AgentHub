import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "./lib/api";
import { AGENT_LABEL } from "./lib/agents";

const STATE_LABEL: Record<string, string> = { waiting: "等待授权", done: "已完成", aborted: "已中断", running: "运行中" };

/** 待处理气泡的文案：说明「要你做什么」，而不是复述 agent 的状态，避免和所在分区打架 */
const PENDING_LABEL: Record<string, string> = { waiting: "等待授权", done: "完成待确认", aborted: "中断待确认" };

/** 待处理气泡的配色：全用暖色表示「等你」，靠深浅区分谁更急 */
const PENDING_TONE: Record<string, string> = { waiting: "tone-wait", done: "tone-amber", aborted: "tone-abort" };

/** 项目气泡按项目名稳定取色；有待授权的用警示色 */
const TONES = ["tone-blue", "tone-teal", "tone-plum", "tone-amber"] as const;

function hash32(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
}

function hashTone(name: string): string {
  return TONES[hash32(name) % TONES.length];
}

/** 0–1 的稳定伪随机，用于布点抖动 / 漂移相位 */
function hash01(name: string, salt = 0): number {
  return (((hash32(name) + salt * 2654435761) >>> 8) % 1000) / 1000;
}

/** 气泡大小随会话数缩放（74–136px） */
function bubbleSize(count: number): number {
  return Math.round(Math.min(136, 74 + Math.sqrt(Math.max(count, 1)) * 22));
}

const GOLDEN_ANGLE = 2.39996; // 黄金角：散布均匀又不显网格感

type Group = { project: string; pending: Session[]; running: Session[] };

function groupByProject(sessions: Session[], approvals: Set<string>): Group[] {
  const m = new Map<string, Group>();
  for (const s of sessions) {
    const key = s.project || "(未知项目)";
    let g = m.get(key);
    if (!g) {
      g = { project: key, pending: [], running: [] };
      m.set(key, g);
    }
    // 运行中但有待授权的事项（approvals 里有）算「要你处理」，放外圈
    if (s.state === "running" && !approvals.has(s.id)) g.running.push(s);
    else g.pending.push(s);
  }
  return [...m.values()].sort(
    (a, b) =>
      b.pending.length - a.pending.length ||
      b.running.length - a.running.length ||
      b.pending.length + b.running.length - a.pending.length - a.running.length,
  );
}

const isUrgent = (s: Session, approvals: Set<string>) =>
  s.state === "waiting" || approvals.has(s.id);

type ScatterInput = { key: string; size: number };
type ScatterSpot = ScatterInput & { x: number; y: number };

/**
 * 在舞台内散布：第一颗放正中，其余从中心向外螺旋找第一个不重叠、不出界的位置。
 * 起始角由 key 哈希决定，所以看着随机但每次进来都一样。返回 ok=false 表示有一颗被挤到兜底位。
 */
function placeAll(items: ScatterInput[], wrapW: number, stageH: number) {
  const cx = wrapW / 2;
  const cy = stageH / 2;
  const maxD = Math.hypot(wrapW, stageH) / 2;
  const placed: { x: number; y: number; r: number }[] = [];
  const spots: ScatterSpot[] = [];
  let ok = true;

  items.forEach((it, i) => {
    const rad = it.size / 2 + 6; // +6 给呼吸光环、运行弧留余量
    let x = cx;
    let y = cy;
    if (i > 0) {
      const a0 = i * GOLDEN_ANGLE + hash01(it.key) * Math.PI * 2;
      let found: { x: number; y: number } | null = null;
      for (let d = rad + 12; d < maxD + rad * 2 && !found; d += 8) {
        // 沿圆周按约 42px 间距采样，保证不会有漏掉的空档
        const steps = Math.min(90, Math.max(14, Math.round((Math.PI * 2 * d) / 42)));
        for (let k = 0; k < steps; k++) {
          const a = a0 + (k / steps) * Math.PI * 2;
          const px = cx + Math.cos(a) * d;
          const py = cy + Math.sin(a) * d;
          if (px < rad + 6 || px > wrapW - rad - 6 || py < rad + 6 || py > stageH - rad - 6) continue;
          if (placed.every((p) => Math.hypot(p.x - px, p.y - py) >= p.r + rad + 14)) {
            found = { x: px, y: py };
            break;
          }
        }
      }
      if (found) {
        x = found.x;
        y = found.y;
      } else {
        ok = false;
        x = cx + (hash01(it.key, 5) - 0.5) * Math.max(wrapW - 2 * rad - 12, 0);
        y = cy + (hash01(it.key, 6) - 0.5) * Math.max(stageH - 2 * rad - 12, 0);
      }
    }
    placed.push({ x, y, r: rad });
    spots.push({ ...it, x: Math.round(x), y: Math.round(y) });
  });

  return { spots, ok };
}

/** 按面积估一个够用的舞台高度，装不下就逐步加高重排，直到没有一颗被挤到兜底位 */
function scatterStage(items: ScatterInput[], wrapW: number) {
  const w = Math.max(wrapW, 260);
  const need = items.reduce((sum, it) => sum + Math.PI * (it.size / 2 + 14) ** 2, 0);
  let stageH = Math.round(Math.max(260, Math.min(900, (need * 2.1) / Math.max(w - 44, 240) + 30)));
  let res = placeAll(items, w, stageH);
  for (let k = 0; k < 6 && !res.ok && stageH < 900; k++) {
    stageH = Math.min(900, Math.round(stageH * 1.18));
    res = placeAll(items, w, stageH);
  }
  return { ...res, stageH };
}

type Props = {
  /** 待处理 + 运行中的会话（不含已处理） */
  sessions: Session[];
  /** 已处理（已 ack 或已结束）的会话，收进底部小球带 */
  handled: Session[];
  /** 等待授权（手机/桌面确认）的会话 id，按最高优先级标色 */
  approvals: Set<string>;
  onOpen(id: string): void;
};

/**
 * 会话 · 图模式
 * 总览：每个项目一个气泡（大数字 = 待处理，虚环 + 胶囊 = 运行中），随机散布、各自漂移；
 * 展开：会话气泡同样随机散布（最急的靠中间），点击打开会话，项目名与计数移到顶部工具条；
 * 已处理：不进图，主图下方一个可折叠的纯列表。
 */
export default function PendingGraph({ sessions, handled, approvals, onOpen }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [handledOpen, setHandledOpen] = useState(false);

  const groups = useMemo(() => groupByProject(sessions, approvals), [sessions, approvals]);

  // 已处理只做列表：按更新时间倒序（App 传来的已是这个顺序，这里再稳一道）
  const handledList = useMemo(
    () => [...handled].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [handled],
  );

  // 散布布局与展开环半径都要知道容器宽度
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [wrapW, setWrapW] = useState(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWrapW(el.clientWidth));
    ro.observe(el);
    setWrapW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => {
    if (!wrapW || groups.length === 0) return null;
    // 贪心散布：大球先放中间，后面的球沿黄金角螺旋找第一个不重叠、不出界的位置；
    // 哈希抖动让布局看着随机，但每次进来都一样
    const stageH = Math.min(560, 300 + (groups.length - 1) * 46);
    const cx = wrapW / 2;
    const cy = Math.round(stageH / 2);
    const placed: { x: number; y: number; r: number }[] = [];
    const pos = groups.map((g, i) => {
      const size = bubbleSize(g.pending.length + g.running.length);
      // 带运行中胶囊的球下方要多占一截，碰撞间距相应放大，避免胶囊压到邻居
      const pad = g.running.length > 0 ? 12 : 0;
      const rad = size / 2 + pad;
      let x = cx;
      let y = cy;
      if (i > 0) {
        const a0 = i * GOLDEN_ANGLE + hash01(g.project) * 1.3;
        let found: { x: number; y: number } | null = null;
        for (let d = rad + 10; d < Math.max(wrapW, stageH) && !found; d += 7) {
          for (let k = 0; k < 14; k++) {
            const a = a0 + (k / 14) * Math.PI * 2 + hash01(g.project, k + 1) * 0.2;
            const px = cx + Math.cos(a) * d;
            const py = cy + Math.sin(a) * d * 0.8; // 纵向压扁，铺得更开
            if (px < rad + 6 || px > wrapW - rad - 6 || py < rad + 6 || py > stageH - rad - 6) continue;
            if (placed.every((p) => Math.hypot(p.x - px, p.y - py) >= p.r + rad + 18)) {
              found = { x: Math.round(px), y: Math.round(py) };
              break;
            }
          }
        }
        const spot = found ?? {
          x: Math.round(cx + (hash01(g.project, 5) - 0.5) * Math.max(wrapW - 2 * rad - 12, 0)),
          y: Math.round(cy + (hash01(g.project, 6) - 0.5) * Math.max(stageH - 2 * rad - 12, 0)),
        };
        x = spot.x;
        y = spot.y;
      }
      placed.push({ x, y, r: rad });
      return { g, size, x, y };
    });
    return { pos, stageH };
  }, [groups, wrapW]);

  const current = expanded ? groups.find((g) => g.project === expanded) : undefined;

  if (current) {
    const { pending, running } = current;
    const runIds = new Set(running.map((s) => s.id));
    const total = pending.length + running.length;
    // 会话多了就缩一点，保证同屏能铺开
    const size = total > 26 ? 70 : total > 14 ? 78 : 88;

    // 要你动手的排最中间（越靠中心越先被放到舞台中央），运行中的甩到外圈
    const rank = (s: Session) =>
      isUrgent(s, approvals) ? 0 : s.state === "aborted" ? 1 : runIds.has(s.id) ? 3 : 2;
    const entries = [...pending, ...running]
      .sort((a, b) => rank(a) - rank(b))
      .map((s) => ({ s, run: runIds.has(s.id), size: runIds.has(s.id) ? size - 8 : size }));

    const { spots, stageH } = scatterStage(entries.map((e) => ({ key: e.s.id, size: e.size })), wrapW || 900);

    return (
      <div className="pg-wrap" ref={wrapRef}>
        <div className="pg-toolbar">
          <button type="button" className="link" onClick={() => setExpanded(null)}>‹ 返回总览</button>
          <span className="pg-toolbar-name">{current.project}</span>
          <span className="pg-toolbar-chips">
            {pending.length > 0 && <span className="pg-chip tone-wait">{pending.length} 待处理</span>}
            {running.length > 0 && <span className="pg-chip tone-blue">{running.length} 运行中</span>}
          </span>
        </div>
        <div className="pg-stage" style={{ height: stageH }}>
          {entries.map((e, i) => {
            const spot = spots[i];
            const urgent = isUrgent(e.s, approvals);
            const tone = e.run ? "tone-blue" : urgent ? "tone-wait" : PENDING_TONE[e.s.state] ?? "tone-abort";
            const label = e.run ? "运行中" : PENDING_LABEL[e.s.state] ?? STATE_LABEL[e.s.state] ?? e.s.state;
            const tip = `${AGENT_LABEL[e.s.agent]} · ${label}\n${e.s.title || e.s.summary || e.s.id}`;
            const dur = (7 + hash01(e.s.id, 3) * 4).toFixed(2); // 每颗漂移节奏不同
            const delay = (-hash01(e.s.id, 4) * 10).toFixed(2);
            return (
              <button
                key={e.s.id}
                type="button"
                className="pg-slot pg-scatter-slot"
                style={{
                  width: e.size,
                  height: e.size,
                  left: spot.x,
                  top: spot.y,
                  marginLeft: -e.size / 2,
                  marginTop: -e.size / 2,
                }}
                title={tip}
                aria-label={`打开会话：${label}`}
                onClick={() => onOpen(e.s.id)}
              >
                <span className="pg-floater" style={{ animation: `pg-drift ${dur}s ease-in-out ${delay}s infinite` }}>
                  <span className={`pg-bubble pg-session ${tone}${e.run ? " pg-run" : ""}`} style={{ animationDelay: `${i * 50}ms` }}>
                    {e.run && <span className="pg-run-arc" />}
                    <span className="pg-state">{label}</span>
                    <span className="pg-title">{e.s.title || e.s.summary || "未命名会话"}</span>
                    <span className="pg-agent">{AGENT_LABEL[e.s.agent]}</span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        <p className="pg-legend">
          <span><i className="pg-dot tone-blue" />运行中</span>
          <span><i className="pg-dot tone-wait" />等待授权</span>
          <span><i className="pg-dot tone-amber" />完成待确认</span>
          <span><i className="pg-dot tone-abort" />中断待确认</span>
          <span>点击气泡打开会话</span>
        </p>
      </div>
    );
  }

  return (
    <div className="pg-wrap" ref={wrapRef}>
      <div className="pg-stage pg-scatter" style={{ height: layout?.stageH ?? 380 }}>
        {(layout?.pos ?? []).map(({ g, size, x, y }, i) => {
          const urgent = g.pending.some((s) => isUrgent(s, approvals));
          const dur = (7 + hash01(g.project, 3) * 4).toFixed(2); // 每个球漂移节奏不同
          const delay = (-hash01(g.project, 4) * 10).toFixed(2);
          return (
            <button
              key={g.project}
              type="button"
              className="pg-slot pg-scatter-slot"
              style={{ width: size, height: size, left: x, top: y, marginLeft: -size / 2, marginTop: -size / 2 }}
              title={`展开 ${g.project}：${g.pending.length} 个待处理${g.running.length ? ` · ${g.running.length} 个运行中` : ""}`}
              aria-label={`项目 ${g.project}，${g.pending.length} 个待处理，${g.running.length} 个运行中`}
              onClick={() => setExpanded(g.project)}
            >
              <span className="pg-floater" style={{ animation: `pg-drift ${dur}s ease-in-out ${delay}s infinite` }}>
                <span className={`pg-bubble ${urgent ? "tone-wait" : hashTone(g.project)}${g.pending.length === 0 ? " pg-idle" : ""}`} style={{ animationDelay: `${i * 60}ms` }}>
                  {g.running.length > 0 && <span className="pg-run-ring" />}
                  <span className={`pg-count${g.pending.length === 0 ? " pg-zero" : ""}`}>{g.pending.length}</span>
                  <span className="pg-name" title={g.project}>{g.project}</span>
                  {g.running.length > 0 && <span className="pg-pill">{g.running.length} 运行中</span>}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <p className="pg-legend">
        <span><i className="pg-dot tone-wait" />有待授权</span>
        <span><i className="pg-dot tone-blue" />待查看</span>
        <span><i className="pg-dot pg-dot-ring" />虚环 = 有运行中</span>
        <span>气泡大小 = 会话数量 · 点击展开项目</span>
      </p>

      {handledList.length > 0 && (
        <div className="pg-handled">
          <button
            type="button"
            className={`pg-handled-toggle${handledOpen ? " open" : ""}`}
            aria-expanded={handledOpen}
            onClick={() => setHandledOpen(!handledOpen)}
          >
            <span className="pg-caret" aria-hidden>›</span>
            已处理
            <span className="count dim">{handledList.length}</span>
          </button>
          {handledOpen && (
            <ul className="pg-handled-list">
              {handledList.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => onOpen(s.id)} title={s.title || s.summary || s.id}>
                    <span className={`tag ${s.agent}`}>{AGENT_LABEL[s.agent]}</span>
                    <span className="pg-hl-proj">{s.project || "(未知项目)"}</span>
                    <span className="pg-hl-title">{s.title || s.summary || s.id}</span>
                    <span className="pg-hl-state">{STATE_LABEL[s.state] ?? s.state}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
