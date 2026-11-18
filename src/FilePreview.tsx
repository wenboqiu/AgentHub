import { useEffect, useState } from "react";
import type { FilePreviewData } from "./lib/api";
import Markdown from "./Markdown";

/**
 * 文件预览弹层：文件在执行任务的电脑上，由调用方经服务端往返取回。
 * .md / .markdown 按 Markdown 渲染，其他按原文 <pre>；Esc 或点遮罩关闭。
 */
export default function FilePreview({ load, title, onClose }: { load: () => Promise<FilePreviewData>; title: string; onClose(): void }) {
  const [data, setData] = useState<FilePreviewData | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    load().then(d => { if (alive) setData(d); }).catch(e => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
    // 弹层每次打开都是新实例，只在挂载时取一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const shown = data?.path ?? title;
  const isMd = /\.(md|markdown)$/i.test(shown);
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={`预览 ${title}`} onClick={onClose}>
      <div className="modal-panel file-preview" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h3 title={shown}>{shown}</h3>
          <button type="button" onClick={onClose}>关闭</button>
        </div>
        {!data && !err && <p className="dim">加载中…</p>}
        {err && <p className="form-error" role="alert">{err}</p>}
        {data?.truncated && <p className="hint">文件较大，只显示前 512KB</p>}
        {data && (isMd ? <div className="file-preview-md"><Markdown text={data.text} /></div> : <pre className="file-preview-pre">{data.text}</pre>)}
      </div>
    </div>
  );
}
