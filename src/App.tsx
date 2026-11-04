import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Api, AUTH_EXPIRED_TEXT, connect, isPending, type Approval, type ConnState, type Session, type Goal, type Task, type Reminder, type TaskDigests, type BoardEntry } from "./lib/api";
import { desktop, isDesktop, loadConfig, saveConfig, type Config } from "./lib/platform";
import { onNotificationClick, pushNotification, type NotifyTarget } from "./lib/desktopNotify";
import SessionView from "./SessionView";
import { makeBus } from "./lib/sessionSync";
import { mergeEntity } from "./lib/taskSync";
import Settings from "./Settings";
import TasksPanel from "./TasksPanel";
import GoalsPanel from "./GoalsPanel";
import TaskView from "./TaskView";
import GoalView from "./GoalView";
import CalendarView from "./CalendarView";
import BoardPanel from "./BoardPanel";
import Icon from "./Icon";
import { AGENT_LABEL, isListenOnly } from "./lib/agents";
type Detail = {kind:"session";id:string} | {kind:"task"|"goal";id:number} | null;
type Tab = "sessions"|"tasks"|"board"|"goals"|"calendar";
const TAB_LABEL = { sessions:"会话", tasks:"任务", board:"看板", goals:"目标", calendar:"日历" } as const;

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
    case "unknown":
      return "本机记录缺失，状态未知";
    default:
      return `${t}登记`;
  }
}

// 通知都带上「点了要跳到哪」，点击后由 onNotificationClick 里统一处理
function notifyDesktop(s: Session) {
  return pushNotification(
    `${s.project || "会话"} · ${AGENT_LABEL[s.agent]} ${ALERT_LABEL[s.state] ?? ""}`.trim(),
    (s.summary || s.title).slice(0, 80),
    { kind: "session", id: s.id },
  );
}

/** Watchdog 升级提醒：只提醒不干预 */
function notifyWatchdog(issue: "stall" | "abort-spree", s: Session) {
  return pushNotification(
    `${s.project || "会话"} · ${AGENT_LABEL[s.agent]} ${issue === "stall" ? "可能卡住了" : "反复失败"}`,
    issue === "stall"
      ? `运行中超过 45 分钟没有新事件，点开看看要不要处理。${(s.summary || s.title).slice(0, 50)}`
      : `短时间内多次中断，点开看看要不要处理。${(s.summary || s.title).slice(0, 50)}`,
    { kind: "session", id: s.id },
  );
}

function notifyReminder(r: Reminder) {
  return pushNotification(
    `${r.entityType === "task" ? "任务" : "目标"} · ${r.kind === "start" ? "开始时间到了" : "已到截止时间"}`,
    r.title.slice(0, 100),
    { kind: r.entityType, id: r.entityId },
  );
}

function notifyApproval(a: Approval) {
  return pushNotification(
    `${a.project || "会话"} · 请求授权`,
    `${a.tool} ${a.detail}`.slice(0, 80),
    { kind: "session", id: a.sessionId },
  );
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
  const canFocus = isDesktop && s.machine === machine && (s.pid != null || s.agent === "codex" || isListenOnly(s.agent));
  return (
    <li className={`row clickable ${pending ? "pending" : ""} st-${s.state}`} onClick={onOpen}>
      <div className="row-head">
        <span className={`tag ${s.agent}`}>{AGENT_LABEL[s.agent]}</span>
        <button className="session-open" onClick={stop(onOpen)}>{s.project || "(未知项目)"}<span className="sr-only">：{s.title || "打开会话"}</span></button>
        <span className="machine">{s.machine}</span>
        {needsApproval ? <span className="badge">待授权</span> : isPending(s) && <span className="badge">{ALERT_LABEL[s.state]}</span>}
      </div>
      {s.title && <div className="title">{s.title}</div>}
      {s.summary && (
        <button className={`summary ${open ? "open" : ""}`} onClick={stop(() => setOpen(!open))} aria-expanded={open} title="点击展开/收起">
          {s.summary}
        </button>
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
  const [detail,setDetail] = useState<Detail>(null);
  const [tab,setTab] = useState<Tab>("sessions");
  const [goals,setGoals] = useState<Map<number,Goal>>(new Map());
  const [reminders,setReminders] = useState<Map<number,Reminder>>(new Map());
  const notifiedReminders = useRef(new Set<number>());
  const [tasks,setTasks] = useState<Map<number,Task>>(new Map());
  // 投机预摘要：taskId -> {review, failure}，由 WS task.digest 实时更新
  const [digests,setDigests] = useState<Map<number,TaskDigests>>(new Map());
  // 派活看板：排队 / 在跑 / 卡住 的聚合视图
  const [board,setBoard] = useState<{entries: BoardEntry[]; agents: string[]} | null>(null);
  const openId = detail?.kind === "session" ? detail.id : null;
  const [approvals, setApprovals] = useState<Map<string, Approval>>(new Map());
  const [agents, setAgents] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const bus = useMemo(() => makeBus(), []);
  const [now, setNow] = useState(Date.now());
  const [toast, setToast] = useState("");
  const [runSignal, setRunSignal] = useState(0);
  const cfgRef = useRef<Config | null>(null);
  cfgRef.current = cfg;
  const openIdRef = useRef<string | null>(null);
  const renamedIds = useRef(new Map<string,string>());
  openIdRef.current = openId;

  // 登录失效（任何请求 401 / WS 以 4401 关闭）：清掉本地 token，回到登录页并提示
  const expire = useCallback(() => {
    const c = cfgRef.current;
    if (!c || !c.token) return;
    const next: Config = { ...c, token: "", email: "" };
    cfgRef.current = next;
    setCfg(next);
    setNotice(AUTH_EXPIRED_TEXT);
    setDetail(null);
    setTab("sessions");
    window.history.replaceState({agenthub:true,detail:null,tab:"sessions"},"");
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

  // 派活看板：任务推进一步或 run 状态变化时重取（卡住判断依赖活跃 run）
  const refreshBoard = useCallback(() => {
    if (!api) { setBoard(null); return; }
    api.dispatchBoard().then(b=>setBoard({entries:b.entries,agents:b.agents}),()=>{});
  }, [api]);
  const boardSignature = useMemo(() => [...tasks.values()].map(t=>`${t.id}:${t.status}:${t.updatedAt}`).join(","), [tasks]);
  useEffect(() => { refreshBoard(); }, [refreshBoard, boardSignature, runSignal, agents.join(",")]);

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
      setGoals(new Map());
      setTasks(new Map());
      setDigests(new Map());
      setReminders(new Map());
      notifiedReminders.current.clear();
      setDetail(null);
      renamedIds.current.clear();
      return;
    }
    const receiveReminder = (r:Reminder) => {
      setReminders(m=>new Map(m).set(r.id,r));
      // notify === false：服务端按账号规则（免打扰时段/优先级/agent 静音）静音，只入列不弹通知
      if (r.notify !== false && !notifiedReminders.current.has(r.id) && isDesktop && cfgRef.current?.notifyDesktop) {
        notifiedReminders.current.add(r.id);
        void notifyReminder(r);
      }
    };
    return connect(api.url, api.token, {
      onState: (c) => {
        setConn(c);
        // 握手被 401 拒绝时浏览器只给 1006，没法区分；断线后探一下登录是否还有效（401 会触发 expire）
        if (c === "closed") api.me().catch(() => {});
      },
      onAuthExpired: expire,
      onSnapshot: (list, ag, aps, gs, ts, rs) => {
        setReminders(new Map(rs.map(r=>[r.id,r])));
        rs.forEach(receiveReminder);
        setSessions(new Map(list.map((s) => [s.id, s])));
        setAgents(ag);
        setApprovals(new Map(aps.filter((a) => a.status === "pending").map((a) => [a.id, a])));
        setGoals(new Map(gs.map(g=>[g.id,g])));
        setTasks(new Map(ts.map(t=>[t.id,t])));
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
        renamedIds.current.set(from,to);
        setSessions((m) => {
          if (!m.has(from)) return m;
          const n = new Map(m);
          n.delete(from);
          return n;
        });
        if (openIdRef.current === from) {
          // 不多压一层历史
          const next: Detail = {kind:"session",id:to};
          window.history.replaceState({...window.history.state,detail:next}, "");
          setDetail(next);
          openIdRef.current = to;
        }
        bus.emit({ kind: "resync" });
      },
      onRun: (r) => { setRunSignal(s => s + 1); bus.emit({ kind: "run", r }); },
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
      onWatchdog: (issue, s) => {
        if (isDesktop && cfgRef.current?.notifyDesktop) void notifyWatchdog(issue, s);
      },
      onAgents: setAgents,
      onReminder: receiveReminder,
      onReminderAck: id=>setReminders(m=>{const n=new Map(m);n.delete(id);return n;}),
      onGoal: g=>setGoals(m=>mergeEntity(m,g)),
      onGoalRemoved: id=>setGoals(m=>{const n=new Map(m);n.delete(id);return n;}),
      onTask: t=>setTasks(m=>mergeEntity(m,t)),
      onTaskDigest: (taskId,kind,digest)=>setDigests(m=>{const cur=m.get(taskId)??{review:null,failure:null};return new Map(m).set(taskId,{...cur,[kind]:digest} as TaskDigests);}),
      onTaskRemoved: id=>setTasks(m=>{const n=new Map(m);n.delete(id);return n;}),
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

  // 点击系统通知：先把主窗口叫到前台（Rust 侧 unminimize + show + 抢前台），再跳到对应条目
  const notifyNav = useRef<(t: NotifyTarget) => void>(() => {});
  notifyNav.current = (t) => {
    const nextTab: Tab = t.kind === "session" ? "sessions" : t.kind === "task" ? "tasks" : "goals";
    const next: Detail = t.kind === "session" ? { kind: "session", id: t.id } : { kind: t.kind, id: t.id };
    setTab(nextTab);
    window.history.pushState({ agenthub: true, detail: next, tab: nextTab }, "");
    setDetail(next);
  };
  useEffect(() => {
    if (!isDesktop) return;
    let off: (() => void) | undefined;
    let dead = false;
    void onNotificationClick((t) => {
      invoke("show_main_window").catch(() => {});
      if (t) notifyNav.current(t);
    }).then((u) => (dead ? u() : (off = u)));
    return () => {
      dead = true;
      off?.();
    };
  }, []);

  // 每层历史保存详情类型和标签，任务 → 会话 → 返回可恢复任务详情。
  const navigate = (next: Detail, replace=false) => {
    const state={agenthub:true,detail:next,tab};
    if(replace) window.history.replaceState(state,"");
    else window.history.pushState(state,"");
    setDetail(next);
  };
  const openSession = (id:string)=>navigate({kind:"session",id});
  const openTask = (id:number)=>navigate({kind:"task",id});
  const openGoal = (id:number)=>navigate({kind:"goal",id});
  // 从详情页跳到另一个会话（新开会话）：替换当前历史项，返回键仍然回到列表
  const switchSession = (id: string) => {
    navigate({kind:"session",id},detail?.kind === "session");
  };
  useEffect(() => {
    window.history.replaceState({agenthub:true,detail:null,tab:"sessions"},"");
    const onPop = (e:PopStateEvent) => {
      let next:Detail=e.state?.detail ?? null;
      if(next?.kind === "session") {
        const renamed=renamedIds.current.get(next.id);
        if(renamed) { next={kind:"session",id:renamed};window.history.replaceState({...e.state,detail:next},""); }
      }
      setDetail(next);setTab(e.state?.tab ?? "sessions");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const closeSession = () => {
    if (window.history.state?.detail) window.history.back();
    else setDetail(null);
  };
  const saveTask=(t:Task)=>setTasks(m=>mergeEntity(m,t,"response"));
  const saveGoal=(g:Goal)=>setGoals(m=>mergeEntity(m,g,"response"));
  const taskList=[...tasks.values()].sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt));
  const stuckCount = board?.entries.filter(e=>e.stuck).length ?? 0;
  const goalList=[...goals.values()].sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt));

  const activeReminders = [...reminders.values()].filter(r=>{
    const entity = r.entityType === "task" ? tasks.get(r.entityId) : goals.get(r.entityId);
    return entity && entity.status !== "done" && entity.status !== "archived" &&
      (r.kind === "start" ? entity.remindStart && entity.startAt === r.scheduledAt : entity.remindDue && entity.dueAt === r.scheduledAt);
  });
  const dismissReminder = async (id:number) => {
    try { await api?.ackReminder(id);setReminders(m=>{const n=new Map(m);n.delete(id);return n;}); }
    catch(e) { say(e instanceof Error ? e.message : String(e)); }
  };

  const focus = async (s: Session) => {
    try {
      // claude 会话把 sessionKey 传给后端：AgentHub 用命名窗口打开过的会话，
      // 跳转时除了把窗口带到前台，还能用 `wt focus-tab` 精确切到那个 tab
      const sessionKey = s.agent === "claude" ? s.id.slice(s.id.indexOf(":") + 1) : undefined;
      await desktop.focus(s.pid, s.agent, sessionKey);
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
        tasks={taskList}
        onTask={openTask}
        onTaskSaved={saveTask}
      />
    );
  }
  if (detail && api) {
    if(detail.kind === "task") {
      const task=tasks.get(detail.id);
      return task ? <TaskView key={task.id} task={task} goals={goalList} sessions={list} agents={agents} api={api} digest={digests.get(task.id)} onBack={closeSession} onSession={openSession} onSaved={saveTask} onDeleted={()=>{setTasks(m=>{const n=new Map(m);n.delete(task.id);return n;});closeSession();}}/> : <div className="app"><header><button onClick={closeSession}>返回</button></header><p className="empty">这个任务已经不存在了</p></div>;
    }
    if(detail.kind === "goal") {
      const goal=goals.get(detail.id);
      return goal ? <GoalView key={goal.id} goal={goal} tasks={taskList} api={api} onBack={closeSession} onTask={openTask} onSaved={saveGoal} onTaskSaved={saveTask} onDeleted={()=>{setGoals(m=>{const n=new Map(m);n.delete(goal.id);return n;});setTasks(m=>new Map([...m].map(([id,t])=>[id,t.goalId===goal.id ? {...t,goalId:null} : t])));closeSession();}}/> : <div className="app"><header><button onClick={closeSession}>返回</button></header><p className="empty">这个目标已经不存在了</p></div>;
    }
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
    <div className="app home">
      <header>
        <h1>AgentHub</h1>
        <span className="version" title={`版本 ${__APP_VERSION__}`}>v{__APP_VERSION__}</span>
        <span className={`conn ${conn}`}>
          <i /> {connText}
        </span>
        <span className="spacer" />
        <nav className="tabs" aria-label="主要功能">{(["sessions","tasks","board","goals","calendar"] as const).map(t=><button key={t} aria-current={tab===t ? "page" : undefined} className={tab===t ? "active" : ""} aria-label={TAB_LABEL[t]} onClick={()=>{setTab(t);window.history.replaceState({agenthub:true,detail:null,tab:t},"");}}><Icon name={t}/><span className="label">{TAB_LABEL[t]}</span>{t==="tasks" && taskList.some(t=>t.status==="review") && <span className="count" aria-label={`${taskList.filter(t=>t.status==="review").length} 个待验收任务`}>{taskList.filter(t=>t.status==="review").length}</span>}{t==="board" && stuckCount > 0 && <span className="count" aria-label={`${stuckCount} 个卡住的任务`}>{stuckCount}</span>}</button>)}</nav>
        <span className="spacer" />
        <button className="icon-button" aria-label="设置" title="设置" onClick={() => setView("settings")}><Icon name="settings" /></button>
      </header>
      {toast && <div className="toast" role="status">{toast}</div>}
      <main>
        {activeReminders.length > 0 && <section className="reminder-list" aria-label="时间提醒"><h2>时间提醒（{activeReminders.length}）</h2><ul className="list">{activeReminders.map(r=><li key={r.id} className="reminder-row"><button className="entity-row" onClick={()=>r.entityType === "task" ? openTask(r.entityId) : openGoal(r.entityId)}><span className="entity-main"><strong>{r.title}</strong><span>{r.entityType === "task" ? "任务" : "目标"} · {r.kind === "start" ? "开始时间到了" : "已到截止时间"} · {new Date(r.scheduledAt).toLocaleString()}</span></span></button><button onClick={()=>void dismissReminder(r.id)}>已处理</button></li>)}</ul></section>}
        <div hidden={tab!=="tasks"}>{api && <TasksPanel tasks={taskList} goals={goalList} onOpen={openTask} onCreate={async title=>saveTask(await api.createTask({title}))}/>}</div>
        <div hidden={tab!=="board"}>{board && api && <BoardPanel api={api} board={board} now={now} onRefresh={refreshBoard} onOpen={openTask} onNotice={say}/>}</div>
        <div hidden={tab!=="goals"}>{api && <GoalsPanel goals={goalList} tasks={taskList} onOpen={openGoal} onCreate={async (title,priority)=>saveGoal(await api.createGoal({title,priority}))}/>}</div>
        <div hidden={tab!=="calendar"}>{api && <CalendarView api={api} sessions={list} tasks={taskList} goals={goalList} runSignal={runSignal} onOpenSession={openSession} onOpenTask={openTask} onOpenGoal={openGoal}/>}</div>
        <div hidden={tab!=="sessions"}>
        <div className="page-heading"><div><p className="eyebrow">工作空间</p><h2>会话</h2><p>关注运行进展，及时处理需要你的事项。</p></div>{pending.length > 0 && <button onClick={ackAll}>全部已处理</button>}</div>
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
        </div>
      </main>
    </div>
  );
}
