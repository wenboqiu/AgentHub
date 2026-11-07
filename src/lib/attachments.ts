import type { Attachment, AttachmentInput } from "./api";
import { ACCEPTED_TYPES, fileToDataUrl, fitsLimit } from "./images.ts";

/**
 * 附件在备注里只留一行引用：图片 `![名称](attachment:12)`、文件 `[名称](attachment:12)`。
 * 渲染时再由 Markdown 拿附件列表把 attachment:12 换成真东西，这样备注始终是纯文本，
 * 不会被 base64 撑爆 4000 字上限，也不会拖累 PATCH 与 WS 广播。
 */
export const REF_RE = /!?\[([^\]]*)\]\(attachment:(\d+)\)/g;
/** 单个文件上限，与服务端 attachments.ts 的 FILE_MAX_BYTES 一致 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

export function refOf(a: { id: number; name: string; kind: "image" | "file" }): string {
  return `${a.kind === "image" ? "!" : ""}[${a.name}](attachment:${a.id})`;
}

/** 从 href / src 里认出附件 id；不是附件引用就返回 null */
export function attachmentId(href: string | null | undefined): number | null {
  const m = /^attachment:(\d+)$/.exec((href ?? "").trim());
  return m ? Number(m[1]) : null;
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** 备注里引用了、但附件已经没了的 id：渲染成「附件已删除」，不装成坏图 */
export function danglingRefs(notes: string, attachments: Attachment[]): number[] {
  const have = new Set(attachments.map(a => a.id));
  const out = new Set<number>();
  for (const m of notes.matchAll(REF_RE)) {
    const id = Number(m[2]);
    if (!have.has(id)) out.add(id);
  }
  return [...out];
}

/** 派活时发给执行者的正文：引用换成附件名，attachment:12 对 agent 没有意义 */
export function notesForAgent(notes: string, attachments: Attachment[]): string {
  const byId = new Map(attachments.map(a => [a.id, a]));
  return notes.replace(REF_RE, (_all, label: string, raw: string) => {
    const a = byId.get(Number(raw));
    const name = a?.name || label || "附件";
    return a?.kind === "file" ? `「${name}」` : `（见截图「${name}」）`;
  });
}

/** 文件后缀：附件区给文件画个小标签用，没有后缀就退回 MIME 的尾部 */
export function fileKind(name: string, mime: string): string {
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1];
  if (ext) return ext.toUpperCase();
  return (mime.split("/")[1] || "FILE").slice(0, 8).toUpperCase();
}

/** 读文件成裸 base64（去掉 data URL 头），供上传用 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]*;base64,/, ""));
    reader.onerror = () => reject(new Error(`读取「${file.name}」失败`));
    reader.readAsDataURL(file);
  });
}

/** 把服务端给的 base64 存成文件（下载按钮 / 点附件链接都走这里） */
export function saveBase64(name: string, mime: string, base64: string) {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mime || "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name || "attachment";
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * 把一个本地文件读成上传入参：图片先压缩成 data URL（和聊天附图同一套），
 * 其余按 base64。超限直接抛错，交给调用方拼提示。
 */
export async function readForUpload(file: File): Promise<AttachmentInput> {
  if (ACCEPTED_TYPES.includes(file.type)) {
    const data = await fileToDataUrl(file);
    if (!fitsLimit(data)) throw new Error(`${file.name || "截图"} 压缩后还是太大`);
    return { kind: "image", name: file.name || `截图-${Date.now()}.png`, mime: file.type, data };
  }
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} 超过 ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  return {
    kind: "file", name: file.name || "附件", mime: file.type || "application/octet-stream",
    data: await fileToBase64(file),
  };
}
