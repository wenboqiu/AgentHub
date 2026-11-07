import { useEffect, useRef, useState } from "react";
import type { Attachment, AttachmentInput } from "./lib/api";
import { readForUpload, refOf } from "./lib/attachments";
import Markdown from "./Markdown";

type Props = {
  notes: string;
  attachments: Attachment[];
  disabled?: boolean;
  /** 保存失败要抛出来：抛了就留在编辑态，别让人白写一段 */
  onSave(notes: string): Promise<void>;
  /** 上传一个附件（图片或文件），返回落库后的实体，id 用来写引用 */
  upload(input: AttachmentInput): Promise<Attachment>;
  /** 点备注里的文件引用：下载 */
  onOpen(id: number): void;
  /** 点备注里的图片：预览 */
  onImage(url: string): void;
};

/**
 * 任务备注：默认是渲染态（Markdown + 内联图片），点一下进编辑态。
 * 编辑时可以直接粘贴截图或把文件拖进来 —— 上传完在光标处插一行 `attachment:ID` 引用，
 * 备注本身只存文字，所以 4000 字上限、PATCH 整条重写、WS 广播都不会被 base64 拖垮。
 */
export default function TaskNotes({ notes, attachments, disabled = false, onSave, upload, onOpen, onImage }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(notes);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [err, setErr] = useState("");
  const area = useRef<HTMLTextAreaElement | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  // 别处改过备注（别的设备、项目经理）就跟着刷新，但正在写的时候不打断
  useEffect(() => { if (!editing) setDraft(notes); }, [notes, editing]);
  useEffect(() => {
    if (!editing) return;
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(420, Math.max(96, el.scrollHeight))}px`;
  }, [editing, draft]);

  const startEdit = () => { if (disabled) return; setErr(""); setEditing(true); };
  const cancel = () => { setDraft(notes); setErr(""); setEditing(false); };
  const save = async () => {
    if (busy) return;
    setBusy(true); setErr("");
    try { await onSave(draft.trim()); setEditing(false); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  /** 在指定位置插一段引用：前后各留一个换行，图片才不会和正文挤在同一行 */
  const insertAt = (at: number, snippet: string) => setDraft(d => {
    const pos = Math.min(Math.max(0, at), d.length);
    const before = d.slice(0, pos), after = d.slice(pos);
    const lead = before && !before.endsWith("\n") ? "\n" : "";
    const tail = after && !after.startsWith("\n") ? "\n" : "";
    return before + lead + snippet + tail + after;
  });

  const addFiles = async (files: File[], at: number) => {
    if (!files.length || disabled) return;
    setUploading(true); setErr("");
    const snippets: string[] = [], problems: string[] = [];
    try {
      for (const f of files) {
        try {
          const a = await upload(await readForUpload(f));
          snippets.push(refOf(a));
        } catch (e) {
          problems.push(e instanceof Error ? e.message : String(e));
        }
      }
    } finally { setUploading(false); }
    if (snippets.length) insertAt(at, snippets.join("\n"));
    if (problems.length) setErr(problems.join("；"));
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (!files.length) return;
    e.preventDefault();
    void addFiles(files, e.currentTarget.selectionStart);
  };
  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    void addFiles(files, area.current?.selectionStart ?? draft.length);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    void addFiles(files, area.current?.selectionStart ?? draft.length);
  };
  const locked = disabled || busy || uploading;

  if (!editing) return (
    <div className="notes-block">
      <div className={`notes-render${notes.trim() ? "" : " empty"}`} role="button" tabIndex={disabled ? -1 : 0} aria-label="编辑备注"
        onClick={startEdit} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); startEdit(); } }}>
        {notes.trim()
          ? <Markdown text={notes} attachments={attachments} onAttachment={onOpen} onImage={onImage} />
          : <p className="notes-empty">添加备注…支持 Markdown，可以直接粘贴截图、拖文件进来</p>}
      </div>
    </div>
  );

  return (
    <div className="notes-block">
      <div className={`notes-edit${dragging ? " dragging" : ""}`}
        onDragOver={e => { if (!disabled) { e.preventDefault(); setDragging(true); } }}
        onDragLeave={() => setDragging(false)} onDrop={onDrop}>
        <textarea ref={area} className="notes-field" aria-label="任务备注" value={draft} maxLength={4000}
          placeholder="写点什么…支持 Markdown；粘贴截图或拖文件进来会自动上传并插入引用" disabled={busy}
          onChange={e => setDraft(e.target.value)} onPaste={onPaste}
          onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); cancel(); } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); } }} />
        <div className="action-bar">
          <button className="primary" disabled={locked || draft.trim() === notes.trim()} onClick={e => { e.preventDefault(); void save(); }}>保存</button>
          <button disabled={busy} onClick={cancel}>取消</button>
          <button type="button" disabled={locked} onClick={() => picker.current?.click()}>{uploading ? "上传中…" : "添加附件"}</button>
          <span className="hint">Markdown · 粘贴截图 / 拖文件进来 · {draft.length}/4000</span>
        </div>
        <input ref={picker} type="file" multiple hidden onChange={onPick} />
        {err && <p className="form-error" role="alert">{err}</p>}
      </div>
    </div>
  );
}
