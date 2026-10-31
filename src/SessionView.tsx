import { useEffect, useRef, useState } from "react";
import { isRunActive, type Api, type Approval, type Message, type Run, type Session } from "./lib/api";
import { syncSession, type Bus } from "./lib/sessionSync";

const AGENT_LABEL = { claude: "Claude", codex: "Codex" } as const;
const STATE_LABEL: Record<string, string> = {
  idle: "空闲",
  running: "运行中",
  waiting: "等待授权",
  done: "已完成",
  aborted: "已中断",
  ended: "已结束",
};

type Props = {
  session: Session | undefined;
  api: Api;
  bus: Bus;
  /** 这个会话当前 pending 的授权（App 从 WS 维护） */
  approvals: Approval[];
  /** 在线的执行器（机器名） */
  agents: string[];
  onBack(): void;
};

/** 不能发消息的原因；null 表示可以发 */
export function sendBlockReason(p: { session: Session; agents: string[]; running: boolean }): string | null {
  if (!p.agents.includes(p.session.machine)) return "电脑端不在线";
  if (p.running) return "这个会话正在运行";
  if (p.session.agent === "codex" && p.session.state === "running") return "这个 Codex 会话正在 Desktop 里运行，等它结束后再发";
  return null;
}

export default function SessionView({ session, api, bus, approvals, agents, onBack }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, approvals.length]);

  if (!session) {
    return (
      <div className="app">
        <header>
          <button onClick={onBack}>返回</button>
        </header>
        <p className="empty">这个会话已经不存在了</p>
      </div>
    );
  }

  const active = isRunActive(run);
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
        <button onClick={onBack}>返回</button>
        <span className={`tag ${session.agent}`}>{AGENT_LABEL[session.agent]}</span>
        <strong className="project">{session.project || "(未知项目)"}</strong>
        <span className="spacer" />
        <span className="machine">
          {session.machine} · {STATE_LABEL[session.state] ?? session.state}
        </span>
      </header>
      {session.title && <div className="title wrap">{session.title}</div>}
      <main className="chat">
        <div className="btns">
          <button onClick={loadHistory} disabled={busy || !agents.includes(session.machine)}>
            加载电脑上的历史记录
          </button>
        </div>
        {loading && <p className="empty">加载中…</p>}
        {!loading && messages.length === 0 && <p className="empty">还没有消息。可以发一条，或者加载电脑上的历史记录。</p>}
        <ul className="msgs">
          {messages.map((m) => (
            <li key={m.id} className={`msg ${m.role}`}>
              {m.text}
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
      {err && <div className="toast">{err}</div>}
      <footer className="composer">
        {reason && <p className="hint">{reason}</p>}
        <textarea
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
              停止
            </button>
          ) : null}
          <button className="primary" onClick={send} disabled={!!reason || busy || !text.trim()}>
            发送
          </button>
        </div>
      </footer>
    </div>
  );
}
