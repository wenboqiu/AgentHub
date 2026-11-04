// 桌面通知的统一入口。
// 关键点：tauri 的 notification 插件只有在前端注册了 onAction 监听时，才会把「用户点了通知」
// 回报上来；没有监听时通知只显示、点击等于没反应。所以这里在应用启动时注册一次监听，
// 点击后由调用方决定要做什么（叫醒主窗口 + 跳到对应条目）。
import { isDesktop } from "./platform";

/** 点击通知后想在应用里定位到的条目 */
export type NotifyTarget =
  | { kind: "session"; id: string }
  | { kind: "task"; id: number }
  | { kind: "goal"; id: number };

type Plugin = typeof import("@tauri-apps/plugin-notification");

let plugin: Promise<Plugin | null> | null = null;
const load = () => (plugin ??= import("@tauri-apps/plugin-notification").catch(() => null));

/** 权限只问一次，被拒绝后下次再问（用户可能刚在系统设置里改了） */
let granted: Promise<boolean> | null = null;

/** 目标随通知的 extra 一起带给系统，点击时插件原样回传 */
const KIND = "agenthubKind";
const ENTITY = "agenthubId";

function toExtra(t: NotifyTarget): Record<string, string> {
  return { [KIND]: t.kind, [ENTITY]: String(t.id) };
}

function fromExtra(extra: Record<string, unknown> | undefined | null): NotifyTarget | null {
  if (!extra) return null;
  const kind = extra[KIND];
  const id = extra[ENTITY];
  if (typeof id !== "string") return null;
  if (kind === "session") return { kind, id };
  if (kind === "task" || kind === "goal") {
    const n = Number(id);
    return Number.isFinite(n) ? { kind, id: n } : null;
  }
  return null;
}

/**
 * 弹一条系统通知。仅在桌面端生效，失败（无权限 / 插件不可用）时静默返回。
 *
 * `target` 会随通知一起记下来，用户点这条通知时能拿到它（见 onNotificationClick）。
 */
export async function pushNotification(title: string, body: string, target?: NotifyTarget): Promise<void> {
  if (!isDesktop) return;
  const n = await load();
  if (!n) return;
  try {
    granted ??= (async () => {
      if (await n.isPermissionGranted()) return true;
      const ok = (await n.requestPermission()) === "granted";
      if (!ok) granted = null;
      return ok;
    })();
    if (!(await granted)) return;

    n.sendNotification(target ? { title, body, extra: toExtra(target) } : { title, body });
  } catch {
    /* 通知失败不影响主流程 */
  }
}

/**
 * 注册「用户点了通知」的回调；返回取消注册的函数。
 *
 * 桌面端必须在弹任何通知之前注册，否则插件不会上报点击。
 * 注意：Windows 上只有通知还在屏幕上时点击会被回报，已收进通知中心的历史通知系统不再回调。
 */
export async function onNotificationClick(cb: (target: NotifyTarget | null) => void): Promise<() => void> {
  if (!isDesktop) return () => {};
  const n = await load();
  if (!n) return () => {};
  try {
    const listener = await n.onAction((e) => {
      if (e.actionId !== "tap") return;
      cb(fromExtra(e.notification?.extra));
    });
    return () => {
      void listener.unregister();
    };
  } catch {
    return () => {};
  }
}
