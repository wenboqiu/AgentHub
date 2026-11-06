import { invoke } from "@tauri-apps/api/core";

export type Config = {
  serverUrl: string;
  token: string;
  machine: string;
  notifyDesktop: boolean;
  /** 登录的邮箱（只用于显示；token 是登录后拿到的设备会话 token） */
  email: string;
  /** 仅桌面：禁止执行的项目目录（黑名单，留空 = 不限制） */
  deniedRoots: string[];
  /** 仅桌面：允许手机远程执行 */
  remoteEnabled: boolean;
  /** 待处理会话用图模式展示（项目气泡 + 会话气泡） */
  graphMode: boolean;
  /** 仅桌面：本地派单队列（127.0.0.1:47822）是否开放 */
  hubEnabled: boolean;
  /** 仅桌面：派单队列鉴权 token；留空 = 本机回环不鉴权 */
  hubToken: string;
};
export type RemoteInfo = { connected: boolean; lastError: string | null };

/** 派单队列里的任务（Rust hub::Task，camelCase 序列化） */
export type HubTask = {
  id: string;
  title: string;
  body: string;
  worker: string;
  workspace: string;
  state: "queued" | "dispatched" | "running" | "done" | "failed" | "cancelled";
  dispatches: number;
  result: string | null;
  artifacts: string[];
  ok: boolean | null;
  createdAt: number;
  updatedAt: number;
};
export type HubWorker = { name: string; lastSeen: number; queued: number; running: number };

export type HooksStatus = { installed: boolean; scriptExists: boolean; settingsExists: boolean };
export type CollectorInfo = {
  collectorError: string | null;
  forward: { queued: number; lastError: string | null };
  port: number;
};

// Android 原生桥（MainActivity 里 addJavascriptInterface 注入）
type NativeBridge = {
  copyText?(text:string):void;
  speak?(text:string):void;
  stopSpeech?():void;
  speechStatus?():string;
  start(url: string, token: string): void;
  stop(): void;
  isRunning(): boolean;
  notificationsEnabled(): boolean;
  openBatterySettings(): void;
  /** 打开系统相册；结果通过 window.__agenthubPickImage / __agenthubPickDone 回传 */
  pickImages?(requestId: string, limit: number): void;
};
declare global {
  interface Window {
    AgentHubNative?: NativeBridge;
  }
}

export const isAndroid = /Android/i.test(navigator.userAgent);
export const isDesktop = !isAndroid && "__TAURI_INTERNALS__" in window;
export const native = (): NativeBridge | undefined => window.AgentHubNative;

const LS_KEY = "agenthub.config";
const defaults: Config = { serverUrl: "", token: "", machine: "", notifyDesktop: true, email: "", deniedRoots: [], remoteEnabled: false, graphMode: false, hubEnabled: true, hubToken: "" };

export async function loadConfig(): Promise<Config> {
  if (isDesktop) return invoke<Config>("get_config");
  try {
    const { controlToken: _legacy, ...saved } = JSON.parse(localStorage.getItem(LS_KEY) ?? "{}"); // 旧版的控制密钥丢掉
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

export async function saveConfig(c: Config): Promise<void> {
  if (isDesktop) {
    await invoke("set_config", { config: c });
    return;
  }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(c));
  } catch {
    /* 存储不可用就只在内存里生效 */
  }
}

export const desktop = {
  status: () => invoke<CollectorInfo>("get_status"),
  remoteStatus: () => invoke<RemoteInfo>("remote_status"),
  hooksStatus: () => invoke<HooksStatus>("claude_hooks_status"),
  installHooks: () => invoke<HooksStatus>("install_claude_hooks"),
  uninstallHooks: () => invoke<HooksStatus>("uninstall_claude_hooks"),
  focus: (pid: number | null, agent: string, sessionKey?: string) => invoke<void>("focus_session", { pid, agent, sessionKey }),
  openInTerminal: (agent: string, sessionKey: string, cwd: string) => invoke<string>("open_in_terminal", { agent, sessionKey, cwd }),
  setBadge: (count: number) => invoke<void>("set_badge", { count }),
  hubTasks: () => invoke<HubTask[]>("hub_tasks"),
  hubWorkers: () => invoke<HubWorker[]>("hub_workers"),
  hubCreate: (t: { title: string; body: string; worker: string; workspace: string }) => invoke<HubTask>("hub_create_task", t),
  hubCancel: (id: string) => invoke<void>("hub_cancel_task", { id }),
};
