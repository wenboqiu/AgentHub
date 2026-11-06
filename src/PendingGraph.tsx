import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "./lib/api";
import { AGENT_LABEL } from "./lib/agents";

/** 舞台下方留给图例、已处理开关和页面留白的高度 */
const STAGE_BOTTOM_RESERVE = 128;

/** 舞台高度上/下限：太矮放不开，太高气泡会散成一片 */
const STAGE_MIN_H = 320;
const STAGE_MAX_H = 1000;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

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

/** 气泡大小随会话数缩放（74–136px），再按舞台大小整体缩放 */
function bubbleSize(count: number, fit = 1): number {
  return Math.round(Math.min(136, 74 + Math.sqrt(Math.max(count, 1)) * 22) * fit);
}

/**
 * 会话气泡：文字越多球越大。标题短（≤10 字）不涨，之后随字数线性长到 base 的 1.75 倍，
 * 免得长标题被压成两行截断、只剩前半句。
 */
function sessionSize(text: string, base: number, fit = 1): number {
  const len = text.trim().length;
  const grow = clamp((len - 10) / 30, 0, 0.75);
  return Math.round(base * (1 + grow) * fit);
}

const GOLDEN_ANGLE = 2.39996; // 黄金角：散布均匀又不显网格感

type Group = { project: string; pending: Session[]; running: Session[] };

function groupByProject(sessions: Session[], approvals: Set<string>): Group[] {
  const m = new Map<string, Group>();
  // 同一目录在不同机器/会话里大小写可能不一致（AgentHub / agenthub），按小写归并，否则会拆成两个球
  const spellings = new Map<string, Map<string, number>>();
  for (const s of sessions) {
    const raw = (s.project || "").trim() || "(未知项目)";
    const key = raw.toLowerCase();
    let g = m.get(key);
    if (!g) {
      g = { project: raw, pending: [], running: [] };
      m.set(key, g);
    }
    const spell = spellings.get(key) ?? new Map<string, number>();
    spell.set(raw, (spell.get(raw) ?? 0) + 1);
    spellings.set(key, spell);
    // 运行中但有待授权的事项（approvals 里有）算「要你处理」，放外圈
    if (s.state === "running" && !approvals.has(s.id)) g.running.push(s);
    else g.pending.push(s);
  }
  // 球上显示出现次数最多的那种写法，避免名字随最后一个会话跳动
  for (const [key, g] of m) {
    const spell = spellings.get(key);
    if (!spell) continue;
    let best = g.project;
    let bestN = -1;
    for (const [name, n] of spell) {
      if (n > bestN || (n === bestN && name < best)) {
        best = name;
        bestN = n;
      }
    }
    g.project = best;
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
    // 球越大留的呼吸间距越大，大球挨在一起才不至于看着糊成一团
    const gap = clamp(Math.round(rad * 0.24), 12, 34);
    let x = cx;
    let y = cy;
    if (i > 0) {
      const a0 = i * GOLDEN_ANGLE + hash01(it.key) * Math.PI * 2;
      let found: { x: number; y: number } | null = null;
      for (let d = rad + gap; d < maxD + rad * 2 && !found; d += 8) {
        // 沿圆周按约 42px 间距采样，保证不会有漏掉的空档
        const steps = Math.min(90, Math.max(14, Math.round((Math.PI * 2 * d) / 42)));
        for (let k = 0; k < steps; k++) {
          const a = a0 + (k / steps) * Math.PI * 2;
          const px = cx + Math.cos(a) * d;
          const py = cy + Math.sin(a) * d;
          if (px < rad + 6 || px > wrapW - rad - 6 || py < rad + 6 || py > stageH - rad - 6) continue;
          if (placed.every((p) => Math.hypot(p.x - px, p.y - py) >= p.r + rad + gap)) {
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
function scatterStage(items: ScatterInput[], wrapW: number, maxH: number) {
  const w = Math.max(wrapW, 260);
  const need = items.reduce((sum, it) => sum + Math.PI * (it.size / 2 + 16) ** 2, 0);
  // 展开态要铺得比总览更开：会话多时至少比总览高 15%，内容更多就继续往下长
  // （页面滚动），最高放到可用高度的 1.35 倍、且不超过 1600
  const cap = Math.round(clamp(maxH * 1.35, 360, 1600));
  const fill = clamp(1 + (items.length - 4) * 0.05, 1, 1.15);
  const est = (need * 2.1) / Math.max(w - 44, 240) + 40;
  let stageH = Math.round(clamp(Math.max(est, maxH * fill), 360, cap));
  let res = placeAll(items, w, stageH);
  for (let k = 0; k < 8 && !res.ok && stageH < 1600; k++) {
    stageH = Math.min(1600, Math.round(stageH * 1.12));
    res = placeAll(items, w, stageH);
  }
  return { ...res, stageH };
}

type GroupSpot = { g: Group; size: number; x: number; y: number };

/**
 * 总览散布：大球先放正中，其余沿黄金角螺旋找第一个不重叠、不出界的位置。
 * 哈希抖动让布局看着随机，但每次进来都一样；ok=false 表示有球被挤到兜底位（可能压到邻居）。
 */
function scatterGroups(groups: Group[], wrapW: number, stageH: number, fit: number) {
  const cx = wrapW / 2;
  const cy = Math.round(stageH / 2);
  const placed: { x: number; y: number; r: number }[] = [];
  let ok = true;

  const pos: GroupSpot[] = groups.map((g, i) => {
    const size = bubbleSize(g.pending.length + g.running.length, fit);
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
      if (found) {
        x = found.x;
        y = found.y;
      } else {
        ok = false;
        x = Math.round(cx + (hash01(g.project, 5) - 0.5) * Math.max(wrapW - 2 * rad - 12, 0));
        y = Math.round(cy + (hash01(g.project, 6) - 0.5) * Math.max(stageH - 2 * rad - 12, 0));
      }
    }
    placed.push({ x, y, r: rad });
    return { g, size, x, y };
  });

  return { pos, ok };
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

  // 散布布局要知道容器的宽和「窗口还能给多高」：窗口一缩放，两者都要跟着变
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const rafRef = useRef(0);

  const measure = useCallback(() => {
    // 拖窗口时 resize 每帧都来，合并到下一帧测一次，避免重复重排
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const el = wrapRef.current;
      if (!el) return;
      // 用文档坐标算顶部位置，页面滚动不影响结果
      const top = el.getBoundingClientRect().top + window.scrollY;
      const w = el.clientWidth;
      const h = clamp(Math.round(window.innerHeight - top - STAGE_BOTTOM_RESERVE), STAGE_MIN_H, STAGE_MAX_H);
      setBox((prev) => (Math.abs(prev.w - w) < 1 && Math.abs(prev.h - h) < 1 ? prev : { w, h }));
    });
  }, []);

  // 舞台高度由我们写死给 stage，窗口变高并不会改到 wrap 的尺寸，
  // 所以光靠 ResizeObserver 收不到「窗口变高」这件事，必须同时听 window.resize
  useEffect(() => {
    measure();
    const el = wrapRef.current;
    const ro = new ResizeObserver(measure);
    if (el) ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [measure, expanded]);

  /** 舞台大了球也放大一点（免得太空）；窗口小时只轻微收一点，别把气泡里的字挤烂 */
  const fit = useMemo(
    () => (box.w && box.h ? clamp(Math.min(box.w / 900, box.h / 460), 0.95, 1.45) : 1),
    [box.w, box.h],
  );

  const layout = useMemo(() => {
    if (!box.w || groups.length === 0) return null;
    // 舞台先按窗口给的高度铺满；真挤不下才往下长（最多到上限），别为了几个球硬撑一屏
    let stageH = Math.round(clamp(box.h, STAGE_MIN_H, STAGE_MAX_H));
    let res = scatterGroups(groups, box.w, stageH, fit);
    for (let k = 0; k < 4 && !res.ok && stageH < STAGE_MAX_H; k++) {
      stageH = Math.min(STAGE_MAX_H, Math.round(stageH * 1.15));
      res = scatterGroups(groups, box.w, stageH, fit);
    }
    return { pos: res.pos, stageH };
  }, [groups, box.w, box.h, fit]);

  const current = expanded ? groups.find((g) => g.project === expanded) : undefined;

  if (current) {
    const { pending, running } = current;
    const runIds = new Set(running.map((s) => s.id));
    const total = pending.length + running.length;
    // 会话多了就缩一点，保证同屏能铺开；再乘上舞台整体的缩放系数
    const base = Math.round((total > 26 ? 70 : total > 14 ? 78 : 88) * fit);

    // 要你动手的排最中间（越靠中心越先被放到舞台中央），运行中的甩到外圈
    const rank = (s: Session) =>
      isUrgent(s, approvals) ? 0 : s.state === "aborted" ? 1 : runIds.has(s.id) ? 3 : 2;
    const entries = [...pending, ...running]
      .sort((a, b) => rank(a) - rank(b))
      .map((s) => {
        const run = runIds.has(s.id);
        // 文字多的球画大一些，长标题才装得下（运行中的球仍比同文案的小一圈）
        const size = sessionSize(s.title || s.summary || "", base) - (run ? 8 : 0);
        return { s, run, size };
      });

    const { spots, stageH } = scatterStage(
      entries.map((e) => ({ key: e.s.id, size: e.size })),
      box.w || 900,
      box.h || STAGE_MIN_H,
    );

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
            // 球画大了字也跟着放大一点，不然大球里一行小字反而更空；长标题多给几行
            const fs = clamp(e.size / 88, 1, 1.25);
            const titleLines = e.size >= 165 ? 4 : e.size >= 130 ? 3 : 2;
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
                    <span className="pg-state" style={{ fontSize: 10.5 * fs }}>{label}</span>
                    <span className="pg-title" style={{ fontSize: 11 * fs, WebkitLineClamp: titleLines }}>
                      {e.s.title || e.s.summary || "未命名会话"}
                    </span>
                    <span className="pg-agent" style={{ fontSize: 9.5 * fs }}>{AGENT_LABEL[e.s.agent]}</span>
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
          const pendingCount = g.pending.length;
          const runningCount = g.running.length;
          const hasPending = pendingCount > 0;
          const urgent = g.pending.some((s) => isUrgent(s, approvals));
          const tone = hasPending ? (urgent ? "tone-wait" : hashTone(g.project)) : "tone-blue";
          const dur = (7 + hash01(g.project, 3) * 4).toFixed(2); // 每个球漂移节奏不同
          const delay = (-hash01(g.project, 4) * 10).toFixed(2);
          const breakdown = hasPending
            ? `${pendingCount} 个待处理${runningCount ? ` · ${runningCount} 个运行中` : ""}`
            : `${runningCount} 个运行中`;
          return (
            <button
              key={g.project}
              type="button"
              className="pg-slot pg-scatter-slot"
              style={{ width: size, height: size, left: x, top: y, marginLeft: -size / 2, marginTop: -size / 2 }}
              title={`展开 ${g.project}：${breakdown}`}
              aria-label={`项目 ${g.project}，${breakdown}`}
              onClick={() => setExpanded(g.project)}
            >
              <span className="pg-floater" style={{ animation: `pg-drift ${dur}s ease-in-out ${delay}s infinite` }}>
                <span className={`pg-bubble ${tone}`} style={{ animationDelay: `${i * 60}ms` }}>
                  {runningCount > 0 && <span className="pg-run-ring" />}
                  {/* 待处理 / 运行中两个数字同时显示，颜色区分：待处理用气泡暖色调，运行中统一蓝色 */}
                  <span className="pg-nums">
                    {hasPending && (
                      <span className="pg-num pg-num-pending">
                        <b>{pendingCount}</b>
                        <i>待处理</i>
                      </span>
                    )}
                    {runningCount > 0 && (
                      <span className="pg-num pg-num-running">
                        <b>{runningCount}</b>
                        <i>运行中</i>
                      </span>
                    )}
                  </span>
                  <span className="pg-name" title={g.project}>{g.project}</span>
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <p className="pg-legend">
        <span><i className="pg-dot tone-wait" />有待授权</span>
        <span><i className="pg-dot tone-blue" />只有运行中</span>
        <span><i className="pg-dot pg-dot-ring" />虚环 = 有运行中</span>
        <span>待处理为暖色 · 运行中为蓝色，同时显示</span>
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
