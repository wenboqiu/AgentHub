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

export const isPending = (s: Session) => !s.acked && (s.state === "waiting" || s.state === "done" || s.state === "aborted");

const base = (url: string) => url.trim().replace(/\/+$/, "");

export class Api {
  url: string;
  token: string;
  constructor(url: string, token: string) {
    this.url = base(url);
    this.token = token.trim();
  }
  private async call<T>(method: string, path: string): Promise<T> {
    const res = await fetch(this.url + path, {
      method,
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(res.status === 401 ? "token 不正确（401）" : `服务端返回 ${res.status}`);
    return (await res.json()) as T;
  }
  async health(): Promise<void> {
    const res = await fetch(this.url + "/health");
    if (!res.ok) throw new Error(`/health 返回 ${res.status}`);
  }
  sessions = async () => (await this.call<{ sessions: Session[] }>("GET", "/sessions")).sessions;
  ack = (id: string) => this.call("POST", `/sessions/${encodeURIComponent(id)}/ack`);
  ackAll = () => this.call("POST", "/sessions/ack-all");
}

export type ConnState = "connecting" | "open" | "closed";

export type Handlers = {
  onState(s: ConnState): void;
  onSnapshot(list: Session[]): void;
  onSession(s: Session, notify: boolean): void;
  onRemoved(id: string): void;
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
        if (m.type === "snapshot") h.onSnapshot(m.sessions);
        else if (m.type === "session") h.onSession(m.session, !!m.notify);
        else if (m.type === "removed") h.onRemoved(m.id);
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
