export type State = "idle" | "running" | "waiting" | "done" | "aborted" | "ended" | "unknown";
export type Schedule = { startAt: string | null; dueAt: string | null; remindStart: boolean; remindDue: boolean };
export type ChecklistItem = { id: string; text: string; done: boolean };
export type Reminder = { id: number; entityType: "task" | "goal"; entityId: number; title: string; kind: "start" | "due"; scheduledAt: string; /** 服务端通知过滤后的结果：false 表示按账号规则静音（照常入列，不弹通知） */ notify?: boolean };
export type NotifyKind = "done" | "aborted" | "reminder";
export type NotifySettings = {
  agents: Record<"claude" | "codex" | "doubao" | "workbuddy" | "zcode" | "codebuddy", boolean>;
  minPriority: "high" | "medium" | "low";
  quiet: { enabled: boolean; start: string; end: string; tzOffsetMinutes: number; muteKinds: NotifyKind[] };
};
export type Goal = Schedule & { id: number; title: string; notes: string; priority: "high" | "medium" | "low"; status: "active" | "done" | "archived"; createdAt: string; updatedAt: string; doneAt: string | null };
/** 任务的执行边界：派活时定下来，代批先按它判，也拼进执行者的系统提示 */
export type TaskConstraints = {
  /** 只允许改这些子目录（相对项目目录）；空 = 整个项目 */
  paths: string[];
  /** 联网与装依赖 */
  net: boolean;
  /** 推远端 */
  push: boolean;
  /** 跑项目里的自定义脚本 */
  scripts: boolean;
  /** 一句话说明，拼进系统提示 */
  note: string;
};
export const NO_CONSTRAINTS: TaskConstraints = { paths: [], net: false, push: false, scripts: false, note: "" };
export const hasConstraints = (c?: TaskConstraints | null): boolean =>
  !!c && (c.paths.length > 0 || c.net || c.push || c.scripts || !!c.note);
/** 界面上的短标签：这个任务被允许做什么 */
export function constraintsSummary(c?: TaskConstraints | null): string[] {
  if (!c) return [];
  return [
    c.paths.length ? `只改 ${c.paths.join("、")}` : "",
    c.net ? "可联网" : "",
    c.push ? "可推远端" : "",
    c.scripts ? "可跑脚本" : "",
    c.note,
  ].filter(Boolean);
}
export type Task = Schedule & { checklist: ChecklistItem[]; constraints: TaskConstraints; startMode: Delivery; forkFrom: string | null; /** 发单时留空的配置/角色/正文交给项目经理补 */ autoDispatch: boolean; id: number; goalId: number | null; projectId: number | null; roleId: number | null; priority: "high" | "medium" | "low"; title: string; notes: string; status: "todo" | "doing" | "review" | "done"; agent: "claude" | "codex" | "doubao" | "workbuddy" | "zcode" | "codebuddy" | null; machine: string | null; cwd: string | null; sessionIds: string[]; createdAt: string; updatedAt: string; doneAt: string | null; timerStartedAt: string | null; queuedAt: string | null; /** 授权范围冻结时间；非空 = 范围已签署，不能再改 */ mandateFrozenAt?: string | null };
export type TaskInput = Partial<Pick<Task, "title" | "notes" | "goalId" | "projectId" | "roleId" | "priority" | "agent" | "machine" | "cwd" | "status" | "checklist" | "constraints" | "autoDispatch" | keyof Schedule>>;
/** 角色：谁来做（执行工具）+ 用什么模型 + 按什么准则（上下文）；目录是项目的事 */
export type Role = { id: number; name: string; title: string; agent: Task["agent"]; model: string | null; context: string; tools: string[]; tasks: number; manager: boolean; managerProjects: number[]; createdAt: string; updatedAt: string };
export type RoleInput = Partial<Omit<Role, "id" | "tasks" | "createdAt" | "updatedAt">>;

/** 一条目录 = 这个项目在某台电脑上住在哪；machine 为空表示哪台电脑都适用 */
export type ProjectDir = { machine: string | null; cwd: string };
/** 项目配置里的候选电脑：online = 此刻连着；at = 最近一次在这台上干活的时间 */
export type Machine = {
  name: string;
  online: boolean;
  at: string | null;
  /** 这台电脑上报过「装了哪些工具」；空数组 = 没上报（老电脑端），按「不知道」处理，不拦 */
  agents: string[];
};
/** 项目：一个代码库的身份与背景知识 + 它在各台电脑上的目录，派活时按当前机器自动挑 */
export type Project = { id: number; name: string; brief: string; dirs: ProjectDir[]; tasks: number; createdAt: string; updatedAt: string };
export type ProjectInput = Partial<Omit<Project, "id" | "tasks" | "createdAt" | "updatedAt">>;

/** 角色助手：一句话需求交给电脑端的 agent 整理成草稿，人确认后才建角色 */
export type AssistantAgent = "claude" | "codex" | "zcode";
export type AssistantDraftFields = {
  name: string;
  title: string;
  agent: Task["agent"];
  model: string | null;
  context: string;
  tools: string[];
  /** 项目经理身份：agent 不会提这种组织上的事，只在草稿卡上由人勾，跟着确认一起落库 */
  manager?: boolean;
  managerProjects?: number[];
  /** agent 交代的缺口或假设，只给人看，不落库 */
  note: string;
};
export type AssistantDraft = {
  id: number;
  messageId: number;
  /** 解析失败时为 null（保留 raw 原文，界面提示重说） */
  draft: AssistantDraftFields | null;
  raw: string;
  status: "pending" | "created" | "discarded";
  roleId: number | null;
  createdAt: string;
};
export type AssistantThread = {
  id: number;
  agent: AssistantAgent;
  machine: string;
  cwd: string;
  sessionId: string | null;
  lastRunId: string | null;
  createdAt: string;
  updatedAt: string;
};
export type AssistantState = {
  thread: AssistantThread | null;
  messages: Message[];
  drafts: AssistantDraft[];
  /** agent 还在想：界面锁输入并轮询 */
  pending: boolean;
  runError: string;
  online: string[];
  suggestion: { agent: AssistantAgent; machine: string };
  roles: number;
};

/** 角色记忆：projectId 为空 = 跨项目的通用经验 */
export type Memory = { id: number; roleId: number; projectId: number | null; content: string; source: "manual" | "review"; weight: number; uses: number; lastUsedAt: string | null; createdAt: string; updatedAt: string };
export type RunBrief = { status: RunStatus; error: string; /** 这一轮用的模型，空 = 执行端默认 */ model?: string | null; updatedAt: string };
/** 验收证据：从会话记录里摘出的文件变更、命令、测试结果、截图、错误日志 */
export type EvidenceKind = "file" | "command" | "test" | "shot" | "log";
export type Evidence = { kind: EvidenceKind; label: string; value: string; at: string | null };
/** 验收摘要：任务进入待验收时服务端后台预生成（投机执行），打开详情即见 */
export type ReviewDigest = { kind: "review"; builtAt: string; sessionId: string | null; sessionTitle: string; agent: string | null; project: string; messages: number; lastReply: string; lastReplyAt: string | null; runs: RunBrief[]; evidence?: Evidence[] };
/** 失败上下文：run 失败时预收集的错误与最后几条消息 */
export type FailureDigest = { kind: "failure"; builtAt: string; runId: string; sessionId: string | null; error: string; tail: { role: string; text: string }[] };
export type TaskDigests = { review: ReviewDigest | null; failure: FailureDigest | null };
/** 任务产物：跑完自动生成的 Markdown 文档；edited = 人改过，之后不再被自动重建覆盖 */
export type TaskArtifact = { taskId: number; md: string; source: "digest" | "agent" | "user"; edited: boolean; createdAt: string; updatedAt: string };
/** 任务附件：图片带可直接渲染的 data URL；文件只带元信息，下载时再取内容 */
export type Attachment = { id: number; taskId: number; kind: "image" | "file"; name: string; mime: string; size: number; createdAt: string; url: string | null };
/** 上传入参：图片是 data URL，文件是裸 base64（8MB 上限）。名称与类型由前端带上，大小由服务端核 */
export type AttachmentInput = { kind: "image" | "file"; name: string; mime: string; data: string };
/** 项目近况：任务完成时追加的一句结论，派活时注入提示 */
export type BriefEntry = { id: number; text: string; taskId: number | null; at: string };
/** 验收检查项：来自任务清单（或人工添加），可判通过/打回，打回原因沉淀为标准 */
export type ReviewItem = { id: number; key: string; title: string; status: "pending" | "pass" | "fail"; note: string; manual: boolean; updatedAt: string };
export type Review = { items: ReviewItem[]; evidence: Evidence[]; standards: string[] };

/** 处理意见：会话跑完后攒出来的「接下来做什么」，确认后才变成任务 */
/** ticket = 人直接发的粗单：没有会话，项目经理细化后由人确认才派发 */
export type ProposalKind = "continue" | "followup" | "fix" | "ticket";
/** 项目经理排好的执行人：角色是人，配置是地方（执行工具 + 电脑 + 目录） */
/**
 * 开跑方式：fork = 接着原会话的上下文另起一个会话，fresh = 新建会话从这个任务开始，
 * resume = 接着这个任务上次派发的会话继续（同一个对话，派发侧自动算出来，界面不用选）
 */
export type Delivery = "fork" | "fresh" | "resume";

/** 原会话这一侧能不能续：工具支不支持、是不是还在跑（能不能对上执行人由界面再判一次） */
export type ForkInfo = { agent: string; machine: string; cwd: string; ok: boolean; reason: string };

export type Assignee = {
  roleId: number | null;
  roleName: string;
  roleTitle: string;
  agent: string;
  machine: string;
  cwd: string;
};
export type Proposal = {
  id: number;
  sessionId: string;
  sessionTitle: string;
  sessionAgent: string;
  sessionProject: string;
  taskId: number | null;
  kind: ProposalKind;
  title: string;
  notes: string;
  checklist: string[];
  /** 项目经理声明的执行边界：确认后原样落到任务上 */
  constraints: TaskConstraints;
  /** 打算怎么开场：接着原会话的上下文（fork）还是新建会话（fresh） */
  delivery: Delivery;
  /** 原会话能不能续：工具支不支持、是不是还在跑 */
  fork: ForkInfo;
  priority: Task["priority"];
  roleId: number | null;
  projectId: number | null;
  /** 发单时人指定的地方（可空）：确认后钉进任务 */
  machine: string;
  cwd: string;
  assignee: Assignee;
  evidence: Evidence[];
  note: string;
  origin: "heuristic" | "agent";
  status: "pending" | "accepted" | "discarded";
  createdTaskId: number | null;
  /** 正在跑细化的那次 run：非空且 origin 还是 heuristic 就是「项目经理正在写」 */
  refineRunId: string | null;
  eventAt: string;
  createdAt: string;
  updatedAt: string;
};
export type ProposalInput = Partial<Pick<Proposal, "title" | "notes" | "checklist" | "priority" | "roleId" | "projectId">>;

/** 项目经理：全局一个，负责细化意见，可选地把已确认的任务自动派出去 */
/** 代批策略：会话卡在等授权时，项目经理能自己放行哪些操作 */
export type ApprovePolicy = {
  enabled: boolean;
  allowRead: boolean;
  allowWrite: boolean;
  allowTests: boolean;
  allowNetwork: boolean;
  /** 每小时最多代批几次，超了全交回给人 */
  maxPerHour: number;
};
export type DispatchManager = {
  roleId: number | null;
  enabled: boolean;
  maxRunning: number;
  maxPerHour: number;
  approve: ApprovePolicy;
  updatedAt: string | null;
};
export type ManagerState = { manager: DispatchManager; roles?: Role[]; managers?: Role[]; running: number; recent: number; quota: number };
/** Thread 事件：任务视角的统一事件流（关联会话消息 + 执行记录 + 时间提醒 + 摘要） */
export type ThreadEvent =
  | { type: "message"; at: string; sessionId: string; role: string; text: string; sourceId?: string }
  | { type: "run"; at: string; phase: "start" | "end"; runId: string; status: string; error: string; title: string; startedAt?: string }
  | { type: "reminder"; at: string; kind: "start" | "due"; title: string; acked: boolean }
  | { type: "digest"; at: string; kind: "review" | "failure"; text: string };

/** 派活看板条目：排队中 / 在跑 / 卡住（进行中却没有任何在跑的执行）的任务 */
export type BoardRun = { id: string; sessionId: string | null; status: "queued" | "running"; startedAt: string };
export type BoardEntry = {
  taskId: number;
  title: string;
  status: "todo" | "doing" | "review";
  agent: Task["agent"];
  machine: string | null;
  cwd: string | null;
  priority: Task["priority"];
  queued: boolean;
  attempts: number;
  queuedAt: string | null;
  run: BoardRun | null;
  waitingApproval: boolean;
  lastActivityAt: string | null;
  machineOnline: boolean;
  stuck: boolean;
  updatedAt: string;
};
export type Board = { entries: BoardEntry[]; agents: string[]; generatedAt: string };

/** 授权模式：off 与旧版一致；observe 只留痕；auto 范围内自动放行 + 执行器按范围关掉 CLI 逐动作审批 */
export type MandateMode = "off" | "observe" | "auto";

export type Session = {
  id: string;
  agent: "claude" | "codex" | "doubao" | "workbuddy" | "zcode" | "codebuddy";
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
/** 一次运行的 token 用量（执行器上报，Claude / Codex 才有；cached 是命中缓存的输入） */
export type RunUsage = { input: number; output: number; total: number; cached?: number; reasoning?: number; costUsd?: number; credits?: number };
export type Run = { id: string; sessionId: string | null; taskId: number | null; title: string; machine: string; status: RunStatus; error: string; usage?: RunUsage | null; /** 这一轮用的模型；空 = 执行端默认 */ model?: string | null; /** 谁定的、为什么 */ modelNote?: string; createdAt: string; updatedAt: string };
/** 执行器实时上报的「正在做什么」：文字是 agent 自己的（思考原文 / 工具调用 / 正在写的正文） */
export type RunActivity = { runId: string; sessionId: string; kind: "thinking" | "tool" | "text" | "idle"; text: string; at: string };
/** 日历执行记录：run 联出会话信息与任务名（任务计时没有会话；会话也可能已被清理） */
export type Execution = Run & { agent: "claude" | "codex" | "doubao" | "workbuddy" | "zcode" | "codebuddy" | null; project: string; state: State | null; taskTitle: string | null; tasks: string[] };
/** 会话活动桶：5 分钟粒度，只包含有消息的时段（用来还原"干干停停"的真实节奏） */
export type ActivityBucket = { sessionId: string; at: string; count: number };
export type MessageRole = "user" | "assistant" | "tool" | "approval" | "system";
export type Message = { id: number; sessionId: string; runId: string | null; role: MessageRole; text: string; images?: string[]; createdAt: string; sourceId?: string; branchPoint?: string; rating?: "up"|"down"|null }
export type ApprovalStatus = "pending" | "allowed" | "denied" | "expired";
/** 交回给人时的那句话：硬红线、边界外、规则看不懂，处理方式不一样 */
export const APPROVAL_TIER_LABEL: Record<string, string> = {
  danger: "硬红线",
  gray: "边界外",
  unknown: "规则看不懂",
};
export type Approval = {
  id: string;
  runId: string;
  sessionId: string;
  tool: string;
  detail: string;
  status: ApprovalStatus;
  /** user = 人点的；manager = 项目经理按规则代批的 */
  decidedBy: "user" | "manager";
  /** 代批/交回的理由：待处理时说明「为什么它没敢批」 */
  decisionRule: string;
  decisionReason: string;
  /** 裁决层级：danger 硬红线 / gray 看上下文 / unknown 规则看不懂 */
  decisionTier: string;
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
  /** 全量会话（含已结束）：快照只推活跃会话，日历要把当天已结束的对话也画出来 */
  sessionsAll = async () => (await this.call<{ sessions: Session[] }>("GET", "/sessions?all=1")).sessions;
  /** 单个会话：快照里没有的（已结束 / 超过 24 小时）按 id 补查，找不到说明记录真没了 */
  session = async (id: string) => (await this.call<{ session: Session }>("GET", `/sessions/${encodeURIComponent(id)}`)).session;
  goals = async () => (await this.call<{goals: Goal[]}>("GET", "/goals")).goals;
  tasks = async () => (await this.call<{tasks: Task[]}>("GET", "/tasks")).tasks;
  createGoal = async (input: {title: string; notes?: string; priority?: Goal["priority"]} & Partial<Schedule>) => (await this.call<{goal: Goal}>("POST", "/goals", input)).goal;
  updateGoal = async (id: number, input: Partial<Pick<Goal,"title"|"notes"|"status"|"priority"|keyof Schedule>>) => (await this.call<{goal: Goal}>("PATCH", `/goals/${id}`, input)).goal;
  deleteGoal = (id: number) => this.call("DELETE", `/goals/${id}`);
  createTask = async (input: TaskInput & {title: string}) => (await this.call<{task: Task}>("POST", "/tasks", input)).task;
  updateTask = async (id: number, input: TaskInput) => (await this.call<{task: Task}>("PATCH", `/tasks/${id}`, input)).task;
  deleteTask = (id: number) => this.call("DELETE", `/tasks/${id}`);
  roles = async () => (await this.call<{ roles: Role[] }>("GET", "/roles")).roles;
  /** projectId 传 undefined = 全部；传 null = 只列跨项目的通用经验 */
  memories = async (roleId: number, projectId?: number | null) =>
    (await this.call<{ memories: Memory[] }>("GET", `/roles/${roleId}/memories${projectId === undefined ? "" : `?projectId=${projectId ?? ""}`}`)).memories;
  addMemory = async (roleId: number, content: string, projectId: number | null) =>
    (await this.call<{ memory: Memory }>("POST", `/roles/${roleId}/memories`, { content, projectId })).memory;
  updateMemory = async (roleId: number, memoryId: number, content: string) =>
    (await this.call<{ memory: Memory }>("PATCH", `/roles/${roleId}/memories/${memoryId}`, { content })).memory;
  deleteMemory = (roleId: number, memoryId: number) => this.call("DELETE", `/roles/${roleId}/memories/${memoryId}`);
  projects = async () => (await this.call<{ projects: Project[] }>("GET", "/projects")).projects;
  /** 项目配置里的可选电脑：在线执行器 + 这个账号用过的机器（离线也会列出来） */
  machines = async () => (await this.call<{ machines: Machine[] }>("GET", "/machines")).machines;
  createProject = async (input: ProjectInput & { name: string }) => (await this.call<{ project: Project }>("POST", "/projects", input)).project;
  updateProject = async (id: number, input: ProjectInput) => (await this.call<{ project: Project }>("PATCH", `/projects/${id}`, input)).project;
  deleteProject = (id: number) => this.call("DELETE", `/projects/${id}`);
  createRole = async (input: RoleInput & { name: string }) => (await this.call<{ role: Role }>("POST", "/roles", input)).role;
  updateRole = async (id: number, input: RoleInput) => (await this.call<{ role: Role }>("PATCH", `/roles/${id}`, input)).role;
  deleteRole = (id: number) => this.call("DELETE", `/roles/${id}`);
  // 角色助手：对话、草稿与确认。agent 跑在用户自己的电脑上，电脑离线时服务端直接 409
  assistant = () => this.call<AssistantState>("GET", "/assistant");
  startAssistant = (input: { agent: AssistantAgent; machine: string; cwd: string; text: string }) =>
    this.call<{ thread: AssistantThread; runId: string }>("POST", "/assistant/start", input);
  replyAssistant = (text: string) => this.call<{ runId: string }>("POST", "/assistant/reply", { text });
  confirmDraft = (id: number, fields: Partial<AssistantDraftFields>) =>
    this.call<{ role: Role; draft: AssistantDraft }>("POST", `/assistant/drafts/${id}/confirm`, fields);
  discardDraft = (id: number) => this.call<{ draft: AssistantDraft }>("POST", `/assistant/drafts/${id}/discard`);
  resetAssistant = () => this.call<{ ok: true }>("POST", "/assistant/reset", {});
  linkSession = async (id: number, sessionId: string) => (await this.call<{task: Task}>("POST", `/tasks/${id}/sessions`, {sessionId})).task;
  digests = (id: number) => this.call<TaskDigests>("GET", `/tasks/${id}/digest`);
  artifact = (id: number) => this.call<{ artifact: TaskArtifact | null; path: string }>("GET", `/tasks/${id}/artifact`);
  saveArtifact = (id: number, md: string) => this.call<{ artifact: TaskArtifact }>("PATCH", `/tasks/${id}/artifact`, { md });
  rebuildArtifact = (id: number, force = false) =>
    this.call<{ artifact: TaskArtifact; path: string }>("POST", `/tasks/${id}/artifact/rebuild`, { force });
  deleteArtifact = (id: number) => this.call<{ ok: true }>("DELETE", `/tasks/${id}/artifact`);
  // 附件：列表 / 上传 / 下载（返回 base64）/ 删除（顺手摘掉备注里的引用）
  attachments = async (id: number) => (await this.call<{ attachments: Attachment[] }>("GET", `/tasks/${id}/attachments`)).attachments;
  uploadAttachment = async (id: number, input: AttachmentInput) =>
    (await this.call<{ attachment: Attachment }>("POST", `/tasks/${id}/attachments`, input)).attachment;
  downloadAttachment = (id: number, attachmentId: number) =>
    this.call<{ name: string; mime: string; size: number; data: string }>("GET", `/tasks/${id}/attachments/${attachmentId}`);
  deleteAttachment = (id: number, attachmentId: number) =>
    this.call<{ task: Task; attachments: Attachment[] }>("DELETE", `/tasks/${id}/attachments/${attachmentId}`);
  projectBrief = async (id: number) => (await this.call<{ entries: BriefEntry[] }>("GET", `/projects/${id}/brief`)).entries;
  addBrief = async (id: number, text: string) =>
    (await this.call<{ entries: BriefEntry[] }>("POST", `/projects/${id}/brief`, { text })).entries;
  deleteBrief = async (id: number, entryId: number) =>
    (await this.call<{ entries: BriefEntry[] }>("DELETE", `/projects/${id}/brief/${entryId}`)).entries;
  // 处理意见：sessionId 传了就看这一条会话的全部意见，不传就是全局待处理
  proposals = async (sessionId?: string) =>
    (await this.call<{ proposals: Proposal[] }>("GET", `/proposals${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`)).proposals;
  /** 让项目经理重写这条意见：借电脑上已登录的 agent，电脑离线时直接 409 */
  refineProposal = (id: number) => this.call<{ runId: string }>("POST", `/proposals/${id}/refine`, {});
  confirmProposal = (id: number, input: ProposalInput & { dispatch?: boolean; delivery?: Delivery }) =>
    this.call<{ task: Task; proposal: Proposal; dispatched: { queued: boolean; delivery?: { mode: Delivery; reason: string } } | null; dispatchError: string }>("POST", `/proposals/${id}/confirm`, input);
  discardProposal = (id: number) => this.call<{ proposal: Proposal }>("POST", `/proposals/${id}/discard`);
  /** 撤回忽略：只有 discarded 的能放回待确认；已确认的会报 409 */
  restoreProposal = (id: number) => this.call<{ proposal: Proposal }>("POST", `/proposals/${id}/restore`);
  /** 发新单：先落成一张待确认的任务单，服务端顺手让项目经理用模型补一遍；不直接建任务 */
  createTicket = (input: { title: string; notes: string; projectId: number; roleId?: number; machine?: string; cwd?: string }) =>
    this.call<{ proposal: Proposal; refineError: string }>("POST", "/tickets", input);
  dispatchManager = () => this.call<ManagerState>("GET", "/dispatch/manager");
  saveDispatchManager = (patch: Partial<DispatchManager>) => this.call<ManagerState>("PATCH", "/dispatch/manager", patch);
  review = (id: number) => this.call<Review>("GET", `/tasks/${id}/review`);
  addReviewItem = (id: number, title: string) => this.call<{ item: ReviewItem }>("POST", `/tasks/${id}/review`, { title });
  decideReviewItem = (taskId: number, itemId: number, status: "pending" | "pass" | "fail", note = "") => this.call<{ item: ReviewItem }>("PATCH", `/tasks/${taskId}/review/${itemId}`, { status, note });
  thread = (id: number, limit = 200) => this.call<{ events: ThreadEvent[] }>("GET", `/threads/task/${id}?limit=${limit}`);
  unlinkSession = async (id: number, sessionId: string) => (await this.call<{task: Task}>("DELETE", `/tasks/${id}/sessions/${encodeURIComponent(sessionId)}`)).task;
  /** 派活：电脑在线时返回 runId/sessionId；离线时入队，返回 queued 和带 queuedAt 的任务 */
  startTask = (id: number, input: {agent?: Task["agent"]; machine?: string; cwd?: string; text?: string}) => this.call<{runId?: string; sessionId?: string; queued?: boolean; task: Task; /** 电脑端太旧：角色里的模型与上下文被忽略 */ roleDegraded?: boolean; /** 这一轮实际用的模型（角色写的或项目经理挑的），空 = 执行端默认 */ model?: string | null; /** 谁定的、为什么 */ modelNote?: string}>("POST", `/tasks/${id}/start`, input);
  /** 取消排队：不再等那台电脑上线 */
  unqueueTask = async (id: number) => (await this.call<{task: Task}>("DELETE", `/tasks/${id}/queue`)).task;
  /** 派活看板：排队中 / 在跑 / 卡住的任务聚合 */
  dispatchBoard = () => this.call<Board>("GET", "/dispatch/board");
  mandateMode = () => this.call<{ mode: MandateMode }>("GET", "/mandate/settings");
  setMandateMode = (mode: MandateMode) => this.call<{ mode: MandateMode }>("PUT", "/mandate/settings", { mode });
  /** 验收通过：review → done 的唯一入口 */
  acceptTask = (id: number) => this.call<{ task: Task }>("POST", `/tasks/${id}/accept`, {});
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
    this.call<{ messages: Message[]; approvals: Approval[]; run: Run | null; activity?: RunActivity | null }>("GET", `/sessions/${encodeURIComponent(sessionId)}/messages?limit=200`);
  /** 基于已有会话新开：fork = 带上下文分叉，fresh = 同目录从零开始。返回临时会话 id */
  spawn = (sessionId: string, mode: "fork" | "fresh", text: string, messageId?: number) =>
    this.call<{ runId: string; sessionId: string }>("POST", `/sessions/${encodeURIComponent(sessionId)}/spawn`, { mode, text, ...(messageId === undefined ? {} : {messageId}) });
  rateMessage = async (sessionId:string,messageId:number,rating:"up"|"down"|null) =>
    (await this.call<{message:Message}>("PATCH",`/sessions/${encodeURIComponent(sessionId)}/messages/${messageId}/feedback`,{rating})).message;
  send = (sessionId: string, text: string, images?: string[]) =>
    this.call<{ runId: string }>("POST", `/sessions/${encodeURIComponent(sessionId)}/messages`, { text, ...(images?.length ? { images } : {}) });
  stop = (runId: string) => this.call("POST", `/runs/${encodeURIComponent(runId)}/stop`, {});
  /** 日历：一段时间内的执行记录（ISO 时间） */
  executions = (from: string, to: string) => this.call<{ executions: Execution[] }>("GET", `/runs?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  activity = (from: string, to: string) => this.call<{ activity: ActivityBucket[] }>("GET", `/activity?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  decide = (approvalId: string, decision: "allow" | "deny", answers?: Record<string, string[]>) =>
    this.call("POST", `/approvals/${encodeURIComponent(approvalId)}`, { decision, ...(answers ? { answers } : {}) });
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
  onArtifact(taskId: number, artifact: TaskArtifact): void;
  onSession(s: Session, notify: boolean): void;
  onRemoved(id: string): void;
  /** 新开的临时会话拿到真实 id */
  onRenamed(from: string, to: string): void;
  onRun(r: Run): void;
  /** 执行器实时的「正在做什么」（思考原文 / 工具 / 正在写的正文） */
  onActivity(a: RunActivity): void;
  onMessage(m: Message): void;
  onApproval(a: Approval, notify: boolean): void;
  /** Watchdog 升级提醒：stall = 会话长时间无事件疑似卡死；abort-spree = 同一会话反复失败 */
  onWatchdog(issue: "stall" | "abort-spree", s: Session): void;
  onAgents(agents: string[]): void;
  /** 处理意见新增或更新（细化完成也走这里，status 已是最新值） */
  onProposal(p: Proposal): void;
  /** 服务端把某条会话的原生正文重新同步进了库（WorkBuddy 跑完一轮时会先同步） */
  onSessionHistory(sessionId: string): void;
  /** 服务端以 4401 关闭连接：登录已失效，不再自动重连 */
  onAuthExpired(): void;
};

/** 心跳间隔；发了 ping 这么久还没 pong 就认定这条连接已经死了 */
const HEARTBEAT_MS = 20000;
const HEARTBEAT_TIMEOUT_MS = 15000;

/**
 * WebSocket 客户端，断线自动重连（1s -> 30s 退避）。
 * 光靠 onclose 不够：手机切网、后台被冻结时，socket 常常"看起来还开着"却再也收不到消息，
 * onclose 永远不来，界面就停在旧快照上（例如会话早已结束还显示"运行中"、消息按钮一直灰着）。
 * 所以另加两条：① app 级 ping/pong 探活，超时主动重连；② 回到前台/网络恢复时强制重连，
 * 服务端在连接建立时会推一份 snapshot，等于一次全量刷新。
 */
export function connect(url: string, token: string, h: Handlers) {
  let ws: WebSocket | null = null;
  let stopped = false;
  let delay = 1000;
  let timer: number | undefined;
  let beat: number | undefined;
  /** 已发出、还在等 pong 的时间点；0 表示当前没有在等 */
  let waiting = 0;
  /** 累计的 ping/pong 计数（跨重连保留）：一次 pong 都没收到过，说明服务端还不支持 app 级 ping，
   *  这时就别再靠心跳判断死活了，免得旧服务端把连接反复掐断 */
  let pings = 0;
  let pongs = 0;
  /** 回前台强制重连的节流，避免窗口来回切换时刷爆服务端 */
  let lastResume = 0;

  const retry = () => {
    if (stopped) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(open, delay);
    delay = Math.min(delay * 2, 30000);
  };

  const open = () => {
    if (stopped) return;
    window.clearTimeout(timer);
    h.onState("connecting");
    const wsUrl = base(url).replace(/^http/, "ws") + `/ws?token=${encodeURIComponent(token.trim())}`;
    let sock: WebSocket;
    try {
      sock = new WebSocket(wsUrl);
    } catch {
      retry();
      return;
    }
    ws = sock;
    waiting = 0;
    window.clearInterval(beat);
    beat = window.setInterval(() => {
      if (ws !== sock || sock.readyState !== WebSocket.OPEN) return;
      if (waiting && Date.now() - waiting > HEARTBEAT_TIMEOUT_MS) {
        waiting = 0;
        // 从没收到过 pong 且已经发了 3 次：服务端不支持 app 级 ping，停掉心跳（断线仍有 onclose 兜底）
        if (pongs === 0 && pings >= 3) {
          window.clearInterval(beat);
          return;
        }
        // 之前 pong 正常、这次超时：连接已经死了（手机切网/后台冻结），主动重连
        try { sock.close(); } catch { /* 忽略 */ }
        return;
      }
      waiting = Date.now();
      pings++;
      try { sock.send('{"type":"ping"}'); } catch { /* 忽略 */ }
    }, HEARTBEAT_MS);
    sock.onopen = () => {
      if (ws !== sock) return;
      delay = 1000;
      h.onState("open");
    };
    sock.onmessage = (e) => {
      try {
        const m = JSON.parse(String(e.data));
        if (m.type === "pong") { waiting = 0; pongs++; return; }
        if (m.type === "snapshot") h.onSnapshot(m.sessions, m.agents ?? [], m.approvals ?? [], m.goals ?? [], m.tasks ?? [], m.reminders ?? []);
        else if (m.type === "reminder") h.onReminder(m.reminder);
        else if (m.type === "reminder.acked") h.onReminderAck(m.id);
        else if (m.type === "goal") h.onGoal(m.goal);
        else if (m.type === "goal.removed") h.onGoalRemoved(m.id);
        else if (m.type === "task") h.onTask(m.task);
        else if (m.type === "task.digest") h.onTaskDigest(m.taskId, m.kind === "failure" ? "failure" : "review", m.digest);
        else if (m.type === "task.artifact" && m.artifact) h.onArtifact(m.taskId, m.artifact);
        else if (m.type === "task.removed") h.onTaskRemoved(m.id);
        else if (m.type === "session") h.onSession(m.session, !!m.notify);
        else if (m.type === "removed") h.onRemoved(m.id);
        else if (m.type === "session.renamed") h.onRenamed(m.from, m.to);
        else if (m.type === "run") h.onRun(m.run);
        else if (m.type === "activity") h.onActivity(m.activity);
        else if (m.type === "message") h.onMessage(m.message);
        else if (m.type === "approval") h.onApproval(m.approval, !!m.notify);
        else if (m.type === "watchdog") h.onWatchdog(m.issue === "abort-spree" ? "abort-spree" : "stall", m.session);
        else if (m.type === "proposal") h.onProposal(m.proposal);
        else if (m.type === "session.history") h.onSessionHistory(m.sessionId);
        else if (m.type === "agents") h.onAgents(m.agents ?? []);
      } catch {
        /* 忽略坏消息 */
      }
    };
    sock.onclose = (e) => {
      if (ws !== sock) return; // 已被新连接顶替，别动新连接的心跳
      window.clearInterval(beat);
      ws = null;
      h.onState("closed");
      if (e.code === 4401) {
        stopped = true;
        h.onAuthExpired();
        return;
      }
      retry();
    };
    sock.onerror = () => { try { sock.close(); } catch { /* 忽略 */ } };
  };

  /** 回到前台 / 网络恢复：直接换一条连接，拿服务端的 snapshot 全量刷新 */
  const resume = () => {
    if (stopped) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    if (Date.now() - lastResume < 5000) return;
    lastResume = Date.now();
    delay = 1000;
    const old = ws;
    ws = null; // 先摘掉引用，旧连接的 onclose 就不会再触发退避重连
    try { old?.close(); } catch { /* 忽略 */ }
    open();
  };

  if (typeof document !== "undefined") document.addEventListener("visibilitychange", resume);
  if (typeof window !== "undefined") window.addEventListener("online", resume);
  open();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
    window.clearInterval(beat);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", resume);
    if (typeof window !== "undefined") window.removeEventListener("online", resume);
    ws?.close();
  };
}
