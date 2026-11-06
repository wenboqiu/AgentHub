import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * 对话流里的 markdown 渲染：agent 回复按 GFM 渲染（表格 / 任务清单 / 删除线 / 自动链接）。
 * 默认不渲染原始 HTML（react-markdown 的安全默认），链接统一新窗口打开，
 * 避免 Tauri webview 里被原地导航。memo 化：流式增长时只有文本变了才重渲染。
 */
const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

export default Markdown;
