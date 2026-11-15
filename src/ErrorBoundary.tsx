import React from "react";

const KEY = "agenthub.lastError";

/** 把最近一次渲染错误留在 localStorage，白屏后还能读到（读写都不能反过来抛错） */
export function recordError(where: string, err: unknown, extra?: string) {
  const e = err instanceof Error ? err : new Error(String(err));
  const text = [`[${new Date().toISOString()}] ${where}`, e.message, e.stack ?? "", extra ?? ""].filter(Boolean).join("\n");
  console.error("[AgentHub]", text);
  try { localStorage.setItem(KEY, text.slice(0, 4000)); } catch { /* 隐私模式 / 配额满 */ }
}

type Props = { label: string; resetKey?: string; onBack?: () => void; children: React.ReactNode };
type State = { error: Error | null };

/** 子树渲染抛错时显示报错而不是整页空白；resetKey 变了（比如换了个会话）自动恢复 */
export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    recordError(this.props.label, error, info.componentStack ?? undefined);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-boundary" role="alert">
        <h2>{this.props.label}出错了</h2>
        <p className="hint">这一块渲染失败，其它页面不受影响。把下面的内容发给开发者即可定位。</p>
        <pre>{error.message}{"\n"}{(error.stack ?? "").split("\n").slice(1, 8).join("\n")}</pre>
        <div className="error-boundary-actions">
          <button onClick={() => this.setState({ error: null })}>重试</button>
          {this.props.onBack && <button onClick={this.props.onBack}>返回</button>}
          <button onClick={() => window.location.reload()}>重新加载</button>
        </div>
      </div>
    );
  }
}
