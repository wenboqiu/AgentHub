import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * 应用里所有展示 agent / 机器生成文本的地方统一走这里（对话流、任务产物、
 * 验收摘要、项目近况、会话摘要、助手气泡等），按 GFM 渲染。
 * 默认不渲染原始 HTML（react-markdown 的安全默认），链接统一新窗口打开，
 * 避免 Tauri webview 里被原地导航。memo 化：流式增长时只有文本变了才重渲染。
 *
 * compact：卡片 / 列表里的紧凑排版（边距减半），如会话摘要、项目近况。
 */
const Markdown = memo(function Markdown({ text, compact = false }: { text: string; compact?: boolean }) {
  return (
    <div className={`md${compact ? " md-compact" : ""}`}>
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
