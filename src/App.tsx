import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Api, AUTH_EXPIRED_TEXT, connect, isPending, type Approval, type ConnState, type Session } from "./lib/api";
import { desktop, isDesktop, loadConfig, saveConfig, type Config } from "./lib/platform";
import SessionView from "./SessionView";
import { makeBus } from "./lib/sessionSync";
import Settings from "./Settings";

const AGENT_LABEL = { claude: "Claude", codex: "Codex" } as const;
const ALERT_LABEL: Record<string, string> = { done: "已完成", waiting: "等待授权", aborted: "已中断" };

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

function sinceText(s: Session, now: number): string {
  const t = ago(s.stateSince, now);
  switch (s.state) {
    case "done":
      return `${t}完成`;
    case "waiting":
      return `${t}开始等待授权`;
    case "aborted":
      return `${t}中断`;
    case "running":
      return `${t}开始运行`;
    case "ended":
      return `${t}结束`;
    default:
      return `${t}登记`;
  }
}

async function notifyDesktop(s: Session) {
  try {
    const n = await import("@tauri-apps/plugin-notification");
    let ok = await n.isPermissionGranted();
    if (!ok) ok = (await n.requestPermission()) === "granted";
    if (!ok) return;
    n.sendNotification({
      title: `${s.project || "会话"} · ${AGENT_LABEL[s.agent]} ${ALERT_LABEL[s.state] ?? ""}`.trim(),
      body: (s.summary || s.title).slice(0, 80),
    });
  } catch {
    /* 通知失败不影响主流程 */
  }
}

async function notifyApproval(a: Approval) {
  try {
    const n = await import("@tauri-apps/plugin-notification");
    let ok = await n.isPermissionGranted();
    if (!ok) ok = (await n.requestPermission()) === "granted";
    if (!ok) return;
    n.sendNotification({ title: `${a.project || "会话"} · 请求授权`, body: `${a.tool} ${a.detail}`.slice(0, 80) });
  } catch {
    /* 通知失败不影响主流程 */
  }
}

function Row({
  s,
  now,
  machine,
  needsApproval,
  onOpen,
  onAck,
  onFocus,
}: {
  s: Session;
  now: number;
  machine: string;
  needsApproval: boolean;
  onOpen(): void;
  onAck(): void;
  onFocus(): void;
}) {
  const [open, setOpen] = useState(false);
  const pending = isPending(s) || needsApproval;
  const stop = (fn: () => void) => (e: { stopPropagation(): void }) => {
    e.stopPropagation();
    fn();
  };
  const canFocus = isDesktop && s.machine === machine && (s.pid != null || s.agent === "codex");
  return (
    <li className={`row clickable ${pending ? "pending" : ""} st-${s.state}`} onClick={onOpen}>
      <div className="row-head">
        <span className={`tag ${s.agent}`}>{AGENT_LABEL[s.agent]}</span>
        <strong className="project">{s.project || "(未知项目)"}</strong>
        <span className="machine">{s.machine}</span>
        {needsApproval ? <span className="badge">待授权</span> : isPending(s) && <span className="badge">{ALERT_LABEL[s.state]}</span>}
      </div>
      {s.title && <div className="title">{s.title}</div>}
      {s.summary && (
        <div className={`summary ${open ? "open" : ""}`} onClick={stop(() => setOpen(!open))} title="点击展开/收起">
          {s.summary}
        </div>
      )}
      <div className="row-foot">
        <span className="since">{sinceText(s, now)}</span>
        <span className="actions">
          {canFocus && (
            <button className="link" onClick={stop(onFocus)}>
              跳转
            </button>
          )}
          {isPending(s) && (
            <button className="link" onClick={stop(onAck)}>
              已处理
            </button>
          )}
        </span>
      </div>
    </li>
  );
}

export default function App() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [sessions, setSessions] = useState<Map<string, Session>>(new Map());
  const [conn, setConn] = useState<ConnState>("closed");
  const [view, setView] = useState<"list" | "settings">("list");
  const [openId, setOpenId] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<Map<string, Approval>>(new Map());
  const [agents, setAgents] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const bus = useMemo(() => makeBus(), []);
  const [now, setNow] = useState(Date.now());
  const [toast, setToast] = useState("");
  const cfgRef = useRef<Config | null>(null);
  cfgRef.current = cfg;
  const openIdRef = useRef<string | null>(null);
  openIdRef.current = openId;

  // 登录失效（任何请求 401 / WS 以 4401 关闭）：清掉本地 token，回到登录页并提示
  const expire = useCallback(() => {
    const c = cfgRef.current;
    if (!c || !c.token) return;
    const next: Config = { ...c, token: "", email: "" };
    cfgRef.current = next;
    setCfg(next);
    setNotice(AUTH_EXPIRED_TEXT);
    setOpenId(null);
    saveConfig(next).catch(() => {});
  }, []);

  const api = useMemo(
    () => (cfg?.serverUrl && cfg.token ? new Api(cfg.serverUrl, cfg.token, expire) : null),
    [cfg?.serverUrl, cfg?.token, expire],
  );

  const say = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast(""), 3500);
  }, []);

  useEffect(() => {
    loadConfig().then(setCfg);
  }, []);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(t);
  }, []);

  // WebSocket 实时更新（桌面端主窗口隐藏时 webview 仍在跑，由它维持连接）
  useEffect(() => {
    if (!api) {
      setConn("closed");
      setSessions(new Map());
      setApprovals(new Map());
      setAgents([]);
      return;
    }
    return connect(api.url, api.token, {
      onState: (c) => {
        setConn(c);
        // 握手被 401 拒绝时浏览器只给 1006，没法区分；断线后探一下登录是否还有效（401 会触发 expire）
        if (c === "closed") api.me().catch(() => {});
      },
      onAuthExpired: expire,
      onSnapshot: (list, ag, aps) => {
        setSessions(new Map(list.map((s) => [s.id, s])));
        setAgents(ag);
        setApprovals(new Map(aps.filter((a) => a.status === "pending").map((a) => [a.id, a])));
        bus.emit({ kind: "resync" });
      },
      onSession: (s, notify) => {
        setSessions((m) => new Map(m).set(s.id, s));
        // Android 前端不弹通知（交给原生服务，避免重复）
        if (notify && isDesktop && cfgRef.current?.notifyDesktop) void notifyDesktop(s);
      },
      onRemoved: (id) =>
        setSessions((m) => {
          const n = new Map(m);
          n.delete(id);
          return n;
        }),
      onRenamed: (from, to) => {
        setSessions((m) => {
          if (!m.has(from)) return m;
          const n = new Map(m);
          n.delete(from);
          return n;
        });
        if (openIdRef.current === from) {
          // 不多压一层历史
          if (window.history.state?.agenthub === "session") window.history.replaceState({ agenthub: "session" }, "");
          setOpenId(to);
          openIdRef.current = to;
        }
        bus.emit({ kind: "resync" });
      },
      onRun: (r) => bus.emit({ kind: "run", r }),
      onMessage: (m) => bus.emit({ kind: "message", m }),
      onApproval: (a, notify) => {
        setApprovals((m) => {
          const n = new Map(m);
          if (a.status === "pending") n.set(a.id, a);
          else n.delete(a.id);
          return n;
        });
        if (notify && a.status === "pending" && isDesktop && cfgRef.current?.notifyDesktop) void notifyApproval(a);
      },
      onAgents: setAgents,
    });
  }, [api, bus, expire]);

  const list = useMemo(() => [...sessions.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)), [sessions]);
  const approvalSessions = useMemo(() => new Set([...approvals.values()].map((a) => a.sessionId)), [approvals]);
  const needsAttention = (s: Session) => isPending(s) || approvalSessions.has(s.id);
  const pending = list.filter(needsAttention);
  const running = list.filter((s) => !needsAttention(s) && s.state === "running");
  const others = list.filter((s) => !needsAttention(s) && s.state !== "running");

  useEffect(() => {
    if (isDesktop) desktop.setBadge(pending.length).catch(() => {});
  }, [pending.length]);

  const ack = useCallback(
    (id: string) => api?.ack(id).catch((e) => say(String(e.message ?? e))),
    [api, say],
  );
  const ackAll = useCallback(() => api?.ackAll().catch((e) => say(String(e.message ?? e))), [api, say]);

  useEffect(() => {
    if (!isDesktop) return;
    let un: (() => void) | undefined;
    import("@tauri-apps/api/event").then(({ listen }) => listen("tray-ack-all", () => void ackAll()).then((f) => (un = f)));
    return () => un?.();
  }, [ackAll]);

  // 进入详情页时 pushState，这样 Android 返回键 / 浏览器后退能回到列表
  const openSession = (id: string) => {
    window.history.pushState({ agenthub: "session" }, "");
    setOpenId(id);
  };
  // 从详情页跳到另一个会话（新开会话）：替换当前历史项，返回键仍然回到列表
  const switchSession = (id: string) => {
    if (window.history.state?.agenthub === "session") window.history.replaceState({ agenthub: "session" }, "");
    else window.history.pushState({ agenthub: "session" }, "");
    setOpenId(id);
  };
  useEffect(() => {
    const onPop = () => setOpenId(null);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const closeSession = () => {
    if (window.history.state?.agenthub === "session") window.history.back();
    else setOpenId(null);
  };

  const focus = async (s: Session) => {
    try {
      await desktop.focus(s.pid, s.agent);
      await ack(s.id);
    } catch (e) {
      say(String(e));
    }
  };

  if (!cfg) return null;
  // 没登录：直接显示登录页
  if (!cfg.token.trim() || view === "settings") {
    return (
      <Settings
        cfg={cfg}
        api={api}
        notice={notice}
        onClose={() => setView("list")}
        onSaved={(c) => {
          setCfg(c);
          setNotice("");
          setView("list");
        }}
      />
    );
  }

  if (openId && api) {
    return (
      <SessionView
        sessionId={openId}
        session={sessions.get(openId)}
        localMachine={cfg.machine}
        onSwitch={switchSession}
        api={api}
        bus={bus}
        approvals={[...approvals.values()].filter((a) => a.sessionId === openId)}
        agents={agents}
        onBack={closeSession}
      />
    );
  }

  const connText = { open: "已连接", connecting: "连接中…", closed: api ? "已断开，重连中" : "未配置服务器" }[conn];
  const renderList = (items: Session[]) => (
    <ul className="list">
      {items.map((s) => (
        <Row
          key={s.id}
          s={s}
          now={now}
          machine={cfg.machine}
          needsApproval={approvalSessions.has(s.id)}
          onOpen={() => openSession(s.id)}
          onAck={() => ack(s.id)}
          onFocus={() => focus(s)}
        />
      ))}
    </ul>
  );

  return (
    <div className="app">
      <header>
        <h1>AgentHub</h1>
        <span className={`conn ${conn}`}>
          <i /> {connText}
        </span>
        <span className="spacer" />
        {pending.length > 0 && (
          <button onClick={ackAll} className="primary">
            全部已处理
          </button>
        )}
        <button onClick={() => setView("settings")}>设置</button>
      </header>
      {toast && <div className="toast">{toast}</div>}
      <main>
        <section>
          <h2>待处理 {pending.length > 0 && <span className="count">{pending.length}</span>}</h2>
          {pending.length ? renderList(pending) : <p className="empty">没有待处理的会话</p>}
        </section>
        <section>
          <h2>运行中 {running.length > 0 && <span className="count dim">{running.length}</span>}</h2>
          {running.length ? renderList(running) : <p className="empty">没有运行中的会话</p>}
        </section>
        <details>
          <summary>其它（{others.length}）</summary>
          {others.length ? renderList(others) : <p className="empty">空</p>}
        </details>
      </main>
    </div>
  );
}
