import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isRunActive, type Api, type Approval, type Message, type Run, type Session, type Task } from "./lib/api";
import { desktop, isDesktop } from "./lib/platform";
import { syncSession, type Bus } from "./lib/sessionSync";
import { QuickCreate } from "./TasksPanel";
import Icon from "./Icon";
import MessageActions from "./MessageActions";
import { speechSnapshot, subscribeSpeech, stopSpeech } from "./lib/speech";
import { AGENT_LABEL, agentName, isListenOnly } from "./lib/agents";
import { clockAt, fullAt } from "./lib/time";

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
};

/** 不能发消息的原因；null 表示可以发 */
export const isPendingSession = (id: string) => id.includes(":pending-");

export function sendBlockReason(p: { session: Session; agents: string[]; running: boolean }): string | null {
  if (isListenOnly(p.session.agent)) return `${agentName(p.session.agent)} 目前支持状态监听，请在 ${agentName(p.session.agent)} 中继续对话`;
  if (isPendingSession(p.session.id)) return p.session.state === "running" ? "新会话正在启动…" : "这个新会话没能启动";
  if (!p.agents.includes(p.session.machine)) return "电脑端不在线";
  if (p.running) return "这个会话正在运行";
  if (p.session.agent === "codex" && p.session.state === "running") return "这个 Codex 会话正在 Desktop 里运行，等它结束后再发";
  return null;
}

const NOT_FOUND_GRACE_MS = 5000;

export default function SessionView({ sessionId, session, localMachine, onSwitch, api, bus, approvals, agents, onBack, tasks, onTask, onTaskSaved }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  /** 细粒度操作锁：哪类操作在等待就只锁哪类按钮，避免"点一个按钮全页变灰" */
  const [pending, setPending] = useState<"" | "send" | "stop" | "spawn" | "terminal" | "link">("");
  const [deciding, setDeciding] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState("");
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [branchMessage, setBranchMessage] = useState<Message|null>(null);
  const speech=useSyncExternalStore(subscribeSpeech,speechSnapshot);
  useEffect(()=>()=>stopSpeech(),[sessionId]);
  const [spawnText, setSpawnText] = useState("");
  const [gaveUp, setGaveUp] = useState(false);
  const [linkingTask,setLinkingTask] = useState(false);
  /** 用户是否停留在消息底部：底部附近才跟随新消息滚动，往上翻历史时不打断 */
  const stick = useRef(true);
  const id = session?.id ?? "";

  const syncRef = useRef<ReturnType<typeof syncSession> | null>(null);
  const reload = () => syncRef.current?.reload();
  useEffect(() => {
    if (!id) return;
    setMessages([]);
    setRun(null);
    setLoading(true);
    setErr("");
    stick.current = true; // 切换会话后重新跟随底部
    const sync = syncSession(api, id, bus, (data) => {
      setMessages(data.messages);
      setRun(data.run);
    }, (e) => setErr(e instanceof Error ? e.message : String(e)), () => setLoading(false));
    syncRef.current = sync;
    void sync.reload();
    return () => { sync.dispose(); syncRef.current = null; };
  }, [api, bus, id]);

  // 打开详情页时自动从电脑上拉一次最新记录（服务端存的可能是旧的）；每个会话只自动拉一次
  const online = !!session && agents.includes(session.machine);
  const [syncing, setSyncing] = useState(false);
  const autoLoaded = useRef("");
  useEffect(() => {
    if (!id || !online || isListenOnly(session?.agent) || isPendingSession(id) || autoLoaded.current === id) return;
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

  // Esc 关闭浮层面板（分支/新建会话、关联任务）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setSpawnOpen(false);
      setBranchMessage(null);
      setLinkingTask(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 跟随滚动：只有本来就停在底部附近时才自动滚到最新消息
  useEffect(() => {
    const onScroll = () => {
      const doc = document.documentElement;
      stick.current = window.innerHeight + window.scrollY >= doc.scrollHeight - 160;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
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

  const active = isRunActive(run);
  const terminalRun = !!run && messages.some(m=>m.runId===run.id && m.role==="system" && m.text.startsWith("已连接原终端"));
  const reason = sendBlockReason({ session, agents, running: active });

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
    if (!t || reason || pending === "send") return;
    stick.current = true; // 发送后跳到最新消息
    guard("send", async () => {
      await api.send(id, t);
      setText("");
      await reload();
    });
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
  // 手动同步电脑上的记录；失败要提示（自动同步失败才静默保留旧记录）
  const loadHistory = () => {
    if (syncing || !online || isListenOnly(session.agent)) return;
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
      await api.decide(a.id, d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDeciding(null);
    }
  };

  return (
    <div className="app session-view">
      <header>
        <button className="back-button" onClick={onBack}><Icon name="back"/>返回</button>
        <span className={`tag ${session.agent}`}>{AGENT_LABEL[session.agent]}</span>
        <strong className="project">{session.project || "(未知项目)"}</strong>
        <span className="spacer" />
        <span className="machine">
          <span className="machine-text">{session.machine} · {STATE_LABEL[session.state] ?? session.state}</span>
          {!pendingSession && !isListenOnly(session.agent) && (
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
      {session.title && <div className="title wrap">{session.title}</div>}
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
          {branchMessage ? <><p className="hint">保留到所选回复为止的上下文，之后的消息不会带入。新聊天继续使用同一项目目录。</p><blockquote className="branch-preview">{branchMessage.text.slice(0,240)}{branchMessage.text.length>240?"…":""}</blockquote></> : <p className="hint">使用当前项目目录，对话从零开始。</p>}
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
        {!loading && messages.length === 0 && !syncing && <p className="empty">{isListenOnly(session.agent) ? `正在监听 ${agentName(session.agent)} 会话状态，暂不提供完整对话记录。请在 ${agentName(session.agent)} 中查看和继续对话。` : "还没有消息。可以发一条，或点右上角的刷新按钮同步电脑上的记录。"}</p>}
        <ul className="msgs">
          {messages.map((m) => (
            <li key={m.id} className={`message-entry ${m.role}`}>
              <div className={`msg ${m.role}`}>{m.text}</div>
              <time className="msg-time" dateTime={m.createdAt} title={fullAt(m.createdAt)}>{clockAt(m.createdAt)}</time>
              {m.role==="assistant" && <MessageActions message={m} api={api}
                branchReason={active || session.state==="running" ? "请等待会话运行结束" : !agents.includes(session.machine) ? "电脑端不在线" : !m.branchPoint ? "请刷新记录，或等待完整回复结束后再分支" : ""}
                onRated={updated=>setMessages(items=>items.map(item=>item.id===updated.id ? updated : item))}
                onBranch={()=>{setBranchMessage(m);setSpawnText("");setSpawnOpen(true);window.scrollTo({top:0,behavior:"auto"});}}/>}
            </li>
          ))}
        </ul>
        {approvals.map((a) => (
          <div key={a.id} className="approval-card">
            <div className="approval-head">
              <span>请求授权：<b>{a.tool}</b></span>
              <time className="msg-time" dateTime={a.createdAt} title={fullAt(a.createdAt)}>{clockAt(a.createdAt)}</time>
            </div>
            <pre>{a.detail}</pre>
            <div className="btns">
              <button className="primary" disabled={deciding === a.id} onClick={() => decide(a, "allow")}>
                {deciding === a.id ? "处理中…" : "允许"}
              </button>
              <button disabled={deciding === a.id} onClick={() => decide(a, "deny")}>
                {deciding === a.id ? "处理中…" : "拒绝"}
              </button>
            </div>
          </div>
        ))}
        {run && run.status === "failed" && run.error && <p className="run-error">运行失败：{run.error}</p>}
      </main>
      {(err || note || speech.error) && (
        <div className="toast" role="status">
          <span className="toast-text">{err || note || speech.error}</span>
          <button className="toast-close" aria-label="关闭提示" onClick={() => { setErr(""); setNote(""); }}><Icon name="close" /></button>
        </div>
      )}
      {!spawnOpen && <footer className="composer">
        {reason && <p className="hint">{reason}</p>}
        <textarea
          aria-label="会话消息"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={reason ?? "发消息给这个会话…（Ctrl+Enter 发送）"}
          disabled={!!reason}
          rows={2}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send();
          }}
        />
        <div className="btns">
          {active ? (
            <button onClick={stop} disabled={pending === "stop"}>
              {pending === "stop" ? "停止中…" : terminalRun ? "停止跟踪" : "停止"}
            </button>
          ) : null}
          <button className="primary" onClick={send} disabled={!!reason || pending === "send" || !text.trim()}>
            {pending === "send" ? "发送中…" : "发送"}
          </button>
        </div>
      </footer>}
    </div>
  );
}
