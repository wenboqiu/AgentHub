import { useState } from "react";
import type { Api, Project, Proposal, Role, Session, Task } from "./lib/api";
import { AGENT_LABEL } from "./lib/agents";
import Icon from "./Icon";
import ProposalCard from "./ProposalCard";

/**
 * 任务单详情：对话页只留一个「任务单」按钮，点进来才展开全文。
 * 会话跑完攒的任务单（接着做 / 下一步 / 先修问题）都挂在这个会话下：
 * 待确认的排前面，处理过的留在下面当结论。
 */
export default function ProposalView({ sessionId, session, proposals, api, roles, projects, autoDispatch, onChanged, onTask, onBack, onSession }: {
  sessionId: string;
  session: Session | undefined;
  proposals: Proposal[];
  api: Api;
  roles: Role[];
  projects: Project[];
  /** 项目经理开了自动派发：卡片上多一个「生成并派发」 */
  autoDispatch: boolean;
  onChanged(p: Proposal): void;
  onTask(t: Task): void;
  onBack(): void;
  onSession(id: string): void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const rank = (p: Proposal) => (p.status === "pending" ? 0 : 1);
  // 待确认先看，同一档里新的在前
  const sorted = [...proposals].sort((a, b) => rank(a) - rank(b) || Date.parse(b.eventAt) - Date.parse(a.eventAt));
  const pending = sorted.filter((p) => p.status === "pending").length;
  const from = session
    ? `来自「${session.title || "未命名会话"}」（${AGENT_LABEL[session.agent] ?? session.agent}${session.project ? ` · ${session.project}` : ""}）`
    : "来源会话已经不在列表里";
  const summary = pending > 0
    ? `${pending} 份待确认${sorted.length > pending ? ` · 共 ${sorted.length} 份` : ""}`
    : `${sorted.length} 份都已处理`;

  return (
    <div className="app">
      <header>
        <button className="back-button" onClick={onBack}><Icon name="back" />返回</button>
        <h1>任务单</h1>
        <span className="spacer" />
        {session && (
          <button className="icon-button" title="回到这条会话" aria-label="回到这条会话" onClick={() => onSession(sessionId)}>
            <Icon name="sessions" />
          </button>
        )}
      </header>
      <main className="entity-detail">
        <p className="hint proposal-source">{from} · {summary}</p>
        {err && <p className="run-error" role="alert">{err}</p>}
        {sorted.length === 0 ? (
          <p className="empty">这条会话还没有任务单。</p>
        ) : (
          <section className="proposal-list" aria-label="项目经理的任务单">
            {sorted.map((p) => (
              <ProposalCard key={p.id} api={api} proposal={p} roles={roles} projects={projects}
                autoDispatch={autoDispatch} busy={busy} onBusy={setBusy}
                onError={setErr} onChanged={onChanged} onTask={onTask} onOpenSession={onSession} />
            ))}
          </section>
        )}
      </main>
    </div>
  );
}
