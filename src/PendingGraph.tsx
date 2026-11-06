import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "./lib/api";
import { AGENT_LABEL } from "./lib/agents";

const STATE_LABEL: Record<string, string> = { waiting: "等待授权", done: "已完成", aborted: "已中断", running: "运行中" };

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
 * 展开：内圈运行中（旋转弧）、外圈待处理，点击会话气泡打开会话；
 * 已处理：主图下方淡色小球带，点击分组才展开历史。
 */
export default function PendingGraph({ sessions, handled, approvals, onOpen }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [handledOpen, setHandledOpen] = useState<string | null>(null);

  const groups = useMemo(() => groupByProject(sessions, approvals), [sessions, approvals]);

  const handledGroups = useMemo(() => {
    const m = new Map<string, Session[]>();
    for (const s of handled) {
      const key = s.project || "(未知项目)";
      const arr = m.get(key);
      if (arr) arr.push(s);
      else m.set(key, [s]);
    }
    return [...m.entries()]
      .map(([project, list]) => ({ project, sessions: list }))
      .sort((a, b) => b.sessions.length - a.sessions.length);
  }, [handled]);

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
    const twoRings = pending.length > 0 && running.length > 0;
    const R_OUT = Math.max(128, Math.min(180, (wrapW || 900) / 2 - 58));
    const R_IN = Math.round(R_OUT * 0.56);
    const rPending = twoRings ? R_OUT : Math.round(R_OUT * 0.78);
    const rRunning = twoRings ? R_IN : Math.round(R_OUT * 0.78);
    const stageH = 2 * (R_OUT + 54) + 32;
    const urgentProject = pending.some((s) => isUrgent(s, approvals));
    const total = pending.length + running.length;

    const orbit = (list: Session[], radius: number, size: number, kind: "pending" | "running") =>
      list.map((s, i) => {
        const n = list.length;
        const angle = (i / n) * Math.PI * 2 - Math.PI / 2 + (kind === "running" ? Math.PI / Math.max(n, 1) : 0);
        const x = Math.round(Math.cos(angle) * radius);
        const y = Math.round(Math.sin(angle) * radius);
        const urgent = isUrgent(s, approvals);
        const run = kind === "running";
        const tone = run ? "tone-blue" : urgent ? "tone-wait" : s.state === "done" ? "tone-done" : "tone-abort";
        const label = run ? "运行中" : STATE_LABEL[s.state] ?? s.state;
        const tip = `${AGENT_LABEL[s.agent]} · ${label}\n${s.title || s.summary || s.id}`;
        return (
          <button
            key={s.id}
            type="button"
            className="pg-slot pg-orbit"
            style={{ width: size, height: size, marginLeft: -size / 2, marginTop: -size / 2, transform: `translate(${x}px, ${y}px)` }}
            title={tip}
            aria-label={`打开会话：${label}`}
            onClick={() => onOpen(s.id)}
          >
            <span className="pg-floater" style={{ animationDelay: `${(i % 4) * 0.55}s` }}>
              <span className={`pg-bubble pg-session ${tone}${run ? " pg-run" : ""}`} style={{ animationDelay: `${i * 60}ms` }}>
                {run && <span className="pg-run-arc" />}
                <span className="pg-state">{label}</span>
                <span className="pg-agent">{AGENT_LABEL[s.agent]}</span>
              </span>
            </span>
          </button>
        );
      });

    return (
      <div className="pg-wrap" ref={wrapRef}>
        <div className="pg-toolbar">
          <button type="button" className="link" onClick={() => setExpanded(null)}>‹ 返回总览</button>
        </div>
        <div className="pg-stage" style={{ height: stageH }}>
          {orbit(pending, rPending, 86, "pending")}
          {orbit(running, rRunning, 76, "running")}
          <div className="pg-slot pg-center-slot" style={{ width: 96, height: 96, marginLeft: -48, marginTop: -48 }} aria-hidden>
            <span className="pg-floater" style={{ animationDelay: "0.3s" }}>
              <span className={`pg-bubble pg-center ${urgentProject ? "tone-wait" : "tone-blue"}`}>
                <span className="pg-count">{total}</span>
                <span className="pg-name">{current.project}</span>
              </span>
            </span>
          </div>
        </div>
        <p className="pg-legend">
          <span><i className="pg-dot tone-blue" />运行中（内圈）</span>
          <span><i className="pg-dot tone-wait" />等待授权</span>
          <span><i className="pg-dot tone-done" />已完成待确认</span>
          <span><i className="pg-dot tone-abort" />已中断待确认</span>
        </p>
      </div>
    );
  }

  const openHandled = handledGroups.find((h) => h.project === handledOpen);

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
                <span className={`pg-bubble ${urgent ? "tone-wait" : hashTone(g.project)}`} style={{ animationDelay: `${i * 60}ms` }}>
                  {g.running.length > 0 && <span className="pg-run-ring" />}
                  <span className={`pg-count${g.pending.length === 0 ? " pg-zero" : ""}`}>{g.pending.length}</span>
                  <span className="pg-name">{g.pending.length ? "待处理" : "无待处理"}</span>
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

      {handledGroups.length > 0 && (
        <div className="pg-handled">
          <div className="pg-handled-row">
            <span className="pg-handled-label">已处理</span>
            {handledGroups.map((h) => (
              <button
                key={h.project}
                type="button"
                className={`pg-mini${handledOpen === h.project ? " on" : ""}`}
                title={`${h.project}：${h.sessions.length} 个已处理会话`}
                aria-expanded={handledOpen === h.project}
                onClick={() => setHandledOpen(handledOpen === h.project ? null : h.project)}
              >
                <span className="pg-mini-b">{h.sessions.length}</span>
                <span className="pg-mini-name">{h.project}</span>
              </button>
            ))}
          </div>
          {openHandled && (
            <ul className="pg-handled-list">
              {openHandled.sessions.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => onOpen(s.id)}>
                    <span className={`tag ${s.agent}`}>{AGENT_LABEL[s.agent]}</span>
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
