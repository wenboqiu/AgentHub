import { useEffect, useState } from "react";
import { desktop } from "./lib/platform";

/** 同一张缓存图只读一次（豆包会话页每 3 秒轮询，图片 id 不变） */
const cache = new Map<string, Promise<string>>();

function load(id: string): Promise<string> {
  let p = cache.get(id);
  if (!p) {
    p = desktop.doubaoImage(id);
    // 失败不缓存，下次轮询再试
    p.catch(() => { if (cache.get(id) === p) cache.delete(id); });
    cache.set(id, p);
  }
  return p;
}

/** 豆包消息里的一张图：id 来自缓存匹配；对不上 / 读失败时退回 `[图片]` 占位 */
export default function DoubaoImage({ id, w, h }: { id: string | null; w?: number; h?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setUrl(null);
    setFailed(false);
    if (!id) return;
    let cancelled = false;
    load(id)
      .then((u) => { if (!cancelled) setUrl(u); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [id]);

  if (!id || failed) return <p className="doubao-image missing">[图片]</p>;
  if (!url) {
    const box = w && h ? { aspectRatio: `${w} / ${h}` } : undefined;
    return <div className="doubao-image" style={{ width: 160, ...box, background: "var(--line, rgba(128,128,128,.2))" }} aria-hidden="true" />;
  }
  return <img className="doubao-image" src={url} alt="" loading="lazy" />;
}
