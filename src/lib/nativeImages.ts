/** Android 原生选图：相册 → 系统解码（HEIC、EXIF 方向）→ 压缩 → data URL 回传。桌面端仍走 input[type=file] */

import { MAX_IMAGES } from "./images";

type Pending = { images: string[]; finish: (message: string) => void };

const pending = new Map<string, Pending>();

declare global {
  interface Window {
    /** 原生侧逐张回传（MainActivity 用 evaluateJavascript 调） */
    __agenthubPickImage?: (id: string, dataUrl: string) => void;
    /** 原生侧结束；message 是要提示给用户的话，没有就是空串 */
    __agenthubPickDone?: (id: string, message: string) => void;
  }
}

if (typeof window !== "undefined") {
  window.__agenthubPickImage = (id, dataUrl) => {
    pending.get(id)?.images.push(dataUrl);
  };
  window.__agenthubPickDone = (id, message) => {
    const p = pending.get(id);
    if (!p) return; // 老请求（比如页面已经切走）直接忽略
    pending.delete(id);
    p.finish(message);
  };
}

/** 有没有原生相册通道：只有 Android 装了带 pickImages 的桥才有 */
export function canPickNative(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    /Android/i.test(navigator.userAgent) &&
    typeof window.AgentHubNative?.pickImages === "function"
  );
}

/** 打开相册，等原生把压好的图片逐张送回来；用户取消就是空数组、无提示 */
export function pickNativeImages(limit: number): Promise<{ images: string[]; error: string }> {
  const bridge = typeof window !== "undefined" ? window.AgentHubNative : undefined;
  if (!bridge?.pickImages) return Promise.reject(new Error("这台设备没有相册通道"));
  const id = `pick-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const images: string[] = [];
  return new Promise((resolve) => {
    pending.set(id, { images, finish: (message) => resolve({ images, error: message }) });
    bridge.pickImages!(id, Math.max(1, Math.min(limit, MAX_IMAGES)));
  });
}
