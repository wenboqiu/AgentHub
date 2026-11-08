import { useEffect, useMemo, useRef, useState } from "react";
import { AGENT_LABEL } from "./lib/agents";
import type { Session } from "./lib/api";
import { ago } from "./lib/time";
import { isInternalSession, sessionPreview } from "./lib/internal";
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

type Section = { key: "pending" | "running" | "rest" | "internal"; label: string; hint: string; items: Session[] };

const FOLD_KEY = "agenthub.sidebarSections";
/** 侧栏宽度：拖动分隔条调整，记住到本机 */
const WIDTH_KEY = "agenthub.sidebarWidth";
const MIN_W = 200;
const MAX_W = 560;
const DEFAULT_W = 276;
/** 上限同时受视口约束：最多占一半宽，别把对话流挤没了 */
const maxWidth = () => Math.max(MIN_W, Math.min(MAX_W, Math.round(window.innerWidth * 0.5)));
const clampWidth = (w: number) => Math.max(MIN_W, Math.min(maxWidth(), Math.round(w)));
const readWidth = () => {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(n) && n > 0) return clampWidth(n);
  } catch {}
  return DEFAULT_W;
};

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
    const internal: Session[] = [];
    for (const s of sessions) {
      // 内部会话（角色助手 / 意见细化）先挑走：它们的首条消息是契约提示词，混在「待处理」里只会让人误点
      if (isInternalSession(s)) internal.push(s);
      else if (attention.has(s.id)) pending.push(s);
      else if (s.state === "running") running.push(s);
      else rest.push(s);
    }
    const all: Section[] = [
      { key: "pending", label: "待处理", hint: "等你处理", items: pending },
      { key: "running", label: "进行中", hint: "在跑", items: running },
      { key: "rest", label: "已处理", hint: "历史", items: rest },
      { key: "internal", label: "内部会话", hint: "AgentHub 自己开的", items: internal },
    ];
    return all.filter((g) => g.items.length > 0);
  }, [sessions, attention]);

  // 折叠状态记在本机，下次进来保持一致；没记录过的按默认（已处理、内部会话收起）
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

  /** 默认展开待处理与进行中；已处理、内部会话默认收起（收着也要能点开看，所以是折叠不是隐藏） */
  const defaultOpen = (key: Section["key"]) => key !== "rest" && key !== "internal";
  const isOpen = (g: Section) => openMap[g.key] ?? defaultOpen(g.key);

  // 当前会话若落在收起的段里（比如从别处跳进一个已处理的会话），自动展开那一段
  useEffect(() => {
    if (!currentId) return;
    const hit = sections.find((g) => g.items.some((s) => s.id === currentId));
    if (hit && !(openMap[hit.key] ?? defaultOpen(hit.key))) setOpenMap((m) => ({ ...m, [hit.key]: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, sections]);

  // 宽度：拖动时直接改 DOM（不逐帧 setState，列表重渲染会卡），松手才落状态 + 存本机
  const [width, setWidth] = useState(readWidth);
  const navRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{ x: number; start: number; last: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const applyWidth = (w: number) => {
    if (navRef.current) navRef.current.style.width = `${w}px`;
  };
  const commitWidth = (w: number) => {
    const next = clampWidth(w);
    applyWidth(next);
    setWidth(next);
    try { localStorage.setItem(WIDTH_KEY, String(next)); } catch {}
  };
  // 拖动中锁住光标和选中，免得把正文文字一起选中
  useEffect(() => {
    if (!dragging) return;
    document.body.classList.add("sidebar-resizing");
    return () => document.body.classList.remove("sidebar-resizing");
  }, [dragging]);
  // 窗口变窄后旧宽度可能超过新上限：跟着收一下
  useEffect(() => {
    const onResize = () => { if ((navRef.current?.offsetWidth ?? width) > maxWidth()) commitWidth(maxWidth()); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width]);

  /** 分隔条：鼠标 / 触屏拖宽度，←→ 键盘微调，双击回到默认 */
  const resizer = drawer ? null : (
    <div
      className={`sidebar-resizer${dragging ? " dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="调整会话列表宽度"
      aria-valuenow={width}
      aria-valuemin={MIN_W}
      aria-valuemax={maxWidth()}
      tabIndex={0}
      title="拖动调整宽度，双击恢复默认"
      onPointerDown={(e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        e.preventDefault();
        const start = navRef.current?.offsetWidth ?? width;
        dragRef.current = { x: e.clientX, start, last: start };
        setDragging(true);
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = dragRef.current;
        if (!d) return;
        d.last = clampWidth(d.start + (e.clientX - d.x));
        applyWidth(d.last);
      }}
      onPointerUp={(e) => {
        const d = dragRef.current;
        if (!d) return;
        dragRef.current = null;
        setDragging(false);
        commitWidth(d.last);
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      }}
      onPointerCancel={() => {
        const d = dragRef.current;
        dragRef.current = null;
        setDragging(false);
        if (d) commitWidth(d.last);
      }}
      onDoubleClick={() => commitWidth(DEFAULT_W)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const step = e.shiftKey ? 48 : 16;
        const base = navRef.current?.offsetWidth ?? width;
        commitWidth(base + (e.key === "ArrowRight" ? step : -step));
      }}
    />
  );

  return (
    <>
      <nav
        ref={navRef}
        className={`sidebar${drawer ? " sidebar-drawer" : ""}`}
        style={drawer ? undefined : { width }}
        aria-label="会话列表"
        aria-modal={drawer || undefined}
        role={drawer ? "dialog" : undefined}
      >
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
                  const preview = sessionPreview(s);
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
                        {preview && <span className="si-sub">{preview}</span>}
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
      {resizer}
    </>
  );
}
