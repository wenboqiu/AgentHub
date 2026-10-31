export type State = "idle" | "running" | "waiting" | "done" | "aborted" | "ended";

export type Session = {
  id: string;
  agent: "claude" | "codex";
  machine: string;
  cwd: string;
  project: string;
  title: string;
  state: State;
  summary: string;
  stateSince: string;
  acked: boolean;
  pid: number | null;
  eventAt: string;
  updatedAt: string;
};

export type RunStatus = "queued" | "running" | "done" | "failed" | "stopped";
export type Run = { id: string; sessionId: string; machine: string; status: RunStatus; error: string; createdAt: string; updatedAt: string };
export type MessageRole = "user" | "assistant" | "tool" | "approval" | "system";
export type Message = { id: number; sessionId: string; runId: string | null; role: MessageRole; text: string; createdAt: string };
export type ApprovalStatus = "pending" | "allowed" | "denied" | "expired";
export type Approval = {
  id: string;
  runId: string;
  sessionId: string;
  tool: string;
  detail: string;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt: string | null;
  project?: string;
};

export const isPending = (s: Session) => !s.acked && (s.state === "waiting" || s.state === "done" || s.state === "aborted");
export const isRunActive = (r: Run | null | undefined) => !!r && (r.status === "queued" || r.status === "running");

const base = (url: string) => url.trim().replace(/\/+$/, "");

export class Api {
  url: string;
  token: string;
  controlToken: string;
  constructor(url: string, token: string, controlToken = "") {
    this.url = base(url);
    this.token = token.trim();
    this.controlToken = controlToken.trim();
  }
  private async call<T>(method: string, path: string, body?: unknown, control = false): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (control) headers["X-Control-Token"] = this.controlToken;
    const res = await fetch(this.url + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (!res.ok) {
      if (res.status === 401) throw new Error("token 不正确（401）");
      let msg = "";
      try {
        msg = ((await res.json()) as { error?: string }).error ?? "";
      } catch {
        /* 不是 JSON */
      }
      throw new Error(msg || `服务端返回 ${res.status}`);
    }
    return (await res.json()) as T;
  }
  async health(): Promise<void> {
    const res = await fetch(this.url + "/health");
    if (!res.ok) throw new Error(`/health 返回 ${res.status}`);
  }
  sessions = async () => (await this.call<{ sessions: Session[] }>("GET", "/sessions")).sessions;
  ack = (id: string) => this.call("POST", `/sessions/${encodeURIComponent(id)}/ack`);
  ackAll = () => this.call("POST", "/sessions/ack-all");

  // 远程控制
  controlStatus = () => this.call<{ enabled: boolean; agents: string[] }>("GET", "/control/status");
  messages = (sessionId: string) =>
    this.call<{ messages: Message[]; approvals: Approval[]; run: Run | null }>("GET", `/sessions/${encodeURIComponent(sessionId)}/messages?limit=200`);
  send = (sessionId: string, text: string) => this.call<{ runId: string }>("POST", `/sessions/${encodeURIComponent(sessionId)}/messages`, { text }, true);
  stop = (runId: string) => this.call("POST", `/runs/${encodeURIComponent(runId)}/stop`, {}, true);
  decide = (approvalId: string, decision: "allow" | "deny") => this.call("POST", `/approvals/${encodeURIComponent(approvalId)}`, { decision }, true);
  history = (sessionId: string) => this.call<{ messages: Message[] }>("POST", `/sessions/${encodeURIComponent(sessionId)}/history`, {}, true);
}

export type ConnState = "connecting" | "open" | "closed";

export type Handlers = {
  onState(s: ConnState): void;
  onSnapshot(list: Session[], agents: string[], approvals: Approval[]): void;
  onSession(s: Session, notify: boolean): void;
  onRemoved(id: string): void;
  onRun(r: Run): void;
  onMessage(m: Message): void;
  onApproval(a: Approval, notify: boolean): void;
  onAgents(agents: string[]): void;
};

/** WebSocket 客户端，断线自动重连（1s -> 30s 退避） */
export function connect(url: string, token: string, h: Handlers) {
  let ws: WebSocket | null = null;
  let stopped = false;
  let delay = 1000;
  let timer: number | undefined;

  const open = () => {
    if (stopped) return;
    h.onState("connecting");
    const wsUrl = base(url).replace(/^http/, "ws") + `/ws?token=${encodeURIComponent(token.trim())}`;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      retry();
      return;
    }
    ws.onopen = () => {
      delay = 1000;
      h.onState("open");
    };
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(String(e.data));
        if (m.type === "snapshot") h.onSnapshot(m.sessions, m.agents ?? [], m.approvals ?? []);
        else if (m.type === "session") h.onSession(m.session, !!m.notify);
        else if (m.type === "removed") h.onRemoved(m.id);
        else if (m.type === "run") h.onRun(m.run);
        else if (m.type === "message") h.onMessage(m.message);
        else if (m.type === "approval") h.onApproval(m.approval, !!m.notify);
        else if (m.type === "agents") h.onAgents(m.agents ?? []);
      } catch {
        /* 忽略坏消息 */
      }
    };
    ws.onclose = () => {
      ws = null;
      h.onState("closed");
      retry();
    };
    ws.onerror = () => ws?.close();
  };
  const retry = () => {
    if (stopped) return;
    timer = window.setTimeout(open, delay);
    delay = Math.min(delay * 2, 30000);
  };
  open();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
    ws?.close();
  };
}
