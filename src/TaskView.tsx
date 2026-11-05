import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Api, EvidenceKind, Goal, Profile, Project, Review, ReviewItem, Role, Session, Task, TaskArtifact, TaskConstraints, TaskDigests, TaskInput, ThreadEvent } from "./lib/api";
import { NO_CONSTRAINTS } from "./lib/api";
import { TASK_LABEL } from "./TasksPanel";
import Icon from "./Icon";
import { localDateTime } from "./ScheduleFields";
import { PrioritySelect } from "./GoalPriority";
import Checklist from "./Checklist";
import InlineField from "./InlineField";
import { AGENT_LABEL, DISPATCHABLE_AGENTS, agentName, isDispatchable, isListenOnly } from "./lib/agents";

const fmt = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString() : "未设置";
const STATE_LABEL: Record<string, string> = { idle: "空闲", running: "运行中", waiting: "等待授权", done: "已完成", aborted: "已中断", ended: "已结束", unknown: "状态未知" };
const ROLE_LABEL: Record<string, string> = { user: "用户", assistant: "助手", tool: "工具", approval: "授权", system: "系统" };
const RUN_LABEL: Record<string, string> = { queued: "排队中", running: "运行中", done: "完成", failed: "失败", stopped: "已停止" };
const STATUSES = Object.keys(TASK_LABEL) as Task["status"][];
/** 执行工具下拉：只列能远程派活的 agent；豆包 / WorkBuddy 只做状态监听，不放进下拉 */
const AGENT_OPTIONS = DISPATCHABLE_AGENTS.map(value => ({ value, label: AGENT_LABEL[value] }));
const toIso = (v: string) => v ? new Date(v).toISOString() : null;

/**
 * 任务详情：所有字段就地编辑、改动即时保存（参考 Linear / Todoist 的详情页），
 * 「完成」是主操作放在标题左侧，删除这类危险操作沉到页面底部。
 */
export default function TaskView({ task, goals, sessions, agents, api, digest: liveDigest, artifact: liveArtifact, onArtifact, onBack, onSession, onSaved, onDeleted }: { task: Task; goals: Goal[]; sessions: Session[]; agents: string[]; api: Api; digest?: TaskDigests; artifact?: TaskArtifact; onArtifact(a: TaskArtifact): void; onBack(): void; onSession(id: string): void; onSaved(t: Task): void; onDeleted(): void }) {
  const [busy, setBusy] = useState(false), [err, setErr] = useState(""), [saved, setSaved] = useState(false);
  const [starting, setStarting] = useState(false), [message, setMessage] = useState(""), [linking, setLinking] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [fetchedDigest, setFetchedDigest] = useState<TaskDigests | null>(null);
  // 任务产物：跑完自动生成，可改可导出。liveArtifact 是 WS 推来的最新一份
  const [fetchedArtifact, setFetchedArtifact] = useState<TaskArtifact | null>(null);
  const [artifactName, setArtifactName] = useState("");
  const [editingArtifact, setEditingArtifact] = useState(false), [artifactDraft, setArtifactDraft] = useState("");
  const [timeline, setTimeline] = useState<ThreadEvent[] | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [failing, setFailing] = useState<number | null>(null), [note, setNote] = useState(""), [newItem, setNewItem] = useState("");
  const flashTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);
  useEffect(() => { if (!task.timerStartedAt) return; const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, [task.timerStartedAt]);
  // 预摘要：打开详情时拉一次，任务更新（如重新进入待验收）后再拉；WS 推送的实时摘要优先
  useEffect(() => {
    let alive = true;
    api.digests(task.id).then(d => { if (alive) setFetchedDigest(d); }).catch(() => {});
    api.artifact(task.id).then(r => { if (alive) { setFetchedArtifact(r.artifact); setArtifactName(r.path); } }).catch(() => {});
    // Thread 时间线：任务为锚点的统一事件流（消息 / 执行 / 提醒 / 摘要）
    api.thread(task.id).then(r => { if (alive) setTimeline(r.events); }).catch(() => { if (alive) setTimeline([]); });
    // 验收：检查项 + 证据 + 打回沉淀的标准
    api.review(task.id).then(r => { if (alive) setReview(r); }).catch(() => { if (alive) setReview(null); });
    return () => { alive = false; };
  }, [api, task.id, task.updatedAt]);
  // 项目配置与角色只在打开详情时拉一次（改动不频繁）
  useEffect(() => {
    let alive = true;
    api.profiles().then(p => { if (alive) setProfiles(p); }).catch(() => {});
    api.roles().then(r => { if (alive) setRoles(r); }).catch(() => {});
    api.projects().then(p => { if (alive) setProjects(p); }).catch(() => {});
    return () => { alive = false; };
  }, [api]);
  const digest: TaskDigests | null = liveDigest ?? fetchedDigest;
  const artifact = liveArtifact ?? fetchedArtifact;
  const takeArtifact = (a: TaskArtifact) => { setFetchedArtifact(a); onArtifact(a); };
  const saveArtifact = () => void guard(async () => {
    if (!artifactDraft.trim()) { setErr("产物内容不能为空"); return; }
    takeArtifact((await api.saveArtifact(task.id, artifactDraft)).artifact);
    setEditingArtifact(false);
  });
  // 重建会覆盖人改过的版本，所以人改过的要再确认一次
  const rebuildArtifact = () => void guard(async () => {
    if (artifact?.edited && !window.confirm("这份产物你改过，重建会覆盖你的修改。继续？")) return;
    const r = await api.rebuildArtifact(task.id, true);
    takeArtifact(r.artifact); setArtifactName(r.path); setEditingArtifact(false);
  });
  const removeArtifact = () => void guard(async () => {
    if (!window.confirm("删除这份产物？任务本身不受影响，下次跑完会重新生成。")) return;
    await api.deleteArtifact(task.id);
    setFetchedArtifact(null); setEditingArtifact(false);
  });
  const downloadArtifact = () => {
    if (!artifact) return;
    const name = (artifactName || `docs/tasks/${task.id}-task.md`).split("/").pop() || `task-${task.id}.md`;
    const url = URL.createObjectURL(new Blob([artifact.md], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  };
  const flash = () => { setSaved(true); window.clearTimeout(flashTimer.current); flashTimer.current = window.setTimeout(() => setSaved(false), 1600); };
  const elapsed = (iso: string) => { const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h} 小时 ${m} 分` : `${m} 分 ${s % 60} 秒`; };
  /** 时间线里执行节点的耗时：只有两端都有才显示，不拿"现在"凑 */
  const gap = (from: string, to: string) => { const s = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000)), h = Math.floor(s / 3600), m = Math.round(s % 3600 / 60); return h ? `${h} 小时 ${m} 分` : `${Math.max(1, m)} 分`; };

  const guard = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(""); try { await fn(); flash(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const patch = (v: TaskInput) => void guard(async () => onSaved(await api.updateTask(task.id, v)));
  // 验收判定：通过 / 打回（打回原因沉淀为账号级标准，下次交付前自查）
  const decide = (it: ReviewItem, status: ReviewItem["status"]) => void guard(async () => {
    await api.decideReviewItem(task.id, it.id, status, status === "fail" ? note : it.note);
    setReview(await api.review(task.id));
    if (status === "fail") { setFailing(null); setNote(""); }
  });
  const addItem = () => void guard(async () => {
    await api.addReviewItem(task.id, newItem.trim());
    setNewItem("");
    setReview(await api.review(task.id));
  });
  const passed = review?.items.filter(i => i.status === "pass").length ?? 0;
  const evidenceGroups = (["test", "command", "file", "shot", "log"] as EvidenceKind[])
    .map(k => ({ k, label: (review?.evidence ?? []).find(e => e.kind === k)?.label ?? k, list: (review?.evidence ?? []).filter(e => e.kind === k) }))
    .filter(g => g.list.length > 0);

  const currentRole = task.roleId === null ? null : roles.find(r => r.id === task.roleId) ?? null;
  const currentProject = task.projectId === null ? null : projects.find(p => p.id === task.projectId) ?? null;
  const done = task.status === "done";
  const machine = task.machine || (agents.length === 1 ? agents[0] : "");
  const listenOnly = isListenOnly(task.agent);
  // 电脑离线不再拦住派活：改成入队，等那台电脑上线自动开始
  const offline = !!machine && !agents.includes(machine);
  const reason = !task.agent ? "请选择执行工具" : listenOnly ? `${agentName(task.agent ?? "")} 只做状态监听，请在客户端里执行后用「关联已有会话」挂上` : !task.cwd ? "请填写项目目录" : !machine ? "请选择电脑" : "";
  const machines = [...new Set([...agents, ...(task.machine ? [task.machine] : [])])];
  const items = task.checklist ?? [];
  const goalTitle = goals.find(g => g.id === task.goalId)?.title;

  return <div className="app"><header><button className="back-button" onClick={onBack}><Icon name="back" />返回</button><h1>任务详情</h1>{saved && <span className="save-flash" role="status">已保存</span>}</header><main className="entity-detail">
    <section className="entity-read">
      <div className="detail-head">
        <button className={`complete-toggle ${done ? "done" : ""}`} aria-pressed={done} title={done ? "标记为未完成" : "标记为完成"} aria-label={done ? "标记为未完成" : "标记为完成"} disabled={busy} onClick={() => patch({ status: done ? "todo" : "done" })}><Icon name="check" /></button>
        <InlineField className="title-field" value={task.title} ariaLabel="任务标题" placeholder="任务标题" maxLength={200} disabled={busy} onSave={title => patch({ title })} />
      </div>

      <div className="detail-props">
        <div className="prop"><span className="prop-label">状态</span>
          <div className="seg status" role="group" aria-label="任务状态">{STATUSES.map(s => <button key={s} className={task.status === s ? "active" : ""} aria-pressed={task.status === s} disabled={busy} onClick={() => patch({ status: s })}>{TASK_LABEL[s]}</button>)}</div>
        </div>
        <div className="prop"><span className="prop-label">优先级</span>
          <PrioritySelect value={task.priority ?? "medium"} onChange={priority => patch({ priority })} />
        </div>
        <div className="prop"><span className="prop-label">所属目标</span>
          <select className="inline-control" aria-label="所属目标" value={task.goalId ?? ""} disabled={busy} onChange={e => patch({ goalId: e.target.value ? Number(e.target.value) : null })}><option value="">无目标</option>{goals.map(g => <option key={g.id} value={g.id}>{g.title}</option>)}</select>
        </div>
      </div>

      <div className="detail-props">
        <div className="prop"><span className="prop-label">开始时间</span>
          <input className="inline-control" type="datetime-local" aria-label="开始时间" value={localDateTime(task.startAt)} max={localDateTime(task.dueAt) || undefined} disabled={busy} onChange={e => patch({ startAt: toIso(e.target.value) })} />
          <label className="check"><input type="checkbox" checked={task.remindStart} disabled={busy || !task.startAt} onChange={e => patch({ remindStart: e.target.checked })} />开始时提醒</label>
        </div>
        <div className="prop"><span className="prop-label">截止时间</span>
          <input className={`inline-control ${task.dueAt && !done && Date.parse(task.dueAt) < now ? "overdue" : ""}`} type="datetime-local" aria-label="截止时间" value={localDateTime(task.dueAt)} min={localDateTime(task.startAt) || undefined} disabled={busy} onChange={e => patch({ dueAt: toIso(e.target.value) })} />
          <label className="check"><input type="checkbox" checked={task.remindDue} disabled={busy || !task.dueAt} onChange={e => patch({ remindDue: e.target.checked })} />截止时提醒</label>
        </div>
        {task.doneAt && <div className="prop"><span className="prop-label">完成时间</span><span className="prop-value">{fmt(task.doneAt)}</span></div>}
      </div>

      <InlineField className="notes-field" multiline value={task.notes} ariaLabel="任务备注" placeholder="添加备注…（⌘/Ctrl + 回车保存）" maxLength={4000} required={false} disabled={busy} onSave={notes => patch({ notes })} />

      <Checklist items={items} disabled={busy} onChange={checklist => patch({ checklist })} />
    </section>

    <section className="detail-section">
      <h3>执行边界<span className="dim"> · 超出范围的动作会停下来问你</span></h3>
      <p className="hint">代批先按这份边界判：写在这里的动作直接放行，越界的交给人。留空 = 不限目录，联网 / 推远端 / 跑脚本都不预先授权。</p>
      <BoundsEditor value={task.constraints ?? NO_CONSTRAINTS} disabled={busy} onChange={constraints => patch({ constraints })} />
    </section>

    {err && <p className="form-error" role="alert">{err}</p>}

    {review && (review.items.length > 0 || review.evidence.length > 0 || task.status === "review") && (
      <section className="detail-section">
        <h3>验收{review.items.length > 0 ? <span className="dim"> · {passed}/{review.items.length} 通过</span> : null}</h3>
        {review.items.length === 0 && <p className="hint">这个任务还没有检查项。任务清单里的每一项都会自动变成检查项，也可以在这里临时补。</p>}
        <ul className="review-list">
          {review.items.map(it => (
            <li key={it.id} className={`review-item ${it.status}`}>
              <div className="review-row">
                <span className={`review-dot ${it.status}`} aria-hidden />
                <span className="review-title">{it.title}</span>
                <span className="review-actions">
                  <button className="link" disabled={busy} onClick={() => void decide(it, it.status === "pass" ? "pending" : "pass")}>{it.status === "pass" ? "撤销" : "通过"}</button>
                  <button className="link danger" disabled={busy} onClick={() => { setFailing(failing === it.id ? null : it.id); setNote(it.note); }}>{it.status === "fail" ? "重新打回" : "打回"}</button>
                </span>
              </div>
              {it.note && failing !== it.id && <p className="review-note-text">{it.note}</p>}
              {failing === it.id && (
                <div className="review-note">
                  <textarea value={note} maxLength={500} placeholder="打回原因（会沉淀为标准，下次交付前先自查）" onChange={e => setNote(e.target.value)} />
                  <div className="action-bar">
                    <button className="primary" disabled={busy} onClick={() => void decide(it, "fail")}>确认打回</button>
                    <button onClick={() => setFailing(null)}>取消</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
        <form className="review-add" onSubmit={e => { e.preventDefault(); if (newItem.trim()) addItem(); }}>
          <input value={newItem} maxLength={500} placeholder="补一项检查…" onChange={e => setNewItem(e.target.value)} />
          <button disabled={busy || !newItem.trim()}>添加</button>
        </form>

        {evidenceGroups.length > 0 && (
          <div className="evidence">
            <p className="dim">证据（自动摘取自会话记录，只读）</p>
            {evidenceGroups.map(g => (
              <details key={g.k}>
                <summary>{g.label} · {g.list.length}</summary>
                <ul>{g.list.map((e, i) => <li key={i}><code>{e.value}</code></li>)}</ul>
              </details>
            ))}
          </div>
        )}

        {review.standards.length > 0 && (
          <div className="review-standards">
            <p className="dim">打回沉淀的标准（最近 5 条，交付前先自查）</p>
            <ul>{review.standards.map((s, i) => <li key={i}>{s}</li>)}</ul>
          </div>
        )}
      </section>
    )}

    {(digest?.review || digest?.failure) && (
      <section className="detail-section">
        <h3>预摘要</h3>
        {digest?.failure && (
          <div className="digest-card bad">
            <strong>最近一次失败（{new Date(digest.failure.builtAt).toLocaleString()}）</strong>
            <p>{digest.failure.error || "（执行器未返回错误信息）"}</p>
            {digest.failure.tail.length > 0 && (
              <p className="dim">{digest.failure.tail.map(m => `[${m.role}] ${m.text}`).join(" ⏎ ")}</p>
            )}
          </div>
        )}
        {digest?.review && (
          <div className="digest-card">
            <strong>验收摘要{digest.review.sessionTitle ? ` · ${digest.review.sessionTitle}` : ""}</strong>
            <p className="dim">
              {digest.review.messages > 0 ? `已同步 ${digest.review.messages} 条消息` : "会话还没有同步消息"}
              {digest.review.runs.length ? ` · 最近执行 ${digest.review.runs.map(r => r.status).join(" / ")}` : ""}
            </p>
            <p>{digest.review.lastReply || "还没有助手回复内容；打开会话详情加载历史可看全文。"}</p>
            {digest.review.sessionId && <button className="link" onClick={() => onSession(digest.review!.sessionId!)}>打开会话</button>}
          </div>
        )}
        <p className="hint">摘要在会话完成或失败时由服务端后台预生成，打开详情即可看到，不用等终端加载。</p>
      </section>
    )}

    <section className="detail-section">
      <h3>
        任务产物
        {artifact && <span className="dim"> · {artifact.edited ? "人改过" : artifact.source === "agent" ? "执行端交付" : "自动生成"} · {new Date(artifact.updatedAt).toLocaleString()}</span>}
      </h3>
      {artifact ? (editingArtifact ? (
        <div className="artifact-edit">
          <textarea value={artifactDraft} onChange={e => setArtifactDraft(e.target.value)} rows={18} spellCheck={false} />
          <div className="action-bar">
            <button className="primary" disabled={busy} onClick={saveArtifact}>保存</button>
            <button disabled={busy} onClick={() => setEditingArtifact(false)}>取消</button>
            <span className="hint">Markdown；保存后会标记为「人改过」，自动重建不再覆盖。</span>
          </div>
        </div>
      ) : (
        <>
          <pre className="artifact-md">{artifact.md}</pre>
          <div className="action-bar">
            <button disabled={busy} onClick={() => { setArtifactDraft(artifact.md); setEditingArtifact(true); }}><Icon name="edit" />编辑</button>
            <button disabled={busy} onClick={rebuildArtifact}>按最新会话重建</button>
            <button disabled={busy} onClick={downloadArtifact}>导出 .md</button>
            <button className="link" disabled={busy} onClick={removeArtifact}>删除</button>
          </div>
          <p className="hint">每个任务跑完自动留一份：做了什么、怎么验证、影响面、后续与风险。导出文件名 {artifactName || `docs/tasks/${task.id}-task.md`}。</p>
        </>
      )) : (
        <>
          <p className="dim">这个任务还没有产物。跑过一次后服务端会自动生成。</p>
          {(task.sessionIds.length > 0 || task.status === "review" || task.status === "done") && (
            <div className="action-bar">
              <button disabled={busy} onClick={rebuildArtifact}>按现有材料生成</button>
            </div>
          )}
        </>
      )}
    </section>

    {timeline !== null && timeline.length > 0 && (
      <section className="detail-section">
        <h3>
          时间线
          <button className="link" onClick={() => void api.thread(task.id).then(r => setTimeline(r.events)).catch(() => {})}>刷新</button>
        </h3>
        <ul className="timeline">
          {timeline.slice(0, 50).map((e, i) => (
            <li key={i} className={`tl-item tl-${e.type}`}>
              <span className="tl-time">{new Date(e.at).toLocaleString()}</span>
              <span className="tl-body">
                {e.type === "message" && <>{ROLE_LABEL[e.role] ?? e.role}：{e.text.slice(0, 200)}</>}
                {e.type === "run" && (e.phase === "start"
                  ? <>开始执行{e.status === "queued" ? "（排队中）" : ""}</>
                  : <>执行{RUN_LABEL[e.status] ?? e.status}{e.startedAt ? ` · 耗时 ${gap(e.startedAt, e.at)}` : ""}{e.error ? ` · ${e.error.slice(0, 120)}` : ""}</>)}
                {e.type === "reminder" && <>{e.title}{e.acked ? "（已处理）" : ""}</>}
                {e.type === "digest" && <>{e.kind === "failure" ? "失败上下文" : "验收摘要"}：{e.text.slice(0, 200) || "（无内容）"}</>}
              </span>
            </li>
          ))}
        </ul>
        <p className="hint">以任务为锚点的统一事件流：关联会话的对话、执行记录、时间提醒和摘要按时间合并；最多显示最近 50 条。</p>
      </section>
    )}

    <section className="detail-section">
      <h3>执行</h3>
      <div className="action-bar">
        {task.timerStartedAt
          ? <><button disabled={busy} onClick={() => void guard(async () => onSaved(await api.stopTimer(task.id)))}>结束计时</button><span className="dim">已计时 {elapsed(task.timerStartedAt)}</span></>
          : <button disabled={busy || done} onClick={() => void guard(async () => onSaved(await api.startTimer(task.id)))}><Icon name="timer" />开始计时</button>}
        {roles.length > 0 && <label className="role-pick">角色
          <select value={task.roleId ?? ""} disabled={busy} onChange={e => patch({ roleId: e.target.value ? Number(e.target.value) : null })}><option value="">不指定</option>{roles.map(r => <option key={r.id} value={r.id}>{r.name}{r.model ? ` · ${r.model}` : ""}</option>)}</select>
        </label>}
        <button className="primary" disabled={busy || !!reason} onClick={() => { setMessage(task.notes || task.title); setStarting(true); }}>{offline ? "排队等上线" : task.sessionIds.length ? "再开一个会话" : "开始执行"}</button>
        {reason ? <span className="dim">{reason}</span> : offline ? <span className="dim">{machine} 离线，开始后会在它上线时自动派发</span> : null}
      </div>
      {task.queuedAt && <p className="hint queue-hint" role="status">
        已排队 · 等 {task.machine || machine} 上线后自动开始（{new Date(task.queuedAt).toLocaleString()} 入队）
        <button className="link" disabled={busy} onClick={() => void guard(async () => onSaved(await api.unqueueTask(task.id)))}>取消排队</button>
      </p>}
      {starting && <form className="selection-panel" onSubmit={e => { e.preventDefault(); void guard(async () => { const r = await api.startTask(task.id, { text: message, machine }); onSaved(r.task);
              if (r.roleDegraded) setErr("电脑端版本较旧：角色里的模型与上下文没有生效，升级电脑端后重新派发即可");
              if (r.sessionId) onSession(r.sessionId); else setStarting(false); }); }}>
        <label>第一条消息<textarea value={message} maxLength={8000} onChange={e => setMessage(e.target.value)} /></label>
        <div className="action-bar"><button className="primary" disabled={busy || !!reason || !message.trim()}>{offline ? "排队，等上线后开始" : "确认开始"}</button><button type="button" onClick={() => setStarting(false)}>取消</button></div>
      </form>}
      <details className="exec-settings" open={!task.agent || !task.cwd}>
        <summary>执行设置（角色 / 项目 / 配置 / 工具 / 电脑 / 目录）</summary>
        <div className="form-grid">
          <label>角色<select value={task.roleId ?? ""} disabled={busy} onChange={e => patch({ roleId: e.target.value ? Number(e.target.value) : null })}><option value="">未指定</option>{roles.map(r => <option key={r.id} value={r.id}>{r.name}{r.model ? ` · ${r.model}` : ""}</option>)}</select></label>
          <label>项目<select value={task.projectId ?? ""} disabled={busy} onChange={e => patch({ projectId: e.target.value ? Number(e.target.value) : null })}><option value="">未指定</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label>项目配置<select value={task.profileId ?? ""} disabled={busy} onChange={e => patch({ profileId: e.target.value ? Number(e.target.value) : null })}><option value="">未指定</option>{profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label>执行工具<select value={task.agent ?? ""} disabled={busy} onChange={e => patch({ agent: (e.target.value || null) as Task["agent"] })}><option value="">无（普通待办）</option>{task.agent && !isDispatchable(task.agent) && <option value={task.agent}>{AGENT_LABEL[task.agent] ?? task.agent}（只做监听，不能派活）</option>}{AGENT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
          <label>电脑<select value={task.machine ?? ""} disabled={busy} onChange={e => patch({ machine: e.target.value || null })}><option value="">开始时自动选择</option>{machines.map(m => <option key={m} value={m}>{m}{agents.includes(m) ? "" : "（离线）"}</option>)}</select></label>
        </div>
        <label className="cwd-field">项目目录<InlineField value={task.cwd ?? ""} ariaLabel="项目目录" placeholder={"例如 D:\\Work2\\项目"} maxLength={4000} required={false} disabled={busy} onSave={cwd => patch({ cwd: cwd || null })} /></label>
        {currentProject && <p className="hint">项目「{currentProject.name}」{currentProject.brief ? `：${currentProject.brief.slice(0, 80)}${currentProject.brief.length > 80 ? "…" : ""}` : "（还没写项目说明）"}；派活时项目说明和该角色在这个项目上的记忆会一起下发。</p>}
        {currentRole && <p className="hint">角色「{currentRole.name}」：{currentRole.agent ? AGENT_LABEL[currentRole.agent] ?? currentRole.agent : "执行工具未定"}{currentRole.model ? ` · 模型 ${currentRole.model}` : " · 用执行端默认模型"}{currentRole.context ? ` · 上下文 ${currentRole.context.length} 字` : " · 没有上下文"}；派活时随第一条消息一起下发。</p>}
        {task.profileId !== null && <p className="hint">选了配置只补空着的字段，已填的不覆盖；配置的检查项模板会并入下面的清单，自动成为验收检查项。</p>}
      </details>
    </section>

    <section className="detail-section">
      <h3>关联会话（{task.sessionIds.length}）</h3>
      {task.sessionIds.length > 0
        ? <ul className="list">{task.sessionIds.map(id => { const s = sessions.find(s => s.id === id); return <li className="linked-row" key={id}><button className="entity-row" disabled={!s} onClick={() => onSession(id)}><span className="entity-main"><strong>{s ? `${AGENT_LABEL[s.agent] ?? s.agent} · ${s.project || "未知项目"}` : "会话已清理"}</strong><span className="dim">{s ? `${s.title} · ${STATE_LABEL[s.state] ?? s.state} · ${new Date(s.updatedAt).toLocaleString()}` : id}</span></span></button><button className="icon-ghost" aria-label="取消挂接" title="取消挂接" disabled={busy} onClick={() => void guard(async () => onSaved(await api.unlinkSession(task.id, id)))}><Icon name="close" /></button></li>; })}</ul>
        : <p className="dim">还没有关联会话。开始执行后会自动挂接。</p>}
      <button className="link" disabled={busy} onClick={() => setLinking(!linking)}>关联已有会话</button>
      {linking && <div className="selection-panel"><p>选择会话（最近 30 条）</p>{sessions.filter(s => !task.sessionIds.includes(s.id)).slice(0, 30).map(s => <button className="entity-row" key={s.id} disabled={busy} onClick={() => void guard(async () => { onSaved(await api.linkSession(task.id, s.id)); setLinking(false); })}><span>{AGENT_LABEL[s.agent] ?? s.agent} · {s.project} · {s.title}</span></button>)}</div>}
    </section>

    <section className="danger-zone">
      <button className="danger" disabled={busy} onClick={() => { if (confirm("删除这个任务？关联会话会保留。")) void guard(async () => { await api.deleteTask(task.id); onDeleted(); }); }}>删除任务</button>
      <span className="dim">{goalTitle ? `属于「${goalTitle}」` : "未归属目标"}</span>
    </section>
  </main></div>;
}

/** 四项能力开关：勾上 = 这个任务授权了这类动作，不勾 = 遇到就停下来问人 */
const BOUND_FLAGS = [
  { key: "net", label: "可联网 / 装依赖", hint: "装新依赖、调外部接口" },
  { key: "push", label: "可推远端", hint: "git push" },
  { key: "scripts", label: "可跑脚本", hint: "npm run xxx、sh / node / python" },
] as const;

/**
 * 执行边界编辑器：文本类字段失焦才提交，勾选立刻生效。
 * 这里声明的不是「权限」而是「这个任务预计要动到哪」，所以默认全空——
 * 没声明的能力一律按「遇到就问人」处理，宁可多问一句。
 */
function BoundsEditor({ value, disabled, onChange }: { value: TaskConstraints; disabled: boolean; onChange(v: TaskConstraints): void }) {
  const joined = value.paths.join(", ");
  const [paths, setPaths] = useState(joined);
  const [note, setNote] = useState(value.note);
  // 别处改过（项目经理细化、别的设备编辑）就跟着同步，别让人看着旧值
  useEffect(() => { setPaths(joined); }, [joined]);
  useEffect(() => { setNote(value.note); }, [value.note]);
  const commitPaths = () => {
    const next = paths.split(/[,，;；\s]+/).map(s => s.trim()).filter(Boolean);
    if (next.join("|") === value.paths.join("|")) return;
    onChange({ ...value, paths: next });
  };
  const commitNote = () => {
    const next = note.trim();
    if (next === value.note) return;
    onChange({ ...value, note: next });
  };
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") e.currentTarget.blur(); };
  return (
    <div className="bounds-editor">
      <label className="bounds-paths">只允许改
        <input className="inline-control" value={paths} maxLength={400} disabled={disabled}
          placeholder="留空 = 整个项目目录；多个用逗号分隔，如 server/src, docs"
          onChange={e => setPaths(e.target.value)} onBlur={commitPaths} onKeyDown={onEnter} />
      </label>
      <div className="bounds-flags">
        {BOUND_FLAGS.map(f => (
          <label key={f.key} className="check" title={f.hint}>
            <input type="checkbox" checked={value[f.key]} disabled={disabled}
              onChange={() => onChange({ ...value, [f.key]: !value[f.key] })} />{f.label}
          </label>
        ))}
      </div>
      <input className="inline-control" value={note} maxLength={400} disabled={disabled}
        placeholder="补充一句（会拼进执行者的系统提示），如：只动服务端，前端这次不碰"
        onChange={e => setNote(e.target.value)} onBlur={commitNote} onKeyDown={onEnter} />
    </div>
  );
}
