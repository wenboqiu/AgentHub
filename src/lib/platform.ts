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
  /** 对话页（待处理 / 进行中）用气泡图展示；false = 卡片列表 */
  graphMode: boolean;
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
const defaults: Config = { serverUrl: "", token: "", machine: "", notifyDesktop: true, email: "", deniedRoots: [], remoteEnabled: false, graphMode: true };

/**
 * 气泡图改成默认之后的一次性迁移：老配置里 graphMode 基本是「没选过」的 false，
 * 这里直接切到新默认；迁移过后用户在设置里的选择（哪怕又选回列表）不再被覆盖。
 */
const GRAPH_DEFAULT_MIGRATED = "agenthub.graph-default-v2";
function migrateGraphMode(c: Config): Config {
  let migrated = "";
  try {
    migrated = localStorage.getItem(GRAPH_DEFAULT_MIGRATED) ?? "";
  } catch {
    return c; // 存储不可用就按已存的值来，不改用户选择
  }
  if (migrated === "1") return c;
  try {
    localStorage.setItem(GRAPH_DEFAULT_MIGRATED, "1");
  } catch {
    return c;
  }
  return { ...c, graphMode: true };
}

export async function loadConfig(): Promise<Config> {
  if (isDesktop) return migrateGraphMode({ ...defaults, ...(await invoke<Config>("get_config")) });
  try {
    const { controlToken: _legacy, ...saved } = JSON.parse(localStorage.getItem(LS_KEY) ?? "{}"); // 旧版的控制密钥丢掉
    return migrateGraphMode({ ...defaults, ...saved });
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
