import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isRunActive, type Api, type Approval, type Message, type Run, type Session, type Task } from "./lib/api";
import { desktop, isDesktop } from "./lib/platform";
import { syncSession, type Bus } from "./lib/sessionSync";
import { QuickCreate } from "./TasksPanel";
import Icon from "./Icon";
import MessageActions from "./MessageActions";
import { speechSnapshot, subscribeSpeech, stopSpeech } from "./lib/speech";

const AGENT_LABEL = { claude: "Claude", codex: "Codex", doubao: "豆包" } as const;
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
  if (p.session.agent === "doubao") return "豆包目前支持状态监听，请在豆包客户端中继续对话";
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
  const [busy, setBusy] = useState(false);
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
  const endRef = useRef<HTMLDivElement>(null);
  const id = session?.id ?? "";

  const syncRef = useRef<ReturnType<typeof syncSession> | null>(null);
  const reload = () => syncRef.current?.reload();
  useEffect(() => {
    if (!id) return;
    setMessages([]);
    setRun(null);
    setLoading(true);
    setErr("");
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
    if (!id || !online || session?.agent === "doubao" || isPendingSession(id) || autoLoaded.current === id) return;
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
  }, [sessionId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, approvals.length]);

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

  const guard = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const send = () => {
    const t = text.trim();
    if (!t || reason) return;
    void guard(async () => {
      await api.send(id, t);
      setText("");
      await reload();
    });
  };
  const startSpawn = () => {
    const t = spawnText.trim();
    if (!t) return;
    void guard(async () => {
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
  const canOpenInTerminal = isDesktop && session.machine === localMachine && !pendingSession && session.agent !== "doubao";
  const openInTerminal = () =>
    void guard(async () => {
      const msg = await desktop.openInTerminal(session.agent, sessionKey, session.cwd);
      setNote(msg);
      window.setTimeout(() => setNote(""), 3500);
    });
  const stop = () => run && void guard(() => api.stop(run.id));
  const loadHistory = () =>
    void guard(async () => {
      await api.history(id);
      await reload();
    });
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
          {session.machine} · {STATE_LABEL[session.state] ?? session.state}
        </span>
      </header>
      {session.title && <div className="title wrap">{session.title}</div>}
      {isDesktop && session.agent === "doubao" && session.machine === localMachine && <div className="btns"><button onClick={() => void guard(() => desktop.focus(null, "doubao"))}>打开豆包客户端</button></div>}
      <div className="task-links">{tasks.filter(t=>t.sessionIds.includes(sessionId)).map(t=><button key={t.id} onClick={()=>onTask(t.id)}>{t.title}</button>)}<button onClick={()=>setLinkingTask(!linkingTask)}>关联到任务</button></div>
      {linkingTask&&<div className="selection-panel"><p>选择未完成的任务</p>{tasks.filter(t=>t.status!=="done"&&!t.sessionIds.includes(sessionId)).map(t=><button key={t.id} className="entity-row" disabled={busy} onClick={()=>void guard(async()=>{onTaskSaved(await api.linkSession(t.id,sessionId));setLinkingTask(false);})}>{t.title}</button>)}<QuickCreate placeholder="新建任务并关联…" create={async title=>{const task=await api.createTask({title});onTaskSaved(task);onTaskSaved(await api.linkSession(task.id,sessionId));setLinkingTask(false);}}/></div>}
      {!pendingSession && session.agent !== "doubao" && (
        <div className="btns">
          <button onClick={() => {setBranchMessage(null);setSpawnText("");setSpawnOpen((o) => !o);}} disabled={busy || !agents.includes(session.machine)} title={agents.includes(session.machine) ? "" : "电脑端不在线"}>
            同目录新建会话
          </button>
          {canOpenInTerminal && (
            <button onClick={openInTerminal} disabled={busy || active} title={active ? "AgentHub 正在运行这个会话，结束后再打开" : ""}>
              {session.agent === "codex" ? "打开 Codex Desktop" : "在终端打开"}
            </button>
          )}
        </div>
      )}
      {canOpenInTerminal && active && <p className="hint">AgentHub 正在运行这个会话，结束后再打开</p>}
      {spawnOpen && !pendingSession && (
        <div className="spawn-panel">
          <h2>{branchMessage ? "从此处分支到新聊天" : "同目录新建会话"}</h2>
          {branchMessage ? <><p className="hint">保留到所选回复为止的上下文，之后的消息不会带入。新聊天继续使用同一项目目录。</p><blockquote className="branch-preview">{branchMessage.text.slice(0,240)}{branchMessage.text.length>240?"…":""}</blockquote></> : <p className="hint">使用当前项目目录，对话从零开始。</p>}
          <textarea aria-label="新会话的第一条消息" value={spawnText} onChange={(e) => setSpawnText(e.target.value)} placeholder="第一条消息…" rows={3} disabled={busy} />
          <div className="btns">
            <button onClick={() => {setSpawnOpen(false);setBranchMessage(null);}} disabled={busy}>
              取消
            </button>
            <button className="primary" onClick={startSpawn} disabled={busy || !spawnText.trim() || (branchMessage!==null && (active || session.state==="running"))}>
              {branchMessage ? "创建分支并发送" : "开始"}
            </button>
          </div>
        </div>
      )}
      <main className="chat">
        <div className="btns">
          <button onClick={loadHistory} disabled={session.agent === "doubao" || busy || syncing || !agents.includes(session.machine)}>
            {syncing ? "正在同步电脑上的记录…" : "刷新电脑上的记录"}
          </button>
        </div>
        {loading && <p className="empty">加载中…</p>}
        {!loading && messages.length === 0 && !syncing && <p className="empty">{session.agent === "doubao" ? "正在监听豆包会话状态，暂不提供完整对话记录。请在豆包客户端中查看和继续对话。" : "还没有消息。可以发一条，或者刷新电脑上的记录。"}</p>}
        <ul className="msgs">
          {messages.map((m) => (
            <li key={m.id} className={`message-entry ${m.role}`}>
              <div className={`msg ${m.role}`}>{m.text}</div>
              {m.role==="assistant" && <MessageActions message={m} api={api}
                branchReason={busy || active || session.state==="running" ? "请等待会话运行结束" : !agents.includes(session.machine) ? "电脑端不在线" : !m.branchPoint ? "请刷新记录，或等待完整回复结束后再分支" : ""}
                onRated={updated=>setMessages(items=>items.map(item=>item.id===updated.id ? updated : item))}
                onBranch={()=>{setBranchMessage(m);setSpawnText("");setSpawnOpen(true);window.scrollTo({top:0,behavior:"auto"});}}/>}
            </li>
          ))}
        </ul>
        {approvals.map((a) => (
          <div key={a.id} className="approval-card">
            <div className="approval-head">
              请求授权：<b>{a.tool}</b>
            </div>
            <pre>{a.detail}</pre>
            <div className="btns">
              <button className="primary" disabled={deciding === a.id} onClick={() => decide(a, "allow")}>
                允许
              </button>
              <button disabled={deciding === a.id} onClick={() => decide(a, "deny")}>
                拒绝
              </button>
            </div>
          </div>
        ))}
        {run && run.status === "failed" && run.error && <p className="run-error">运行失败：{run.error}</p>}
        <div ref={endRef} />
      </main>
      {(err || note || speech.error) && <div className="toast" role="status">{err || note || speech.error}</div>}
      {!spawnOpen && <footer className="composer">
        {reason && <p className="hint">{reason}</p>}
        <textarea
          aria-label="会话消息"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={reason ?? "发消息给这个会话…（Ctrl+Enter 发送）"}
          disabled={!!reason || busy}
          rows={2}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send();
          }}
        />
        <div className="btns">
          {active ? (
            <button onClick={stop} disabled={busy}>
              {terminalRun ? "停止跟踪" : "停止"}
            </button>
          ) : null}
          <button className="primary" onClick={send} disabled={!!reason || busy || !text.trim()}>
            发送
          </button>
        </div>
      </footer>}
    </div>
  );
}
