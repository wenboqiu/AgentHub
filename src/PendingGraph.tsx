import { useMemo, useState } from "react";
import type { Session } from "./lib/api";
import { AGENT_LABEL } from "./lib/agents";

const STATE_LABEL: Record<string, string> = { waiting: "等待授权", done: "已完成", aborted: "已中断" };

/** 项目气泡按项目名稳定取色；有待授权的用警示色 */
const TONES = ["tone-blue", "tone-teal", "tone-plum", "tone-amber"] as const;

function hashTone(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return TONES[h % TONES.length];
}

/** 气泡大小随会话数缩放（74–136px） */
function bubbleSize(count: number): number {
  return Math.round(Math.min(136, 74 + Math.sqrt(count) * 22));
}

type Props = {
  sessions: Session[];
  /** 等待授权（手机/桌面确认）的会话 id，按最高优先级标色 */
  approvals: Set<string>;
  onOpen(id: string): void;
};

/**
 * 待处理会话 · 图模式
 * 总览：每个项目一个气泡，数字 = 待处理会话数，点击展开；
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
    <div className="pg-wrap">
      <div className="pg-overview">
        {groups.map((g, i) => {
          const size = bubbleSize(g.sessions.length);
          const urgent = g.sessions.some((s) => s.state === "waiting" || approvals.has(s.id));
          return (
            <button
              key={g.project}
              type="button"
              className="pg-slot"
              style={{ width: size, height: size }}
              title={`展开 ${g.project} 的 ${g.sessions.length} 个待处理会话`}
              aria-label={`项目 ${g.project}，${g.sessions.length} 个待处理会话`}
              onClick={() => setExpanded(g.project)}
            >
              <span className="pg-floater" style={{ animationDelay: `${(i % 5) * 0.55}s` }}>
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
