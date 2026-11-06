import { useEffect, useMemo, useState } from "react";
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
  /** 窄屏抽屉形态：盖在正文上、带遮罩，收起按钮变成「关闭」 */
  drawer?: boolean;
};

const STATE_DOT: Record<string, string> = {
  running: "running",
  waiting: "alert",
  aborted: "alert",
  done: "ok",
};

type Section = { key: "pending" | "running" | "rest"; label: string; hint: string; items: Session[] };

const FOLD_KEY = "agenthub.sidebarSections";

/**
 * 会话详情页左侧的会话列表（参考 WorkBuddy）：不用回列表页就能快速切到别的会话。
 * 分成「待处理 / 进行中 / 已处理」三段，各自可折叠，待处理与进行中默认展开、已处理默认收起。
 * 宽屏（桌面）常驻左侧；窄屏（手机 / Android）由对话页头部的「会话列表」按钮打开成抽屉。
 */
export default function SessionSidebar({ sessions, currentId, attention, now, onSelect, onCollapse, drawer = false }: Props) {
  const sections = useMemo<Section[]>(() => {
    const pending: Session[] = [];
    const running: Session[] = [];
    const rest: Session[] = [];
    for (const s of sessions) {
      if (attention.has(s.id)) pending.push(s);
      else if (s.state === "running") running.push(s);
      else rest.push(s);
    }
    const all: Section[] = [
      { key: "pending", label: "待处理", hint: "等你处理", items: pending },
      { key: "running", label: "进行中", hint: "在跑", items: running },
      { key: "rest", label: "已处理", hint: "历史", items: rest },
    ];
    return all.filter((g) => g.items.length > 0);
  }, [sessions, attention]);

  // 折叠状态记在本机，下次进来保持一致；没记录过的按默认（已处理收起）
  const [openMap, setOpenMap] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(FOLD_KEY) || "{}") as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(FOLD_KEY, JSON.stringify(openMap));
    } catch {}
  }, [openMap]);

  const isOpen = (g: Section) => openMap[g.key] ?? g.key !== "rest";

  // 当前会话若落在收起的段里（比如从别处跳进一个已处理的会话），自动展开那一段
  useEffect(() => {
    if (!currentId) return;
    const hit = sections.find((g) => g.items.some((s) => s.id === currentId));
    if (hit && !(openMap[hit.key] ?? hit.key !== "rest")) setOpenMap((m) => ({ ...m, [hit.key]: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, sections]);

  return (
    <nav className={`sidebar${drawer ? " sidebar-drawer" : ""}`} aria-label="会话列表" aria-modal={drawer || undefined} role={drawer ? "dialog" : undefined}>
      <div className="sidebar-head">
        <span>会话 <span className="count dim">{sessions.length}</span></span>
        <button className="icon-button sidebar-toggle" aria-label={drawer ? "关闭会话列表" : "收起会话列表"} title={drawer ? "关闭会话列表" : "收起会话列表"} onClick={onCollapse}>
          <Icon name="chevron" />
        </button>
      </div>

      {sections.length === 0 && <p className="empty">还没有会话</p>}

      {sections.map((g) => {
        const open = isOpen(g);
        return (
          <section key={g.key} className={`sidebar-sec${open ? " open" : ""}`}>
            <button
              type="button"
              className="sidebar-sec-head"
              aria-expanded={open}
              onClick={() => setOpenMap((m) => ({ ...m, [g.key]: !open }))}
            >
              <Icon name="chevron" />
              <span className="sidebar-sec-label">{g.label}</span>
              <span className={`sidebar-sec-count${g.key === "pending" ? " alert" : ""}`}>{g.items.length}</span>
              <span className="sidebar-sec-hint">{g.hint}</span>
            </button>
            {open && (
              <ul className="sidebar-list">
                {g.items.map((s) => {
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
            )}
          </section>
        );
      })}
    </nav>
  );
}
