export type State = "idle" | "running" | "waiting" | "done" | "aborted" | "ended" | "unknown";
export type Schedule = { startAt: string | null; dueAt: string | null; remindStart: boolean; remindDue: boolean };
export type ChecklistItem = { id: string; text: string; done: boolean };
export type Reminder = { id: number; entityType: "task" | "goal"; entityId: number; title: string; kind: "start" | "due"; scheduledAt: string; /** 服务端通知过滤后的结果：false 表示按账号规则静音（照常入列，不弹通知） */ notify?: boolean };
export type NotifyKind = "done" | "aborted" | "reminder";
export type NotifySettings = {
  agents: Record<"claude" | "codex" | "doubao" | "workbuddy", boolean>;
  minPriority: "high" | "medium" | "low";
  quiet: { enabled: boolean; start: string; end: string; tzOffsetMinutes: number; muteKinds: NotifyKind[] };
};
export type Goal = Schedule & { id: number; title: string; notes: string; priority: "high" | "medium" | "low"; status: "active" | "done" | "archived"; createdAt: string; updatedAt: string; doneAt: string | null };
export type Task = Schedule & { checklist: ChecklistItem[]; id: number; goalId: number | null; priority: "high" | "medium" | "low"; title: string; notes: string; status: "todo" | "doing" | "review" | "done"; agent: "claude" | "codex" | "doubao" | "workbuddy" | null; machine: string | null; cwd: string | null; sessionIds: string[]; createdAt: string; updatedAt: string; doneAt: string | null; timerStartedAt: string | null };
export type TaskInput = Partial<Pick<Task, "title" | "notes" | "goalId" | "priority" | "agent" | "machine" | "cwd" | "status" | "checklist" | keyof Schedule>>;
export type RunBrief = { status: RunStatus; error: string; updatedAt: string };
/** 验收证据：从会话记录里摘出的文件变更、命令、测试结果、截图、错误日志 */
export type EvidenceKind = "file" | "command" | "test" | "shot" | "log";
export type Evidence = { kind: EvidenceKind; label: string; value: string; at: string | null };
/** 验收摘要：任务进入待验收时服务端后台预生成（投机执行），打开详情即见 */
export type ReviewDigest = { kind: "review"; builtAt: string; sessionId: string | null; sessionTitle: string; agent: string | null; project: string; messages: number; lastReply: string; lastReplyAt: string | null; runs: RunBrief[]; evidence?: Evidence[] };
/** 失败上下文：run 失败时预收集的错误与最后几条消息 */
export type FailureDigest = { kind: "failure"; builtAt: string; runId: string; sessionId: string | null; error: string; tail: { role: string; text: string }[] };
export type TaskDigests = { review: ReviewDigest | null; failure: FailureDigest | null };
/** 验收检查项：来自任务清单（或人工添加），可判通过/打回，打回原因沉淀为标准 */
export type ReviewItem = { id: number; key: string; title: string; status: "pending" | "pass" | "fail"; note: string; manual: boolean; updatedAt: string };
export type Review = { items: ReviewItem[]; evidence: Evidence[]; standards: string[] };
/** Thread 事件：任务视角的统一事件流（关联会话消息 + 执行记录 + 时间提醒 + 摘要） */
export type ThreadEvent =
  | { type: "message"; at: string; sessionId: string; role: string; text: string; sourceId?: string }
  | { type: "run"; at: string; runId: string; status: string; error: string; title: string }
  | { type: "reminder"; at: string; kind: "start" | "due"; title: string; acked: boolean }
  | { type: "digest"; at: string; kind: "review" | "failure"; text: string };

export type Session = {
  id: string;
  agent: "claude" | "codex" | "doubao" | "workbuddy";
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
export type Run = { id: string; sessionId: string | null; taskId: number | null; title: string; machine: string; status: RunStatus; error: string; createdAt: string; updatedAt: string };
/** 日历执行记录：run 联出会话信息与任务名（任务计时没有会话；会话也可能已被清理） */
export type Execution = Run & { agent: "claude" | "codex" | "doubao" | "workbuddy" | null; project: string; state: State | null; taskTitle: string | null; tasks: string[] };
/** 会话活动桶：5 分钟粒度，只包含有消息的时段（用来还原"干干停停"的真实节奏） */
export type ActivityBucket = { sessionId: string; at: string; count: number };
export type MessageRole = "user" | "assistant" | "tool" | "approval" | "system";
export type Message = { id: number; sessionId: string; runId: string | null; role: MessageRole; text: string; createdAt: string; sourceId?: string; branchPoint?: string; rating?: "up"|"down"|null };
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

export const AUTH_EXPIRED_TEXT = "登录已过期，请重新登录";

/** 服务端返回 401（登录失效）；App 收到后清掉本地 token、回到登录页 */
export class AuthError extends Error {
  constructor(message = AUTH_EXPIRED_TEXT) {
    super(message);
    this.name = "AuthError";
  }
}

export type Device = { id: number; device: string; createdAt: string; lastUsedAt: string; current: boolean };

const base = (url: string) => url.trim().replace(/\/+$/, "");

async function errorText(res: Response): Promise<string> {
  try {
    return ((await res.json()) as { error?: string }).error ?? "";
  } catch {
    return ""; /* 不是 JSON */
  }
}

export class Api {
  url: string;
  token: string;
  /** 任何请求返回 401 时调用（App 用它清掉 token、回到登录页） */
  onAuthError?: () => void;
  constructor(url: string, token: string, onAuthError?: () => void) {
    this.url = base(url);
    this.token = token.trim();
    this.onAuthError = onAuthError;
  }

  /** 邮箱 + 密码登录，返回这台设备的会话 token。登录失败的 401 不算「登录过期」 */
  static async login(url: string, email: string, password: string, device: string): Promise<{ token: string; email: string }> {
    const res = await fetch(base(url) + "/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), password, device }),
    });
    if (!res.ok) throw new Error((await errorText(res)) || `服务端返回 ${res.status}`);
    return (await res.json()) as { token: string; email: string };
  }

  private async call<T>(method: string, path: string, body?: unknown, quiet401 = false): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(this.url + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (!res.ok) {
      if (res.status === 401) {
        if (!quiet401) this.onAuthError?.();
        throw new AuthError();
      }
      throw new Error((await errorText(res)) || `服务端返回 ${res.status}`);
    }
    return (await res.json()) as T;
  }
  async health(): Promise<void> {
    const res = await fetch(this.url + "/health");
    if (!res.ok) throw new Error(`/health 返回 ${res.status}`);
  }
  sessions = async () => (await this.call<{ sessions: Session[] }>("GET", "/sessions")).sessions;
  goals = async () => (await this.call<{goals: Goal[]}>("GET", "/goals")).goals;
  tasks = async () => (await this.call<{tasks: Task[]}>("GET", "/tasks")).tasks;
  createGoal = async (input: {title: string; notes?: string; priority?: Goal["priority"]} & Partial<Schedule>) => (await this.call<{goal: Goal}>("POST", "/goals", input)).goal;
  updateGoal = async (id: number, input: Partial<Pick<Goal,"title"|"notes"|"status"|"priority"|keyof Schedule>>) => (await this.call<{goal: Goal}>("PATCH", `/goals/${id}`, input)).goal;
  deleteGoal = (id: number) => this.call("DELETE", `/goals/${id}`);
  createTask = async (input: TaskInput & {title: string}) => (await this.call<{task: Task}>("POST", "/tasks", input)).task;
  updateTask = async (id: number, input: TaskInput) => (await this.call<{task: Task}>("PATCH", `/tasks/${id}`, input)).task;
  deleteTask = (id: number) => this.call("DELETE", `/tasks/${id}`);
  linkSession = async (id: number, sessionId: string) => (await this.call<{task: Task}>("POST", `/tasks/${id}/sessions`, {sessionId})).task;
  digests = (id: number) => this.call<TaskDigests>("GET", `/tasks/${id}/digest`);
  review = (id: number) => this.call<Review>("GET", `/tasks/${id}/review`);
  addReviewItem = (id: number, title: string) => this.call<{ item: ReviewItem }>("POST", `/tasks/${id}/review`, { title });
  decideReviewItem = (taskId: number, itemId: number, status: "pending" | "pass" | "fail", note = "") => this.call<{ item: ReviewItem }>("PATCH", `/tasks/${taskId}/review/${itemId}`, { status, note });
  thread = (id: number, limit = 200) => this.call<{ events: ThreadEvent[] }>("GET", `/threads/task/${id}?limit=${limit}`);
  unlinkSession = async (id: number, sessionId: string) => (await this.call<{task: Task}>("DELETE", `/tasks/${id}/sessions/${encodeURIComponent(sessionId)}`)).task;
  startTask = (id: number, input: {agent?: Task["agent"]; machine?: string; cwd?: string; text?: string}) => this.call<{runId: string; sessionId: string; task: Task}>("POST", `/tasks/${id}/start`, input);
  /** 手动计时：不依赖会话，直接给任务记一次执行 */
  startTimer = async (id: number) => (await this.call<{task: Task}>("POST", `/tasks/${id}/timer/start`, {})).task;
  stopTimer = async (id: number) => (await this.call<{task: Task}>("POST", `/tasks/${id}/timer/stop`, {})).task;
  ackReminder = (id: number) => this.call("POST", `/reminders/${id}/ack`);
  notifySettings = async () => (await this.call<{ settings: NotifySettings }>("GET", "/notify/settings")).settings;
  saveNotifySettings = async (patch: Partial<NotifySettings>) => (await this.call<{ settings: NotifySettings }>("PATCH", "/notify/settings", patch)).settings;
  ack = (id: string) => this.call("POST", `/sessions/${encodeURIComponent(id)}/ack`);
  ackAll = () => this.call("POST", "/sessions/ack-all");

  // 账号
  me = () => this.call<{ email: string }>("GET", "/auth/me");
  logout = () => this.call("POST", "/auth/logout", {}, true);
  devices = () => this.call<Device[]>("GET", "/auth/devices");
  removeDevice = (id: number) => this.call("DELETE", `/auth/devices/${id}`);
  changePassword = (oldPassword: string, newPassword: string) => this.call("POST", "/auth/password", { oldPassword, newPassword });

  // 远程控制
  controlStatus = () => this.call<{ agents: string[] }>("GET", "/control/status");
  messages = (sessionId: string) =>
    this.call<{ messages: Message[]; approvals: Approval[]; run: Run | null }>("GET", `/sessions/${encodeURIComponent(sessionId)}/messages?limit=200`);
  /** 基于已有会话新开：fork = 带上下文分叉，fresh = 同目录从零开始。返回临时会话 id */
  spawn = (sessionId: string, mode: "fork" | "fresh", text: string, messageId?: number) =>
    this.call<{ runId: string; sessionId: string }>("POST", `/sessions/${encodeURIComponent(sessionId)}/spawn`, { mode, text, ...(messageId === undefined ? {} : {messageId}) });
  rateMessage = async (sessionId:string,messageId:number,rating:"up"|"down"|null) =>
    (await this.call<{message:Message}>("PATCH",`/sessions/${encodeURIComponent(sessionId)}/messages/${messageId}/feedback`,{rating})).message;
  send = (sessionId: string, text: string) => this.call<{ runId: string }>("POST", `/sessions/${encodeURIComponent(sessionId)}/messages`, { text });
  stop = (runId: string) => this.call("POST", `/runs/${encodeURIComponent(runId)}/stop`, {});
  /** 日历：一段时间内的执行记录（ISO 时间） */
  executions = (from: string, to: string) => this.call<{ executions: Execution[] }>("GET", `/runs?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  activity = (from: string, to: string) => this.call<{ activity: ActivityBucket[] }>("GET", `/activity?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  decide = (approvalId: string, decision: "allow" | "deny") => this.call("POST", `/approvals/${encodeURIComponent(approvalId)}`, { decision });
  history = (sessionId: string) => this.call<{ messages: Message[] }>("POST", `/sessions/${encodeURIComponent(sessionId)}/history`, {});
}

export type ConnState = "connecting" | "open" | "closed";

export type Handlers = {
  onState(s: ConnState): void;
  onSnapshot(list: Session[], agents: string[], approvals: Approval[], goals: Goal[], tasks: Task[], reminders: Reminder[]): void;
  onReminder(reminder: Reminder): void;
  onReminderAck(id: number): void;
  onGoal(goal: Goal): void;
  onGoalRemoved(id: number): void;
  onTask(task: Task): void;
  onTaskRemoved(id: number): void;
  onTaskDigest(taskId: number, kind: "review" | "failure", digest: unknown): void;
  onSession(s: Session, notify: boolean): void;
  onRemoved(id: string): void;
  /** 新开的临时会话拿到真实 id */
  onRenamed(from: string, to: string): void;
  onRun(r: Run): void;
  onMessage(m: Message): void;
  onApproval(a: Approval, notify: boolean): void;
  /** Watchdog 升级提醒：stall = 会话长时间无事件疑似卡死；abort-spree = 同一会话反复失败 */
  onWatchdog(issue: "stall" | "abort-spree", s: Session): void;
  onAgents(agents: string[]): void;
  /** 服务端以 4401 关闭连接：登录已失效，不再自动重连 */
  onAuthExpired(): void;
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
        if (m.type === "snapshot") h.onSnapshot(m.sessions, m.agents ?? [], m.approvals ?? [], m.goals ?? [], m.tasks ?? [], m.reminders ?? []);
        else if (m.type === "reminder") h.onReminder(m.reminder);
        else if (m.type === "reminder.acked") h.onReminderAck(m.id);
        else if (m.type === "goal") h.onGoal(m.goal);
        else if (m.type === "goal.removed") h.onGoalRemoved(m.id);
        else if (m.type === "task") h.onTask(m.task);
        else if (m.type === "task.digest") h.onTaskDigest(m.taskId, m.kind === "failure" ? "failure" : "review", m.digest);
        else if (m.type === "task.removed") h.onTaskRemoved(m.id);
        else if (m.type === "session") h.onSession(m.session, !!m.notify);
        else if (m.type === "removed") h.onRemoved(m.id);
        else if (m.type === "session.renamed") h.onRenamed(m.from, m.to);
        else if (m.type === "run") h.onRun(m.run);
        else if (m.type === "message") h.onMessage(m.message);
        else if (m.type === "approval") h.onApproval(m.approval, !!m.notify);
        else if (m.type === "watchdog") h.onWatchdog(m.issue === "abort-spree" ? "abort-spree" : "stall", m.session);
        else if (m.type === "agents") h.onAgents(m.agents ?? []);
      } catch {
        /* 忽略坏消息 */
      }
    };
    ws.onclose = (e) => {
      ws = null;
      h.onState("closed");
      if (e.code === 4401) {
        stopped = true;
        h.onAuthExpired();
        return;
      }
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
