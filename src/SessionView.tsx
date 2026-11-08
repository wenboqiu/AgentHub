import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isPending, isRunActive, APPROVAL_TIER_LABEL, type Api, type Approval, type Message, type Proposal, type Run, type RunActivity, type Session, type Task } from "./lib/api";
import { desktop, isAndroid, isDesktop } from "./lib/platform";
import { syncSession, type Bus } from "./lib/sessionSync";
import { QuickCreate } from "./TasksPanel";
import Icon from "./Icon";
import MessageActions from "./MessageActions";
import { speechSnapshot, subscribeSpeech, stopSpeech } from "./lib/speech";
import { AGENT_LABEL, agentName, isListenOnly } from "./lib/agents";
import SessionSidebar from "./SessionSidebar";
import { useMediaQuery } from "./lib/useMediaQuery";
import { isPendingSession, isStuckRunning, sendBlockReason } from "./lib/sendBlock";
import { isInternalSession } from "./lib/internal";
import { ACCEPTED_TYPES, MAX_IMAGES, fileToDataUrl, fitsLimit, pickDataUrls, pickImageFiles } from "./lib/images";
import { canPickNative, pickNativeImages } from "./lib/nativeImages";
import { clockAt, fullAt } from "./lib/time";
import { formatElapsed, liveLabel, listenLabel, runElapsed, runSummary } from "./lib/runMeta";
import Markdown from "./Markdown";

const STATE_LABEL: Record<string, string> = {
  idle: "空闲",
  unknown: "状态未知",
  running: "运行中",
  waiting: "等待授权",
  done: "已完成",
  aborted: "已中断",
  ended: "已结束",
};

type Props = {
  /** 当前打开的会话 id（session 可能还没到，例如刚新开、广播还没送到） */
  sessionId: string;
  session: Session | undefined;
  /** 本机的 machine 名（桌面端才有意义） */
  localMachine: string;
  /** 跳到另一个会话（新开会话后跳到临时会话） */
  onSwitch(id: string): void;
  /** 全部会话（已按更新时间倒序）：桌面端左侧会话列表用 */
  sessions: Session[];
  /** 相对时间用的当前时刻（App 每 30 秒推进一次） */
  nowTick: number;
  /** 需要人处理的会话 id 集合（待授权 / 有待确认事项） */
  attention: Set<string>;
  api: Api;
  bus: Bus;
  /** 这个会话当前 pending 的授权（App 从 WS 维护） */
  approvals: Approval[];
  /** 在线的执行器（机器名） */
  agents: string[];
  onBack(): void;
  tasks: Task[];
  onTask(id:number):void;
  onTaskSaved(task:Task):void;
  /** 这条会话的处理意见（含已处理过的，用来判断要不要显示入口、有几份待确认） */
  proposals: Proposal[];
  /** 打开任务单详情页（正文放在那边展开，聊天流里只留一个入口） */
  onProposals(sessionId: string): void;
  /** 把这条会话标记为已处理：打开对话流时自动调用，会话从待处理区撒下 */
  onAck(): void;
};

/** 不能发消息的原因与各种阻塞判定，见 lib/sendBlock（纯逻辑，单独测试） */
export { isPendingSession, sendBlockReason, isStuckRunning, STALE_RUNNING_MS } from "./lib/sendBlock";

const NOT_FOUND_GRACE_MS = 5000;

/** Codex 提问（request_user_input）的 questions，存在 approval.detail 里（JSON 字符串） */
type UserQuestion = { id: string; question: string; options: { label: string; description?: string }[] };
const parseQuestions = (detail: string): UserQuestion[] | null => {
  try {
    const v = JSON.parse(detail);
    if (!Array.isArray(v) || !v.length) return null;
    const out = v
      .filter((q): q is Record<string, unknown> => !!q && typeof q === "object" && typeof (q as { id?: unknown }).id === "string")
      .map((q) => ({
        id: String(q.id),
        question: typeof q.question === "string" ? q.question : String(q.header ?? ""),
        options: Array.isArray(q.options)
          ? q.options.filter((o): o is { label: string; description?: string } => !!o && typeof o === "object" && typeof (o as { label?: unknown }).label === "string")
          : [],
      }));
    return out.length ? out : null;
  } catch {
    return null;
  }
};

export default function SessionView({ sessionId, session, localMachine, onSwitch, sessions, nowTick, attention, api, bus, approvals, agents, onBack, tasks, onTask, onTaskSaved, proposals, onProposals, onAck }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  /** 运行中：执行器刚上报的「正在做什么」（agent 自己的话），不是本地编的状态 */
  const [activity, setActivity] = useState<RunActivity | null>(null);
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  // 任务单入口上的数量：待确认优先说，处理过的只给个总数。
  // 忽略过的（discarded）不算：人已经说了「这张单不用了」，聊天流底部不该还留着一个入口提醒他；
  // 一条会话的单子全被忽略时，入口整块不出现。详情页里仍留着「这条建议不用了」的记录。
  const liveProposals = proposals.filter((p) => p.status !== "discarded");
  const proposalCount = liveProposals.length;
  const pendingProposals = liveProposals.filter((p) => p.status === "pending").length;
  /** 细粒度操作锁：哪类操作在等待就只锁哪类按钮，避免"点一个按钮全页变灰" */
  const [pending, setPending] = useState<"" | "send" | "stop" | "spawn" | "terminal" | "link">("");
  const [deciding, setDeciding] = useState<string | null>(null);
  /** Codex 提问卡片里每个问题的已选项：questionId → 选项 label 数组（可多选，对应协议 answers 数组） */
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState("");
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [branchMessage, setBranchMessage] = useState<Message|null>(null);
  const speech=useSyncExternalStore(subscribeSpeech,speechSnapshot);
  useEffect(()=>()=>stopSpeech(),[sessionId]);
  const [spawnText, setSpawnText] = useState("");
  const [gaveUp, setGaveUp] = useState(false);
  const [linkingTask,setLinkingTask] = useState(false);
  /** 底部确认面板是否被用户收起（只影响展开状态，不影响审批本身） */
  const [sheetCollapsed, setSheetCollapsed] = useState(false);
  /** 图片预览浮层：当前放大查看的图片（data URL） */
  const [preview, setPreview] = useState<string | null>(null);
  /** 待发送的附图（data URL），最多 MAX_IMAGES 张 */
  const [images, setImages] = useState<string[]>([]);
  /** 左侧会话列表是否收起（记住上次的展开状态，宽屏常驻时生效） */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem("agenthub.sidebar") === "0"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("agenthub.sidebar", sidebarCollapsed ? "0" : "1"); } catch {}
  }, [sidebarCollapsed]);
  /** 窄屏（手机）：侧栏改成从左侧滑出的抽屉，默认收起 */
  const narrow = useMediaQuery("(max-width: 760px)");
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 切到别的会话后抽屉自动收起，把正文让出来
  useEffect(() => { setDrawerOpen(false); }, [sessionId]);
  // 按宽度决定形态，不看平台：电脑和安卓平板（宽屏 / 横屏）都常驻左侧列表，
  // 手机宽度放不下才收成抽屉——之前只在桌面端渲染，平板上就完全看不到列表。
  const docked = !narrow;
  const sidebarVisible = docked ? !sidebarCollapsed : drawerOpen;
  // 顶栏横贯全宽、侧栏从顶栏下沿开始：实测顶栏高度（换行 / 字体缩放会变）写给侧栏 sticky 定位用
  const pageRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const page = pageRef.current, header = headerRef.current;
    if (!page || !header) return;
    const ro = new ResizeObserver(() => page.style.setProperty("--session-topbar-h", `${header.offsetHeight}px`));
    ro.observe(header);
    return () => ro.disconnect();
  }, []);
  const attentionCount = attention.size;
  const selectSession = (next: string) => {
    setDrawerOpen(false);
    onSwitch(next);
  };
  const fileRef = useRef<HTMLInputElement | null>(null);
  /** 用户是否停留在消息底部：底部附近才跟随新消息滚动，往上翻历史时不打断 */
  const stick = useRef(true);
  const id = session?.id ?? "";

  const syncRef = useRef<ReturnType<typeof syncSession> | null>(null);
  const reload = () => syncRef.current?.reload();
  useEffect(() => {
    if (!id) return;
    setMessages([]);
    setRun(null);
    setActivity(null);
    setLoading(true);
    setErr("");
    setImages([]); // 附件不跟着串到别的会话
    stick.current = true; // 切换会话后重新跟随底部
    const sync = syncSession(api, id, bus, (data) => {
      setMessages(data.messages);
      setRun(data.run);
      setActivity(data.activity);
    }, (e) => setErr(e instanceof Error ? e.message : String(e)), () => setLoading(false));
    syncRef.current = sync;
    void sync.reload();
    return () => { sync.dispose(); syncRef.current = null; };
  }, [api, bus, id]);

  // 打开详情页时自动从电脑上拉一次最新记录（服务端存的可能是旧的）；每个会话只自动拉一次
  // WorkBuddy 只读不聊，但 transcript 在电脑上，历史照样能拉
  const online = !!session && agents.includes(session.machine);
  const [syncing, setSyncing] = useState(false);
  const autoLoaded = useRef("");
  useEffect(() => {
    if (!id || !online || isPendingSession(id) || autoLoaded.current === id) return;
    autoLoaded.current = id;
    let gone = false;
    setSyncing(true);
    api
      .history(id)
      .then(() => (gone ? undefined : syncRef.current?.reload()))
      .catch(() => {}) // 电脑上读不到就保留已有记录，手动刷新时才提示错误
      .finally(() => {
        if (!gone) setSyncing(false);
      });
    return () => {
      gone = true;
      setSyncing(false);
    };
  }, [api, id, online]);

  // 会话暂时不在列表里（刚新开、广播还没到）：先显示「加载中」，等够 5 秒才判定不存在
  const exists = !!session;
  useEffect(() => {
    setGaveUp(false);
    if (exists) return;
    const t = window.setTimeout(() => setGaveUp(true), NOT_FOUND_GRACE_MS);
    return () => window.clearTimeout(t);
  }, [sessionId, exists]);

  useEffect(() => {
    setSpawnOpen(false);
    setBranchMessage(null);
    setSpawnText("");
    setLinkingTask(false);
  }, [sessionId]);

  // Esc 关闭浮层面板（分支/新建会话、关联任务、图片预览、底部确认面板）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setSpawnOpen(false);
      setBranchMessage(null);
      setLinkingTask(false);
      setPreview(null);
      setSheetCollapsed(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 待确认请求到达时自动展开底部确认面板；用户可收起，浮动徽标可再展开
  const sheetOpen = approvals.length > 0 && !sheetCollapsed;
  useEffect(() => {
    if (approvals.length > 0) setSheetCollapsed(false);
  }, [approvals.length]);
  // 浮层打开时锁定背景滚动
  useEffect(() => {
    if (!sheetOpen && !preview) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [sheetOpen, preview]);

  // 跟随滚动：只有本来就停在底部附近时才自动滚到最新消息
  useEffect(() => {
    const onScroll = () => {
      const doc = document.documentElement;
      stick.current = window.innerHeight + window.scrollY >= doc.scrollHeight - 160;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // 运行中每秒走一次表：思考计时和「刚刚还在执行工具」都得靠它推进
  const active = isRunActive(run);
  // 只读监听会话（WorkBuddy / 豆包）没有 run，逐条活动也就没有；只要服务端还说这次在跑，就该有一行说明
  const listenLive = !active && !!session && isListenOnly(session.agent) && session.state === "running";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active && !listenLive) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active, listenLive, run?.id]);
  // 内容指纹：条数 + 总字数。回复是流式长出来的（同一条消息变长、条数不变），
  // 只盯条数会在回复变长时漏掉跟随，末尾就会滑到输入框后面。
  const flowKey = messages.length + ":" + messages.reduce((n, m) => n + m.text.length, 0);
  useEffect(() => {
    // 不能用 endRef.scrollIntoView({block:"end"})：输入框是 sticky 悬浮在视口底部的，
    // 那样只会把"末尾"对齐到视口底，最后一条消息 / 授权卡片正好被输入框盖住
    // （页面还会差着输入框那一截没滚到底）。滚到文档真正的最底部，
    // 输入框就会回到它在文档流里的位置，末尾内容自然露在它上方。
    if (stick.current) window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
  }, [flowKey, approvals.length]);

  if (!session) {
    return (
      <div className="app">
        <header>
          <button className="back-button" onClick={onBack}><Icon name="back"/>返回</button>
        </header>
        <p className="empty">{gaveUp ? "这个会话已经不存在了" : "加载中…"}</p>
      </div>
    );
  }

  const terminalRun = !!run && messages.some(m=>m.runId===run.id && m.role==="system" && m.text.startsWith("已连接原终端"));
  const reason = sendBlockReason({ session, agents, running: active });
  // 运行中那行：有 run 就说 agent 自己的话；只读监听没有 run，只说「还没结束 + 多久没新记录」
  const listenSince = Date.parse(session.stateSince);
  const liveText = approvals.length > 0
    ? "等待你的确认"
    : listenLive
      ? `${listenLabel(session.eventAt, agentName(session.agent), now)}${isStuckRunning(session, now) ? "，可能已经停在那里" : ""}`
      : liveLabel(activity, agentName(session.agent));
  // 计时：有 run 按 run 起算；监听会话从进入运行态算起（state_since）
  const liveElapsed = run ? runElapsed(run, now) : Number.isNaN(listenSince) ? 0 : Math.max(0, now - listenSince);

  const guard = (key: "send" | "stop" | "spawn" | "terminal" | "link", fn: () => Promise<unknown>) => {
    setPending(key);
    setErr("");
    void (async () => {
      try {
        await fn();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setPending("");
      }
    })();
  };

  const send = () => {
    const t = text.trim();
    // 只有图片、没有文字也允许发送
    if (!t && !images.length) return;
    // 输入框随时能写（草稿先存着）；发送键这时是灰的，Ctrl+Enter 也要说清卡在哪
    if (reason) {
      setNote(reason);
      window.setTimeout(() => setNote(""), 3500);
      return;
    }
    if (pending === "send") return;
    stick.current = true; // 发送后跳到最新消息
    guard("send", async () => {
      await api.send(id, t, images);
      setText("");
      setImages([]);
      await reload();
    });
  };

  /** 选图/粘贴进来的文件：逐个压缩成 data URL，超出上限的直接提示 */
  const addImages = (files: File[]) => {
    const picked = pickImageFiles(files, images.length);
    if (picked.error) setNote(picked.error);
    if (!picked.files.length) return;
    void (async () => {
      const added = await Promise.all(
        picked.files.map(async (f) => {
          const url = await fileToDataUrl(f).catch(() => "");
          if (!url) return "";
          if (!fitsLimit(url)) {
            setNote("有图片压缩后仍太大，已跳过");
            return "";
          }
          return url;
        }),
      );
      const ok = added.filter(Boolean);
      if (ok.length) setImages((cur) => [...cur, ...ok].slice(0, MAX_IMAGES));
    })();
  };
  /**
   * 点图片按钮：Android 走系统相册（原生解码 HEIC 和拍摄方向），
   * 其余情况退回 input[type=file]（桌面选文件、老版本 APK 没有原生通道时）
   */
  const openPicker = () => {
    if (!canPickNative()) {
      fileRef.current?.click();
      return;
    }
    void (async () => {
      try {
        const r = await pickNativeImages(MAX_IMAGES - images.length);
        const picked = pickDataUrls(r.images, images.length);
        const msg = r.error || picked.error;
        if (msg) {
          setNote(msg);
          window.setTimeout(() => setNote(""), 3500);
        }
        if (picked.images.length) setImages((cur) => [...cur, ...picked.images].slice(0, MAX_IMAGES));
      } catch {
        setNote("打开相册失败，请重试");
        window.setTimeout(() => setNote(""), 3500);
      }
    })();
  };
  const startSpawn = () => {
    const t = spawnText.trim();
    if (!t) return;
    guard("spawn", async () => {
      const selected=branchMessage ? messages.find(m=>m.sourceId===branchMessage.sourceId && m.branchPoint===branchMessage.branchPoint) : null;
      if(branchMessage && !selected)throw new Error("回复记录发生变化，请重新选择分支位置");
      const r = await api.spawn(id, branchMessage ? "fork" : "fresh", t, selected?.id);
      setSpawnOpen(false);
      setSpawnText("");
      setBranchMessage(null);
      onSwitch(r.sessionId);
    });
  };
  const sessionKey = id.slice(id.indexOf(":") + 1);
  const pendingSession = isPendingSession(id);
  const canOpenInTerminal = isDesktop && session.machine === localMachine && !pendingSession && !isListenOnly(session.agent);
  const openInTerminal = () =>
    guard("terminal", async () => {
      const msg = await desktop.openInTerminal(session.agent, sessionKey, session.cwd);
      setNote(msg);
      window.setTimeout(() => setNote(""), 3500);
    });
  const stop = () => run && guard("stop", () => api.stop(run.id));
  // 打开对话流即视为处理：进来看这一轮，这条会话自动从待处理区撒下（不再单放「处理」按钮）。
  // 快照每几秒就换新对象，用 ref 记下已 ack 的会话，避免重复发请求；
  // 之后会话再次变回 pending（新一轮结束）时照样会再 ack 一次。
  const autoAcked = useRef(new Set<string>());
  useEffect(() => {
    if (!session || !isPending(session) || autoAcked.current.has(session.id)) return;
    autoAcked.current.add(session.id);
    onAck();
  }, [session, onAck]);
  // 手动同步电脑上的记录；失败要提示（自动同步失败才静默保留旧记录）
  const loadHistory = () => {
    if (syncing || !online) return;
    let gone = false;
    setSyncing(true);
    setErr("");
    api
      .history(id)
      .then(() => { if (!gone) return syncRef.current?.reload(); })
      .catch((e) => { if (!gone) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!gone) setSyncing(false); });
  };
  const decide = async (a: Approval, d: "allow" | "deny") => {
    setDeciding(a.id);
    setErr("");
    try {
      const qs = a.tool === "userInput" ? parseQuestions(a.detail) : null;
      await api.decide(a.id, d, qs ? Object.fromEntries(qs.map((q) => [q.id, picks[q.id] ?? []])) : undefined);
      if (qs) setPicks((p) => Object.fromEntries(Object.entries(p).filter(([k]) => !qs.some((q) => q.id === k))));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDeciding(null);
    }
  };
  const togglePick = (qid: string, label: string) =>
    setPicks((p) => {
      const cur = p[qid] ?? [];
      return { ...p, [qid]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] };
    });

  return (
    <div ref={pageRef} className={`session-page${docked && sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <header ref={headerRef}>
        <button className="back-button" onClick={onBack}><Icon name="back"/>返回</button>
        {!docked && (
          <button
            className="icon-button sidebar-open"
            aria-label="会话列表"
            title="会话列表"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((o) => !o)}
          >
            <Icon name="sessions" />
            {attentionCount > 0 && <span className="sidebar-open-dot" aria-hidden="true" />}
          </button>
        )}
        {docked && sidebarCollapsed && (
          <button className="icon-button sidebar-toggle" aria-label="展开会话列表" title="展开会话列表" onClick={() => setSidebarCollapsed(false)}>
            <Icon name="chevron" />
          </button>
        )}
        <span className={`tag ${session.agent}`}>{AGENT_LABEL[session.agent]}</span>
        <strong className="project">{session.project || "(未知项目)"}</strong>
        <span className="spacer" />
        <span className="machine">
          <span className="machine-text">{session.machine} · {STATE_LABEL[session.state] ?? session.state}</span>
          {!pendingSession && (
            <button
              className={`icon-button${syncing ? " spin" : ""}`}
              aria-label="刷新电脑上的记录"
              title={syncing ? "正在同步电脑上的记录…" : online ? "刷新电脑上的记录" : "电脑端不在线"}
              disabled={!online || syncing}
              onClick={loadHistory}
            >
              <Icon name="refresh" />
            </button>
          )}
        </span>
      </header>
      <div className="session-shell">
      {sidebarVisible && (
        <SessionSidebar
          sessions={sessions}
          currentId={id || sessionId}
          attention={attention}
          now={nowTick}
          onSelect={selectSession}
          drawer={!docked}
          onCollapse={() => (docked ? setSidebarCollapsed(true) : setDrawerOpen(false))}
        />
      )}
      {!docked && drawerOpen && (
        <button className="sidebar-scrim" aria-label="关闭会话列表" tabIndex={-1} onClick={() => setDrawerOpen(false)} />
      )}
      <div className="app session-view">
      {session.title && <div className="title wrap">{session.title}</div>}
      {/* 内部会话的首条气泡是 AgentHub 写的契约提示词（角色助手 / 意见细化），先说明白，别让人以为是自己发的 */}
      {isInternalSession(session) && <p className="hint">AgentHub 自动开的会话：首条消息是发给执行工具的指令原文，不是人写的对话。跑完的结果会回到对应的角色草稿或任务单上。</p>}
      {isDesktop && isListenOnly(session.agent) && session.machine === localMachine && <div className="btns"><button onClick={() => { setErr(""); desktop.focus(null, session.agent).catch((e) => setErr(e instanceof Error ? e.message : String(e))); }}>打开 {agentName(session.agent)} 客户端</button></div>}
      {/* 会话级操作合并为一行：任务关联、新建会话、终端打开 */}
      <div className="task-links">
        {tasks.filter(t=>t.sessionIds.includes(sessionId)).map(t=><button key={t.id} onClick={()=>onTask(t.id)}>{t.title}</button>)}
        <button onClick={()=>setLinkingTask(!linkingTask)} aria-expanded={linkingTask}>关联到任务</button>
        {!pendingSession && !isListenOnly(session.agent) && (
          <>
            <button onClick={() => {setBranchMessage(null);setSpawnText("");setSpawnOpen((o) => !o);}} disabled={!agents.includes(session.machine)} title={agents.includes(session.machine) ? "" : "电脑端不在线"}>
              同目录新建会话
            </button>
            {canOpenInTerminal && (
              <button onClick={openInTerminal} disabled={pending === "terminal" || active} title={active ? "AgentHub 正在运行这个会话，结束后再打开" : ""}>
                {session.agent === "codex" ? "打开 Codex Desktop" : "在终端打开"}
              </button>
            )}
          </>
        )}
      </div>
      {canOpenInTerminal && active && <p className="hint">AgentHub 正在运行这个会话，结束后再打开</p>}
      {linkingTask&&<div className="selection-panel"><p>选择未完成的任务</p>{tasks.filter(t=>t.status!=="done"&&!t.sessionIds.includes(sessionId)).map(t=><button key={t.id} className="entity-row" disabled={pending==="link"} onClick={()=>guard("link",async()=>{onTaskSaved(await api.linkSession(t.id,sessionId));setLinkingTask(false);})}>{t.title}</button>)}<QuickCreate placeholder="新建任务并关联…" create={async title=>{const task=await api.createTask({title});onTaskSaved(task);onTaskSaved(await api.linkSession(task.id,sessionId));setLinkingTask(false);}}/><div className="btns"><button onClick={()=>setLinkingTask(false)}>取消</button></div></div>}
      {spawnOpen && !pendingSession && (
        <div className="spawn-panel">
          <h2>{branchMessage ? "从此处分支到新聊天" : "同目录新建会话"}</h2>
          {branchMessage ? <><p className="hint">保留到所选回复为止的上下文，之后的消息不会带入。新聊天继续使用同一项目目录。</p><blockquote className="branch-preview"><Markdown text={branchMessage.text.slice(0,240)} compact />{branchMessage.text.length>240?"…":""}</blockquote></> : <p className="hint">使用当前项目目录，对话从零开始。</p>}
          <textarea aria-label="新会话的第一条消息" value={spawnText} onChange={(e) => setSpawnText(e.target.value)} placeholder="第一条消息…" rows={3} disabled={pending==="spawn"} />
          <div className="btns">
            <button onClick={() => {setSpawnOpen(false);setBranchMessage(null);}}>
              取消
            </button>
            <button className="primary" onClick={startSpawn} disabled={pending==="spawn" || !spawnText.trim() || (branchMessage!==null && (active || session.state==="running"))}>
              {branchMessage ? "创建分支并发送" : "开始"}
            </button>
          </div>
        </div>
      )}
      <main className="chat">
        {syncing && <p className="hint" role="status">正在同步电脑上的记录…</p>}
        {loading && <p className="empty">加载中…</p>}
        {!loading && messages.length === 0 && !syncing && <p className="empty">{isListenOnly(session.agent) ? `还没有同步到消息。${session.machine} 上报状态时会把 ${agentName(session.agent)} 的对话正文一起带上来，不用手动同步；一直空就说明那台电脑还没连上。继续对话请回到 ${agentName(session.agent)} 客户端。` : "还没有消息。可以发一条，或点右上角的刷新按钮同步电脑上的记录。"}</p>}
        <ul className="msgs">
          {messages.map((m) => (
            <li key={m.id} className={`message-entry ${m.role}`}>
              <div className={`msg ${m.role}`}>
                {/* 人和 agent 的话都按 markdown 渲染（都会贴表格、代码、路径）；
                    tool / system 行还是原文，终端输出里的符号不能被当成格式 */}
                {m.role === "user" || m.role === "assistant" ? <Markdown text={m.text} /> : m.text}
                {m.images?.map((src, i) => <img key={i} className="msg-image" src={src} alt={`消息图片 ${i + 1}`} onClick={() => setPreview(src)} />)}
              </div>
              <time className="msg-time" dateTime={m.createdAt} title={fullAt(m.createdAt)}>{clockAt(m.createdAt)}</time>
              {m.role==="assistant" && <MessageActions message={m} api={api}
                branchReason={isListenOnly(session.agent) ? `${agentName(session.agent)} 只读，暂不支持分支` : active || session.state==="running" ? "请等待会话运行结束" : !agents.includes(session.machine) ? "电脑端不在线" : !m.branchPoint ? "请刷新记录，或等待完整回复结束后再分支" : ""}
                rateReason={isListenOnly(session.agent) && !m.sourceId ? "只读会话的记录暂不支持评价" : undefined}
                onRated={updated=>setMessages(items=>items.map(item=>item.id===updated.id ? updated : item))}
                onBranch={()=>{setBranchMessage(m);setSpawnText("");setSpawnOpen(true);window.scrollTo({top:0,behavior:"auto"});}}/>}
            </li>
          ))}
        </ul>
        {/* 运行中：这行只播报 agent 自己说了什么（思考原文 / 工具 / 正在写的正文），不编状态 */}
        {((active && !terminalRun) || listenLive) && (
          <div className="live-row" role="status" aria-live="polite">
            <span className="live-dots" aria-hidden="true"><i /><i /><i /></span>
            <span className="live-text" title={liveText}>{liveText}</span>
            <span className="live-time">{formatElapsed(liveElapsed)}</span>
          </div>
        )}
        {/* 跑完：这一轮花了多久、烧了多少 token */}
        {run && !active && <p className="run-meta">{runSummary(run, now)}</p>}
        {run && run.status === "failed" && run.error && <p className="run-error">运行失败：{run.error}</p>}
        {/* 任务单：会话跑完后由项目经理排好「做什么、谁来做、在哪做」。
            正文很长，这里只留一个入口，点进去才展开全文，聊天流不被卡片挤满 */}
        {proposalCount > 0 && (
          <section className="proposal-entry">
            <button className="proposal-open" onClick={() => onProposals(sessionId)} aria-label={`查看任务单（${proposalCount} 份）`}>
              <Icon name="tasks" />
              <span className="proposal-open-main">
                <strong>任务单</strong>
                <span className="dim">{pendingProposals > 0 ? `${pendingProposals} 份待确认` : "都已处理"}</span>
              </span>
              {proposalCount > pendingProposals && <span className="proposal-count dim">共 {proposalCount} 份</span>}
              <Icon name="chevron" />
            </button>
          </section>
        )}
      </main>
      {/* 底部确认面板：待确认请求从屏幕底部弹出（参考 WorkBuddy），可收起为浮动徽标 */}
      {approvals.length > 0 && !sheetOpen && (
        <button className="approval-pill" onClick={() => setSheetCollapsed(false)}>
          {approvals.length} 项待确认，点击展开
        </button>
      )}
      {sheetOpen && (
        <>
          <div className="sheet-backdrop" onClick={() => setSheetCollapsed(true)} />
          <section className="approval-sheet" role="dialog" aria-modal="true" aria-label="待确认">
            <span className="sheet-grabber" aria-hidden="true" />
            <header className="sheet-head">
              <strong>待确认</strong>
              <button className="toast-close" aria-label="收起确认面板" onClick={() => setSheetCollapsed(true)}><Icon name="close" /></button>
            </header>
            {approvals.map((a) => {
              const qs = a.tool === "userInput" ? parseQuestions(a.detail) : null;
              if (!qs) return (
                <div key={a.id} className="approval-card">
                  <div className="approval-head">
                    <span>请求授权：<b>{a.tool}</b></span>
                    <time className="msg-time" dateTime={a.createdAt} title={fullAt(a.createdAt)}>{clockAt(a.createdAt)}</time>
                  </div>
                  <pre>{a.detail}</pre>
                  {a.decisionReason && (
                    <p className="approval-note">
                      <span className={`tier-badge ${a.decisionTier || "unknown"}`}>{APPROVAL_TIER_LABEL[a.decisionTier] ?? "交回给人"}</span>
                      项目经理看过了：{a.decisionReason}。需要你来定。
                    </p>
                  )}
                  <div className="btns">
                    <button className="primary" disabled={deciding === a.id} onClick={() => decide(a, "allow")}>
                      {deciding === a.id ? "处理中…" : "允许"}
                    </button>
                    <button disabled={deciding === a.id} onClick={() => decide(a, "deny")}>
                      {deciding === a.id ? "处理中…" : "拒绝"}
                    </button>
                  </div>
                </div>
              );
              return (
                <div key={a.id} className="approval-card user-input-card">
                  <div className="approval-head">
                    <span>Codex 提问</span>
                    <time className="msg-time" dateTime={a.createdAt} title={fullAt(a.createdAt)}>{clockAt(a.createdAt)}</time>
                  </div>
                  {qs.map((q) => (
                    <fieldset key={q.id} className="question-block">
                      <legend>{q.question}</legend>
                      {q.options.length > 0 && (
                        <div className="option-list">
                          {q.options.map((o) => {
                            const on = (picks[q.id] ?? []).includes(o.label);
                            return (
                              <button
                                key={o.label}
                                className="option-btn"
                                aria-pressed={on}
                                disabled={deciding === a.id}
                                onClick={() => togglePick(q.id, o.label)}
                              >
                                <span className="option-label">{o.label}</span>
                                {o.description && <small>{o.description}</small>}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </fieldset>
                  ))}
                  <div className="btns">
                    <button className="primary" disabled={deciding === a.id} onClick={() => decide(a, "allow")}>
                      {deciding === a.id ? "提交中…" : "提交回答"}
                    </button>
                    <button disabled={deciding === a.id} onClick={() => decide(a, "deny")}>
                      {deciding === a.id ? "处理中…" : "跳过"}
                    </button>
                  </div>
                  <p className="hint">不选直接提交会把空答案告诉 Codex；跳过后它会按自己的默认继续。</p>
                </div>
              );
            })}
          </section>
        </>
      )}
      {/* 图片预览浮层：点击消息里的图片打开，点击任意处或 Esc 关闭 */}
      {preview && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label="图片预览" onClick={() => setPreview(null)}>
          <img src={preview} alt="图片预览" />
        </div>
      )}
      {(err || note || speech.error) && (
        <div className="toast" role="status">
          <span className="toast-text">{err || note || speech.error}</span>
          <button className="toast-close" aria-label="关闭提示" onClick={() => { setErr(""); setNote(""); }}><Icon name="close" /></button>
        </div>
      )}
      {!spawnOpen && <footer className="composer">
        {reason && <p className="hint">{reason}</p>}
        {images.length > 0 && (
          <div className="composer-images">
            {images.map((src, i) => (
              <div className="composer-image" key={i}>
                <img src={src} alt={`待发送图片 ${i + 1}`} onClick={() => setPreview(src)} />
                <button
                  className="image-remove"
                  aria-label={`移除图片 ${i + 1}`}
                  disabled={pending === "send"}
                  onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))}
                >
                  <Icon name="close" />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          aria-label="会话消息"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            reason
              ? "先把想说的写在这儿，能发的时候再发…"
              : isAndroid
                ? "发消息给这个会话…"
                : "发消息给这个会话…（Ctrl+Enter 发送，可粘贴图片）"
          }
          rows={2}
          onPaste={(e) => {
            // 粘贴板里带图片（截图）时优先当附件，纯文字粘贴保持原样
            const files = Array.from(e.clipboardData?.files ?? []).filter((f) => ACCEPTED_TYPES.includes(f.type));
            if (!files.length) return;
            e.preventDefault();
            addImages(files);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send();
          }}
        />
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPTED_TYPES.join(",")}
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = ""; // 允许连续选同一张
            addImages(files);
          }}
        />
        <div className="btns">
          <button
            className="icon-button add-image"
            aria-label="添加图片"
            title={images.length >= MAX_IMAGES ? `最多附 ${MAX_IMAGES} 张图片` : `添加图片（最多 ${MAX_IMAGES} 张）`}
            disabled={pending === "send" || images.length >= MAX_IMAGES}
            onClick={openPicker}
          >
            <Icon name="plus" />
          </button>
          {active ? (
            <button onClick={stop} disabled={pending === "stop"}>
              {pending === "stop" ? "停止中…" : terminalRun ? "停止跟踪" : "停止"}
            </button>
          ) : null}
          <button className="primary" onClick={send} disabled={!!reason || pending === "send" || (!text.trim() && !images.length)}>
            {pending === "send" ? "发送中…" : "发送"}
          </button>
        </div>
      </footer>}
      </div>
      </div>
    </div>
  );
}
