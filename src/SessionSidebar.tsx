import { AGENT_LABEL } from "./lib/agents";
import type { Session } from "./lib/api";
import { ago } from "./lib/time";
import Icon from "./Icon";

type Props = {
  /** 全部会话（已按更新时间倒序） */
  sessions: Session[];
  /** 当前打开的会话 */
  currentId: string | null;
  /** 需要人处理的会话 id（待授权 / 有待确认事项），条目上挂标记 */
  attention: Set<string>;
  /** 相对时间用的当前时刻（App 每 30 秒推进一次） */
  now: number;
  onSelect(id: string): void;
  onCollapse(): void;
};

const STATE_DOT: Record<string, string> = {
  running: "running",
  waiting: "alert",
  aborted: "alert",
  done: "ok",
};

/**
 * 会话详情页左侧的会话列表（参考 WorkBuddy）：不用回列表页就能快速切到别的会话。
 * 只在桌面端渲染；手机上空间有限，维持原来的全屏详情。
 */
export default function SessionSidebar({ sessions, currentId, attention, now, onSelect, onCollapse }: Props) {
  return (
    <nav className="sidebar" aria-label="会话列表">
      <div className="sidebar-head">
        <span>会话 <span className="count dim">{sessions.length}</span></span>
        <button className="icon-button sidebar-toggle" aria-label="收起会话列表" title="收起会话列表" onClick={onCollapse}>
          <Icon name="chevron" />
        </button>
      </div>
      {sessions.length === 0 && <p className="empty">还没有会话</p>}
      <ul className="sidebar-list">
        {sessions.map((s) => {
          const needsAttention = attention.has(s.id);
          return (
            <li key={s.id}>
              <button
                className={`sidebar-item${s.id === currentId ? " active" : ""}`}
                aria-current={s.id === currentId ? "true" : undefined}
                onClick={() => onSelect(s.id)}
                title={s.title || s.project || undefined}
              >
                <span className="si-top">
                  <span className={`si-dot ${STATE_DOT[s.state] ?? "dim"}`} aria-hidden="true" />
                  <span className="si-name">{s.project || "(未知项目)"}</span>
                  {needsAttention && <span className="si-badge">待处理</span>}
                  <span className="si-time">{ago(s.updatedAt, now)}</span>
                </span>
                {(s.title || s.summary) && <span className="si-sub">{s.title || s.summary}</span>}
                <span className="si-meta">{AGENT_LABEL[s.agent]} · {s.machine}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
