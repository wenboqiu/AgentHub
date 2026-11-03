import { invoke } from "@tauri-apps/api/core";

export type Config = {
  serverUrl: string;
  token: string;
  machine: string;
  notifyDesktop: boolean;
  /** 登录的邮箱（只用于显示；token 是登录后拿到的设备会话 token） */
  email: string;
  /** 仅桌面：允许手机远程执行的项目目录 */
  allowedRoots: string[];
  /** 仅桌面：允许手机远程执行 */
  remoteEnabled: boolean;
};
export type RemoteInfo = { connected: boolean; lastError: string | null };

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
const defaults: Config = { serverUrl: "", token: "", machine: "", notifyDesktop: true, email: "", allowedRoots: [], remoteEnabled: false };

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
};
