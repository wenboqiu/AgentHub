import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Api, AUTH_EXPIRED_TEXT, connect, isPending, type Approval, type ConnState, type Session, type Goal, type Task, type Reminder } from "./lib/api";
import { desktop, isDesktop, loadConfig, saveConfig, type Config } from "./lib/platform";
import SessionView from "./SessionView";
import { makeBus } from "./lib/sessionSync";
import { mergeEntity } from "./lib/taskSync";
import Settings from "./Settings";
import TasksPanel from "./TasksPanel";
import GoalsPanel from "./GoalsPanel";
import TaskView from "./TaskView";
import GoalView from "./GoalView";
import CalendarView from "./CalendarView";
import Icon from "./Icon";
type Detail = {kind:"session";id:string} | {kind:"task"|"goal";id:number} | null;
type Tab = "sessions"|"tasks"|"goals"|"calendar";

const AGENT_LABEL = { claude: "Claude", codex: "Codex", doubao: "豆包" } as const;
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

async function notifyReminder(r: Reminder) {
  try {
    const n = await import("@tauri-apps/plugin-notification");
    let ok = await n.isPermissionGranted();
    if (!ok) ok = (await n.requestPermission()) === "granted";
    if (ok) n.sendNotification({title:`${r.entityType === "task" ? "任务" : "目标"} · ${r.kind === "start" ? "开始时间到了" : "已到截止时间"}`,body:r.title.slice(0,100)});
  } catch { /* 应用内仍保留待处理提醒 */ }
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
  const canFocus = isDesktop && s.machine === machine && (s.pid != null || s.agent === "codex" || s.agent === "doubao");
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
      setReminders(new Map());
      notifiedReminders.current.clear();
      setDetail(null);
      renamedIds.current.clear();
      return;
    }
    const receiveReminder = (r:Reminder) => {
      setReminders(m=>new Map(m).set(r.id,r));
      if (!notifiedReminders.current.has(r.id) && isDesktop && cfgRef.current?.notifyDesktop) {
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
      onAgents: setAgents,
      onReminder: receiveReminder,
      onReminderAck: id=>setReminders(m=>{const n=new Map(m);n.delete(id);return n;}),
      onGoal: g=>setGoals(m=>mergeEntity(m,g)),
      onGoalRemoved: id=>setGoals(m=>{const n=new Map(m);n.delete(id);return n;}),
      onTask: t=>setTasks(m=>mergeEntity(m,t)),
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
        tasks={taskList}
        onTask={openTask}
        onTaskSaved={saveTask}
      />
    );
  }
  if (detail && api) {
    if(detail.kind === "task") {
      const task=tasks.get(detail.id);
      return task ? <TaskView key={task.id} task={task} goals={goalList} sessions={list} agents={agents} api={api} onBack={closeSession} onSession={openSession} onSaved={saveTask} onDeleted={()=>{setTasks(m=>{const n=new Map(m);n.delete(task.id);return n;});closeSession();}}/> : <div className="app"><header><button onClick={closeSession}>返回</button></header><p className="empty">这个任务已经不存在了</p></div>;
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
        <span className={`conn ${conn}`}>
          <i /> {connText}
        </span>
        <span className="spacer" />
        <button className="icon-button" aria-label="设置" title="设置" onClick={() => setView("settings")}><Icon name="settings" /></button>
      </header>
      <nav className="tabs" aria-label="主要功能">{(["sessions","tasks","goals","calendar"] as const).map(t=><button key={t} aria-current={tab===t ? "page" : undefined} className={tab===t ? "active" : ""} onClick={()=>{setTab(t);window.history.replaceState({agenthub:true,detail:null,tab:t},"");}}><Icon name={t}/><span>{{sessions:"会话",tasks:"任务",goals:"目标",calendar:"日历"}[t]}</span>{t==="tasks" && taskList.some(t=>t.status==="review") && <span className="count" aria-label={`${taskList.filter(t=>t.status==="review").length} 个待验收任务`}>{taskList.filter(t=>t.status==="review").length}</span>}</button>)}</nav>
      {toast && <div className="toast" role="status">{toast}</div>}
      <main>
        {activeReminders.length > 0 && <section className="reminder-list" aria-label="时间提醒"><h2>时间提醒（{activeReminders.length}）</h2><ul className="list">{activeReminders.map(r=><li key={r.id} className="reminder-row"><button className="entity-row" onClick={()=>r.entityType === "task" ? openTask(r.entityId) : openGoal(r.entityId)}><span className="entity-main"><strong>{r.title}</strong><span>{r.entityType === "task" ? "任务" : "目标"} · {r.kind === "start" ? "开始时间到了" : "已到截止时间"} · {new Date(r.scheduledAt).toLocaleString()}</span></span></button><button onClick={()=>void dismissReminder(r.id)}>已处理</button></li>)}</ul></section>}
        <div hidden={tab!=="tasks"}>{api && <TasksPanel tasks={taskList} goals={goalList} onOpen={openTask} onCreate={async title=>saveTask(await api.createTask({title}))}/>}</div>
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
