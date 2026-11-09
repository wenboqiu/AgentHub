import { memo } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkBreaks from "remark-breaks";
import type { Attachment } from "./lib/api";
import { attachmentId, formatSize } from "./lib/attachments";

/**
 * 应用里所有展示 agent / 机器生成文本的地方统一走这里（对话流、任务产物、
 * 验收摘要、项目近况、会话摘要、助手气泡、任务备注等），按 GFM 渲染。
 * 默认不渲染原始 HTML（react-markdown 的安全默认），链接统一新窗口打开，
 * 避免 Tauri webview 里被原地导航。memo 化：流式增长时只有文本变了才重渲染。
 *
 * compact：卡片 / 列表里的紧凑排版（边距减半），如会话摘要、项目近况。
 * attachments：任务备注里的 `attachment:12` 引用 → 附件实体。不传就按普通链接渲染；
 * 传了但找不到（附件被删）降级成「附件已删除」，不装成坏图。react-markdown 默认会
 * 过滤掉不认识的协议，所以这里用 urlTransform 给 attachment: 单独放行。
 */
type Props = {
  text: string;
  compact?: boolean;
  /** undefined = 附件还没读回来（引用按纯文本渲染）；给了数组就认 attachment: 协议 */
  attachments?: Attachment[] | null;
  /** 点文件附件（下载 / 打开）；图片点击走 onImage 预览 */
  onAttachment?: (id: number) => void;
  onImage?: (url: string) => void;
  /**
   * 宽松排版，只给 Codex 的消息开：remark-cjk-friendly 修 **“……”** 这类加粗紧贴中文标点时露出字面 `**`；
   * remark-breaks 把段落里的单个换行渲染成换行（Codex 习惯一行一句，标准 Markdown 会把它吞成空格）。
   * 其他通道本来就没问题，保持标准 GFM，不受影响。
   */
  lenient?: boolean;
};

const PLUGINS = [remarkGfm];
const LENIENT_PLUGINS = [remarkGfm, remarkCjkFriendly, remarkBreaks];

const Markdown = memo(function Markdown({ text, compact = false, lenient = false, attachments, onAttachment, onImage }: Props) {
  const loaded = Array.isArray(attachments);
  const byId = new Map((attachments ?? []).map(a => [a.id, a]));
  // 附件还没读回来时不放行：react-markdown 会把 href 过滤成空，这里正好渲染成纯文本
  const urlTransform = loaded
    ? (url: string) => (url.startsWith("attachment:") ? url : defaultUrlTransform(url))
    : defaultUrlTransform;
  return (
    <div className={`md${compact ? " md-compact" : ""}`}>
      <ReactMarkdown
        remarkPlugins={lenient ? LENIENT_PLUGINS : PLUGINS}
        urlTransform={urlTransform}
        components={{
          a: ({ href, children }) => {
            const id = attachmentId(href);
            if (id === null) {
              // href 为空 = 协议被默认过滤（附件还没加载出来）：渲染成纯文本，别给个能点跳的空链接
              return href
                ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
                : <span>{children}</span>;
            }
            const a = byId.get(id);
            if (!a) return <span className="attachment-chip missing" title="附件已删除">{children}</span>;
            return (
              <button type="button" className="attachment-chip" title={`${a.name} · ${formatSize(a.size)}`}
                onClick={e => { e.stopPropagation(); onAttachment?.(a.id); }}>
                {children}<span className="dim"> · {formatSize(a.size)}</span>
              </button>
            );
          },
          img: ({ src, alt }) => {
            const id = attachmentId(typeof src === "string" ? src : "");
            if (id === null) return src ? <img src={src} alt={alt ?? ""} loading="lazy" /> : null;
            const a = byId.get(id);
            if (!a) return <span className="attachment-chip missing">附件已删除{alt ? `（${alt}）` : ""}</span>;
            // 图还在、data URL 还没取回来：给个占位，别谎报「已删除」
            if (!a.url) return <span className="attachment-chip">{a.name}<span className="dim"> · 图片加载中…</span></span>;
            return <img className="md-image" src={a.url} alt={alt || a.name} onClick={e => { e.stopPropagation(); onImage?.(a.url!); }} />;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

export default Markdown;
