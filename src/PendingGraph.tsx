import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "./lib/api";
import { AGENT_LABEL } from "./lib/agents";

const STATE_LABEL: Record<string, string> = { waiting: "等待授权", done: "已完成", aborted: "已中断" };

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
  return Math.round(Math.min(136, 74 + Math.sqrt(count) * 22));
}

const GOLDEN_ANGLE = 2.39996; // 黄金角：散布均匀又不显网格感

type Props = {
  sessions: Session[];
  /** 等待授权（手机/桌面确认）的会话 id，按最高优先级标色 */
  approvals: Set<string>;
  onOpen(id: string): void;
};

/**
 * 待处理会话 · 图模式
 * 总览：每个项目一个气泡，数字 = 待处理会话数，随机散布 + 各自漂移，点击展开；
 * 展开：项目气泡居中，会话气泡环绕，点击会话气泡直接打开会话。
 */
export default function PendingGraph({ sessions, approvals, onOpen }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const groups = useMemo(() => {
    const m = new Map<string, Session[]>();
    for (const s of sessions) {
      const key = s.project || "(未知项目)";
      const arr = m.get(key);
      if (arr) arr.push(s);
      else m.set(key, [s]);
    }
    return [...m.entries()]
      .map(([project, list]) => ({ project, sessions: list }))
      .sort((a, b) => b.sessions.length - a.sessions.length);
  }, [sessions]);

  // 总览散布布局：量容器宽度后按黄金角螺旋 + 名字哈希抖动布点，看着随机、每次进来都一样
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
      const size = bubbleSize(g.sessions.length);
      const rad = size / 2;
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
    const list = current.sessions;
    const n = list.length;
    const R = 152; // 会话气泡环绕半径
    const urgentProject = list.some((s) => s.state === "waiting" || approvals.has(s.id));
    return (
      <div className="pg-wrap">
        <div className="pg-toolbar">
          <button type="button" className="link" onClick={() => setExpanded(null)}>‹ 返回总览</button>
        </div>
        <div className="pg-stage">
          {list.map((s, i) => {
            const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
            const x = Math.round(Math.cos(angle) * R);
            const y = Math.round(Math.sin(angle) * R);
            const urgent = s.state === "waiting" || approvals.has(s.id);
            const tone = urgent ? "tone-wait" : s.state === "done" ? "tone-done" : "tone-abort";
            const label = STATE_LABEL[s.state] ?? s.state;
            const tip = `${AGENT_LABEL[s.agent]} · ${label}\n${s.title || s.summary || s.id}`;
            return (
              <button
                key={s.id}
                type="button"
                className="pg-slot pg-orbit"
                style={{ width: 88, height: 88, marginLeft: -44, marginTop: -44, transform: `translate(${x}px, ${y}px)` }}
                title={tip}
                aria-label={`打开会话：${label}`}
                onClick={() => onOpen(s.id)}
              >
                <span className="pg-floater" style={{ animationDelay: `${(i % 4) * 0.55}s` }}>
                  <span className={`pg-bubble pg-session ${tone}`} style={{ animationDelay: `${i * 60}ms` }}>
                    <span className="pg-state">{label}</span>
                    <span className="pg-agent">{AGENT_LABEL[s.agent]}</span>
                  </span>
                </span>
              </button>
            );
          })}
          <div className="pg-slot pg-center-slot" style={{ width: 116, height: 116, marginLeft: -58, marginTop: -58 }} aria-hidden>
            <span className="pg-floater" style={{ animationDelay: "0.3s" }}>
              <span className={`pg-bubble pg-center ${urgentProject ? "tone-wait" : "tone-blue"}`}>
                <span className="pg-count">{n}</span>
                <span className="pg-name">{current.project}</span>
              </span>
            </span>
          </div>
        </div>
        <p className="pg-legend">
          <span><i className="pg-dot tone-wait" />等待授权</span>
          <span><i className="pg-dot tone-done" />已完成</span>
          <span><i className="pg-dot tone-abort" />已中断</span>
          <span>点击会话气泡打开会话</span>
        </p>
      </div>
    );
  }

  return (
    <div className="pg-wrap" ref={wrapRef}>
      <div className="pg-stage pg-scatter" style={{ height: layout?.stageH ?? 380 }}>
        {(layout?.pos ?? []).map(({ g, size, x, y }, i) => {
          const urgent = g.sessions.some((s) => s.state === "waiting" || approvals.has(s.id));
          const dur = (7 + hash01(g.project, 3) * 4).toFixed(2); // 每个球漂移节奏不同
          const delay = (-hash01(g.project, 4) * 10).toFixed(2);
          return (
            <button
              key={g.project}
              type="button"
              className="pg-slot pg-scatter-slot"
              style={{ width: size, height: size, left: x, top: y, marginLeft: -size / 2, marginTop: -size / 2 }}
              title={`展开 ${g.project} 的 ${g.sessions.length} 个待处理会话`}
              aria-label={`项目 ${g.project}，${g.sessions.length} 个待处理会话`}
              onClick={() => setExpanded(g.project)}
            >
              <span className="pg-floater" style={{ animation: `pg-drift ${dur}s ease-in-out ${delay}s infinite` }}>
                <span className={`pg-bubble ${urgent ? "tone-wait" : hashTone(g.project)}`} style={{ animationDelay: `${i * 60}ms` }}>
                  <span className="pg-count">{g.sessions.length}</span>
                  <span className="pg-name">{g.project}</span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="pg-legend">
        <span><i className="pg-dot tone-wait" />有待授权</span>
        <span><i className="pg-dot tone-blue" />待查看</span>
        <span>气泡大小 = 会话数量 · 点击展开项目</span>
      </p>
    </div>
  );
}
