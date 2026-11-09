import { useEffect, useRef, useState } from "react";
import type { Api, Approval, Attachment, BoardEntry, AttachmentInput, EvidenceKind, Goal, Machine, Project, ProjectDir, Review, ReviewItem, Role, Session, Task, TaskArtifact, TaskDigests, TaskInput, ThreadEvent } from "./lib/api";
import { APPROVAL_TIER_LABEL, NO_CONSTRAINTS, constraintsSummary } from "./lib/api";
import { TASK_LABEL } from "./TasksPanel";
import BoundsEditor from "./BoundsEditor";
import Icon from "./Icon";
import { localDateTime } from "./ScheduleFields";
import { PrioritySelect } from "./GoalPriority";
import Checklist from "./Checklist";
import InlineField from "./InlineField";
import Markdown from "./Markdown";
import TaskNotes from "./TaskNotes";
import { cachedImage, fileKind, formatSize, loadImage, loadImages, notesForAgent, readForUpload, refOf, rememberImage, saveBase64 } from "./lib/attachments";
import { pickMachine } from "./lib/machines";
import { parseQuestions } from "./lib/questions";
import { ago } from "./lib/time";
import { AGENT_LABEL, DISPATCHABLE_AGENTS, agentName, isDispatchable, isListenOnly } from "./lib/agents";

const fmt = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString() : "未设置";
const STATE_LABEL: Record<string, string> = { idle: "空闲", running: "运行中", waiting: "等待授权", done: "已完成", aborted: "已中断", ended: "已结束", unknown: "状态未知" };
const ROLE_LABEL: Record<string, string> = { user: "用户", assistant: "助手", tool: "工具", approval: "授权", system: "系统" };
const RUN_LABEL: Record<string, string> = { queued: "排队中", running: "运行中", done: "完成", failed: "失败", stopped: "已停止" };
const STATUSES = Object.keys(TASK_LABEL) as Task["status"][];
/** 执行工具下拉：只列能远程派活的 agent；豆包 / WorkBuddy 只做状态监听，不放进下拉 */
const AGENT_OPTIONS = DISPATCHABLE_AGENTS.map(value => ({ value, label: AGENT_LABEL[value] }));
const toIso = (v: string) => v ? new Date(v).toISOString() : null;
/** 一条项目配置（电脑 + 目录）的唯一标识：电脑可能为空（哪台都行），拼上目录才不重 */
const dirKey = (d: ProjectDir) => `${d.machine ?? ""}\u0000${d.cwd}`;

/**
 * 任务详情是单页：头部（标题 / 状态 / 执行摘要）→ 状态卡（按任务状态变形态，主操作都在这）
 * → 说明 / 产物 / 过程；属性放右侧栏，窄屏落到下面。删除等危险操作收进标题栏「···」菜单。
 */
export default function TaskView({ task, goals, sessions, agents, api, boardEntry, approvals, roles, projects, digest: liveDigest, artifact: liveArtifact, onArtifact, onBack, onSession, onSaved, onDeleted }: { task: Task; goals: Goal[]; sessions: Session[]; agents: string[]; api: Api; boardEntry?: BoardEntry; approvals: Approval[]; roles: Role[]; projects: Project[]; digest?: TaskDigests; artifact?: TaskArtifact; onArtifact(a: TaskArtifact): void; onBack(): void; onSession(id: string): void; onSaved(t: Task): void; onDeleted(): void }) {
  const [busy, setBusy] = useState(false), [err, setErr] = useState(""), [saved, setSaved] = useState(false);
  const [starting, setStarting] = useState(false), [message, setMessage] = useState(""), [linking, setLinking] = useState(false);
  const [configOpen, setConfigOpen] = useState(false), [menuOpen, setMenuOpen] = useState(false);
  /** 上一次派活由项目经理挑的模型与理由：只在这一屏显示，重新打开以执行记录为准 */
  const [dispatchNote, setDispatchNote] = useState("");
  const [now, setNow] = useState(Date.now());
  const [fetchedDigest, setFetchedDigest] = useState<TaskDigests | null>(null);
  // 任务产物：跑完自动生成，可改可导出。liveArtifact 是 WS 推来的最新一份
  const [fetchedArtifact, setFetchedArtifact] = useState<TaskArtifact | null>(null);
  const [artifactName, setArtifactName] = useState("");
  const [editingArtifact, setEditingArtifact] = useState(false), [artifactDraft, setArtifactDraft] = useState("");
  const [timeline, setTimeline] = useState<ThreadEvent[] | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [fresh, setFresh] = useState(false);
  const [pickOpen, setPickOpen] = useState(false), [pickedMachine, setPickedMachine] = useState("");
  const [pokeOpen, setPokeOpen] = useState(false), [poke, setPoke] = useState("");
  const [replyOpen, setReplyOpen] = useState(false), [evidenceOpen, setEvidenceOpen] = useState<EvidenceKind | null>(null);
  const [machines, setMachines] = useState<Machine[]>([]);
  // 附件：列表只有元信息，图片的 data URL 按 id 单取（缓存起来，切回来不重下）
  const [attachments, setAttachments] = useState<Attachment[] | null>(null), [preview, setPreview] = useState<string | null>(null);
  // 备注正在编辑时不许「插入备注」：那个按钮走 PATCH，会把编辑器里的草稿冲掉
  const [notesEditing, setNotesEditing] = useState(false);
  const [failing, setFailing] = useState<number | null>(null), [note, setNote] = useState(""), [newItem, setNewItem] = useState("");
  // 关联会话不在快照里时（已结束 / 超过 24 小时）按 id 补查一次：
  // 拿到就照常打开，404 才是真的删了。undefined = 还在查，null = 查过但没有。
  const [extra, setExtra] = useState<Record<string, Session | null>>({});
  useEffect(() => {
    let alive = true;
    const missing = task.sessionIds.filter(id => !sessions.some(s => s.id === id) && extra[id] === undefined);
    if (!missing.length) return;
    void Promise.all(missing.map(id => api.session(id).then(s => [id, s] as const).catch(() => [id, null] as const)))
      .then(rows => { if (alive) setExtra(m => { const n = { ...m }; for (const [id, s] of rows) n[id] = s; return n; }); });
    return () => { alive = false; };
  }, [api, task.sessionIds, sessions, extra]);
  const flashTimer = useRef<number | undefined>(undefined);
  const attachPicker = useRef<HTMLInputElement | null>(null);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);
  // 计时中每秒走一格；否则 30 秒一格就够「正在做 · 已跑多久」用了
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), task.timerStartedAt ? 1000 : 30000); return () => window.clearInterval(t); }, [task.timerStartedAt]);
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
  // 附件只跟任务 id 走：任务每保存一次都重拉一遍 20 张图的 base64，太亏。
  // 增删改都在各自的接口返回里就地更新本地状态（见 uploadAttachment / removeAttachment）。
  useEffect(() => {
    let alive = true;
    api.attachments(task.id).then(list => {
      if (!alive) return;
      // 缓存里有的图直接填上，剩下的按 id 单取（并发 3），取到一张刷一张
      const filled = list.map(a => a.url || a.kind !== "image" ? a : { ...a, url: cachedImage(task.id, a.id) ?? null });
      setAttachments(filled);
      const need = filled.filter(a => a.kind === "image" && !a.url).map(a => a.id);
      if (need.length) void loadImages(task.id, need, id => api.downloadAttachment(task.id, id), (id, url) => {
        if (!alive) return;
        setAttachments(cur => cur ? cur.map(a => (a.id === id ? { ...a, url: url } : a)) : cur);
      });
    }).catch(() => { if (alive) setAttachments([]); });
    return () => { alive = false; };
  }, [api, task.id]);
  // 电脑的工具清单是执行器连上来时上报的：在线名单一变就重拉，刚上线的电脑才能马上出现在候选里
  const onlineKey = [...agents].sort().join(",");
  useEffect(() => {
    let alive = true;
    api.machines().then(ms => { if (alive) setMachines(ms); }, () => { if (alive) setMachines([]); });
    return () => { alive = false; };
  }, [api, onlineKey]);
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
  // 附件：备注里只存 attachment:ID 引用，本体在这几个接口里进出
  const uploadAttachment = async (input: AttachmentInput): Promise<Attachment> => {
    const a = await api.uploadAttachment(task.id, input);
    // 上传响应本身就带图（data URL），顺手进缓存，缩略图和备注里的引用都不用再取一次
    if (a.url) rememberImage(task.id, a.id, a.url);
    setAttachments(cur => (cur?.some(x => x.id === a.id) ? cur : [...(cur ?? []), a]));
    return a;
  };
  const openAttachment = (id: number) => {
    const a = attachments?.find(x => x.id === id);
    if (a?.kind === "image" && a.url) { setPreview(a.url); return; }
    // 图还没取回来（或列表里只有元信息）：先取再预览
    if (a?.kind === "image") {
      void guard(async () => setPreview(await loadImage(task.id, id, i => api.downloadAttachment(task.id, i))));
      return;
    }
    void guard(async () => {
      const r = await api.downloadAttachment(task.id, id);
      saveBase64(r.name, r.mime, r.data);
    });
  };
  const removeAttachment = (a: Attachment) => {
    if (!window.confirm(`删除附件「${a.name}」？备注里引用它的地方会一起摘掉。`)) return;
    void guard(async () => {
      const r = await api.deleteAttachment(task.id, a.id);
      // 返回的列表只有元信息：把缓存过的图补回去，别让剩下的缩略图集体消失
      setAttachments(r.attachments.map(x => (x.kind === "image" ? { ...x, url: cachedImage(task.id, x.id) ?? null } : x)));
      onSaved(r.task);
    });
  };
  // 备注编辑器保存：失败要把错误抛回去，编辑器才知道该留在编辑态
  const saveNotes = async (notes: string) => {
    setBusy(true);
    try { onSaved(await api.updateTask(task.id, { notes })); flash(); }
    finally { setBusy(false); }
  };
  // 「插入备注」走 PATCH 直接改服务端的备注：备注正在编辑时这么做，保存草稿会把这条引用冲掉，
  // 附件就成了孤儿。所以编辑态下这个按钮禁用（要用就先保存或取消）。
  const attachToNotes = (a: Attachment) => {
    if (notesEditing) return;
    void guard(async () => {
      const base = task.notes.trimEnd();
      onSaved(await api.updateTask(task.id, { notes: base ? `${base}\n\n${refOf(a)}` : refOf(a) }));
    });
  };
  // 附件区直接上传：不经过备注编辑器，传完再决定要不要往备注里插引用
  const pickAttachments = (files: File[]) => void guard(async () => {
    for (const f of files) {
      try { await uploadAttachment(await readForUpload(f)); }
      catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    }
  });
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
  // 目录不再手填：只从所选项目登记的配置（电脑 + 目录）里挑一条；不选则开始执行时由服务端按电脑自动挑
  const dirs = currentProject?.dirs ?? [];
  // 当前任务目录落在哪条配置上：路径对上即可；绑了机器的还要机器一致才算同一条
  const chosenDir = dirs.find(d => d.cwd === task.cwd && (!d.machine || d.machine === task.machine))
    ?? dirs.find(d => d.cwd === task.cwd) ?? null;
  // 任务上留着一条不在登记里的目录（老数据 / 项目换过）：照实显示，换选即被覆盖
  const cwdOffList = !!task.cwd && !chosenDir;
  const done = task.status === "done";
  // 执行工具跟着角色走：角色绑了工具就以它为准（服务端派活也是这个顺序），
  // 任务上的 agent 只在没挂角色 / 角色没指定工具时兜底——否则会出现「角色写 Claude、任务写 Codex」的冲突
  const tool = currentRole?.agent ?? task.agent;
  const listenOnly = isListenOnly(tool);
  // 候选电脑：上报过能跑这个工具的，或者压根没上报过（老电脑端，当「不知道」放行）；
  // 明确报过没装的直接不列——列出来也派不过去，服务端会拒。规则见 lib/machines.ts
  const { candidates, usable, options, machine, offline, machineLacks } = pickMachine({ machines, online: agents, stored: task.machine, tool });
  // 一条项目配置能不能跑当前工具：绑了电脑的看那台上报的清单；「任意电脑」的看有没有一台能跑。
  // 电脑没上报过清单（老电脑端）当「不知道」放行，与电脑下拉同一套规则（见 lib/machines.ts）
  const fitsTool = (d: ProjectDir): boolean => {
    if (!tool) return true;
    if (d.machine) {
      const c = candidates.find(x => x.name === d.machine);
      return !c || c.agents.length === 0 || c.agents.includes(tool);
    }
    return candidates.length === 0 || candidates.some(c => c.agents.length === 0 || c.agents.includes(tool));
  };
  // 项目可用性：至少有一条登记的配置能跑当前工具；一条都没有就明说「不可用」，别选完才发现派不出去
  const projectUsable = !dirs.length || dirs.some(fitsTool);
  const reason = !tool ? "请选择执行工具"
    : listenOnly ? `${agentName(tool)} 只做状态监听，请在客户端里执行后用「关联已有会话」挂上`
      : !task.cwd && !dirs.length ? "请选择项目，并在项目里挑一条配置（电脑 + 目录）"
        : !task.cwd && !projectUsable ? `项目「${currentProject?.name ?? ""}」登记的配置都装不了 ${agentName(tool)}：这个项目当前不可用，换个角色 / 工具，或在对应电脑上装好再选`
          : !machine ? (usable.length ? "请选择电脑" : `没有能跑 ${agentName(tool)} 的电脑：先在装了这个工具的电脑上打开 AgentHub`)
            : machineLacks ? `${machine} 没装 ${agentName(tool)}：换一台电脑，或给这个角色换个工具` : "";
  // 执行配置的一行摘要：头部、状态卡和侧栏共用，点「编辑」进弹层改
  const cfgParts = [
    currentRole ? `角色 ${currentRole.name}` : "角色未指定",
    tool ? agentName(tool) : "工具未定",
    (task.machine || machine) ? `电脑 ${task.machine || machine}${offline ? "（离线）" : ""}` : "电脑待定",
    task.cwd ? `目录 ${task.cwd}` : dirs.length ? "目录自动挑" : "目录未配置",
  ];
  const configSummary = cfgParts.join(" · ");
  const items = task.checklist ?? [];
  const goalTitle = goals.find(g => g.id === task.goalId)?.title;
  const hasProcess = (timeline?.length ?? 0) > 0 || task.sessionIds.length > 0 || !!(digest?.review || digest?.failure);

  // ---- 状态卡：按任务状态变形态（优先级从上到下取第一个命中的） ----
  const run = boardEntry?.run ?? null;
  const form: "done" | "approval" | "review" | "stuck" | "queued" | "running" | "plain" | "todo" =
    task.status === "done" ? "done"
      : approvals.length > 0 ? "approval"
        : task.status === "review" ? "review"
          : boardEntry?.stuck ? "stuck"
            : (task.queuedAt || boardEntry?.queued) ? "queued"
              : run ? "running"
                : (!tool || listenOnly) ? "plain" : "todo";
  const tone = { done: "ok", approval: "mid", review: "accent", stuck: "alert", queued: "mid", running: "ok", plain: "dim", todo: "accent" }[form];
  const reviewItems = review?.items ?? [];
  const unjudged = reviewItems.filter(it => it.status !== "pass").length;
  const deliveredAt = digest?.review?.lastReplyAt ?? digest?.review?.builtAt ?? task.updatedAt;
  const lastReply = digest?.review?.lastReply ?? "";
  const replyLong = lastReply.length > 240 || lastReply.split("\n").length > 6;
  const checkDone = items.filter(i => i.done).length;
  const queueMachine = task.machine || machine;
  const deliveryInput = fresh ? { delivery: "fresh" as const } : {};
  // 派发：成功后的处理（保存任务、模型说明、角色降级提示、跳到会话）都在这儿，各个按钮共用
  const runStart = async (input: Parameters<Api["startTask"]>[1]) => {
    const r = await api.startTask(task.id, input);
    onSaved(r.task);
    setDispatchNote(r.modelNote ?? "");
    if (r.roleDegraded) setErr("电脑端版本较旧：角色里的模型与上下文没有生效，升级电脑端后重新派发即可");
    if (r.sessionId) onSession(r.sessionId); else setStarting(false);
    setPickOpen(false);
  };
  const decideApproval = (a: Approval, d: "allow" | "deny") => void guard(async () => { await api.decide(a.id, d); });
  const sendPoke = () => void guard(async () => {
    if (!run?.sessionId || !poke.trim()) return;
    await api.send(run.sessionId, poke.trim());
    setPoke(""); setPokeOpen(false);
  });
  const stopRun = () => {
    if (!run || !window.confirm("停止这次执行？")) return;
    void guard(async () => { await api.stop(run.id); });
  };
  const tlLine = (e: ThreadEvent) => <>
    {e.type === "message" && <>{ROLE_LABEL[e.role] ?? e.role}：{e.text.slice(0, 200)}</>}
    {e.type === "run" && (e.phase === "start"
      ? <>开始执行{e.status === "queued" ? "（排队中）" : ""}</>
      : <>执行{RUN_LABEL[e.status] ?? e.status}{e.startedAt ? ` · 耗时 ${gap(e.startedAt, e.at)}` : ""}{e.error ? ` · ${e.error.slice(0, 120)}` : ""}</>)}
    {e.type === "reminder" && <>{e.title}{e.acked ? "（已处理）" : ""}</>}
    {e.type === "digest" && <>{e.kind === "failure" ? "失败上下文" : "验收摘要"}：{e.text.slice(0, 200) || "（无内容）"}</>}
  </>;
  /** 「换台电脑派」的电脑下拉：stuck / queued 两个形态共用 */
  const machinePicker = (onGo: (m: string) => void) => pickOpen && (
    <div className="status-inline">
      <select aria-label="换台电脑" value={pickedMachine} disabled={busy} onChange={e => setPickedMachine(e.target.value)}>
        <option value="">选一台电脑</option>
        {options.map(c => <option key={c.name} value={c.name}>{c.name}{c.online ? "" : "（离线）"}</option>)}
      </select>
      <button className="primary" disabled={busy || !pickedMachine} onClick={() => onGo(pickedMachine)}>确认派发</button>
      <button className="ghost" onClick={() => setPickOpen(false)}>取消</button>
    </div>
  );

  const statusCard = <section className={`status-card tone-${tone}`}>
    {form === "review" && <>
      <div className="status-head"><h3>等你验收</h3><span className="dim">{ago(deliveredAt, Date.now())}交付</span></div>
      {lastReply && <div className="status-reply">
        <span className="dim">它说做了什么</span>
        <div className={`reply-clip ${replyOpen ? "open" : ""}`}><Markdown text={lastReply} /></div>
        {replyLong && <button className="link" onClick={() => setReplyOpen(v => !v)}>{replyOpen ? "收起" : "展开全文"}</button>}
      </div>}
      {evidenceGroups.length > 0 && <div className="evidence">
        <div className="evidence-chips">{evidenceGroups.map(g => <button key={g.k} type="button" className={`pg-chip ev-chip ${evidenceOpen === g.k ? "on" : ""}`} aria-expanded={evidenceOpen === g.k} onClick={() => setEvidenceOpen(evidenceOpen === g.k ? null : g.k)}>{g.label} {g.list.length}</button>)}</div>
        {evidenceGroups.filter(g => g.k === evidenceOpen).map(g => <ul key={g.k}>{g.list.map((e, i) => <li key={i}><code>{e.value}</code></li>)}</ul>)}
      </div>}
      <ul className="review-list">
        {reviewItems.map(it => (
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
      <div className="action-bar status-actions">
        <button className="primary" disabled={busy || unjudged > 0} title={unjudged > 0 ? "检查项全部通过后才能验收" : ""}
          onClick={() => void guard(async () => onSaved((await api.acceptTask(task.id)).task))}>验收通过</button>
        {digest?.review?.sessionId && <button disabled={busy} onClick={() => onSession(digest.review!.sessionId!)}>打开会话</button>}
        {unjudged > 0 && <span className="dim status-note">还差 {unjudged} 项未判</span>}
      </div>
      {(review?.standards.length ?? 0) > 0 && <details className="review-standards">
        <summary className="dim">打回沉淀的标准（最近 5 条，交付前先自查）</summary>
        <ul>{review!.standards.map((s, i) => <li key={i}>{s}</li>)}</ul>
      </details>}
    </>}

    {form === "approval" && <>
      <div className="status-head"><h3>{approvals.every(a => a.decisionTier === "gray") ? "它想做一件边界外的事" : "等你授权"}</h3></div>
      {approvals.map(a => {
        const isQuestion = a.tool === "userInput" && !!parseQuestions(a.detail);
        return <div key={a.id} className="approval-block">
          <p><code>{a.tool}</code> {isQuestion ? "它在问你问题" : a.detail.slice(0, 300)}{!isQuestion && a.detail.length > 300 ? "…" : ""}</p>
          <p className="dim">{[APPROVAL_TIER_LABEL[a.decisionTier], a.decisionReason].filter(Boolean).join(" · ")}</p>
          <div className="action-bar status-actions">
            {isQuestion
              ? <button className="primary" onClick={() => onSession(a.sessionId)}>去回答</button>
              : <>
                <button className="primary" disabled={busy} onClick={() => decideApproval(a, "allow")}>允许这一次</button>
                <button disabled={busy} onClick={() => decideApproval(a, "deny")}>拒绝</button>
                <button className="ghost" onClick={() => onSession(a.sessionId)}>打开会话</button>
              </>}
          </div>
        </div>;
      })}
    </>}

    {form === "running" && run && <>
      <div className="status-head"><h3>正在做 · {elapsed(run.startedAt)}</h3>{boardEntry?.lastActivityAt && <span className="dim">最后活动 {ago(boardEntry.lastActivityAt, Date.now())}</span>}</div>
      {timeline !== null && timeline.length > 0 && <ul className="timeline">
        {timeline.slice(0, 3).map((e, i) => <li key={i} className={`tl-item tl-${e.type}`}><span className="tl-time">{new Date(e.at).toLocaleString()}</span><span className="tl-body">{tlLine(e)}</span></li>)}
      </ul>}
      {items.length > 0 && <p className="dim">检查项 {checkDone}/{items.length}</p>}
      <div className="action-bar status-actions">
        {run.sessionId && <button className="primary" onClick={() => onSession(run.sessionId!)}>打开会话</button>}
        {run.sessionId && <button disabled={busy} aria-expanded={pokeOpen} onClick={() => setPokeOpen(v => !v)}>插一句话</button>}
        <button className="danger" disabled={busy} onClick={stopRun}>停止</button>
      </div>
      {pokeOpen && <div className="status-inline">
        <textarea value={poke} rows={2} maxLength={4000} placeholder="往这次会话里插一句话" onChange={e => setPoke(e.target.value)} />
        <button className="primary" disabled={busy || !poke.trim()} onClick={sendPoke}>发送</button>
      </div>}
    </>}

    {form === "stuck" && <>
      <div className="status-head"><h3>没人在跑了</h3></div>
      <p className="status-gray">{[
        boardEntry?.machine && !boardEntry.machineOnline ? `${boardEntry.machine} 离线` : "",
        boardEntry?.lastActivityAt ? `最后活动 ${ago(boardEntry.lastActivityAt, Date.now())}` : "",
        digest?.failure ? `上次失败：${digest.failure.error || "（执行器未返回错误信息）"}` : "",
      ].filter(Boolean).join(" · ") || "进行中，但没有任何在跑的执行"}</p>
      <div className="action-bar status-actions">
        <button className="primary" disabled={busy} onClick={() => void guard(() => runStart({}))}>重新派发</button>
        <button disabled={busy} onClick={() => setPickOpen(v => !v)}>换台电脑派</button>
        <button disabled={busy} onClick={() => patch({ status: "todo" })}>退回待办</button>
      </div>
      {machinePicker(m => void guard(() => runStart({ machine: m })))}
    </>}

    {form === "queued" && <>
      <div className="status-head"><h3>排队中 · 等 {queueMachine || "电脑"} 上线</h3>{(task.queuedAt ?? boardEntry?.queuedAt) && <span className="dim">{new Date((task.queuedAt ?? boardEntry?.queuedAt)!).toLocaleString()} 入队</span>}</div>
      <div className="action-bar status-actions">
        <button disabled={busy} onClick={() => void guard(async () => onSaved(await api.unqueueTask(task.id)))}>取消排队</button>
        <button disabled={busy} onClick={() => setPickOpen(v => !v)}>换台电脑派</button>
      </div>
      {machinePicker(m => void guard(async () => { onSaved(await api.unqueueTask(task.id)); await runStart({ machine: m }); }))}
    </>}

    {form === "todo" && <>
      <div className="status-head"><h3>还没派出去</h3></div>
      <div className="who-line">
        <span className="who-label">谁来做</span>
        <span className="who-sum">{configSummary}</span>
        <button className="link" disabled={busy} onClick={() => setConfigOpen(true)}>改</button>
      </div>
      {task.sessionIds.length > 0 && <div className="delivery-pick">
        <span className="delivery-label">从哪开始</span>
        <div className="delivery-opts" role="radiogroup" aria-label="从哪开始">
          <button type="button" role="radio" aria-checked={!fresh} className={!fresh ? "delivery-opt on" : "delivery-opt"} onClick={() => setFresh(false)}>接着上次的会话</button>
          <button type="button" role="radio" aria-checked={fresh} className={fresh ? "delivery-opt on" : "delivery-opt"} onClick={() => setFresh(true)}>从零开始</button>
        </div>
      </div>}
      {reason && <p className="who-warn" role="alert">{reason}</p>}
      {!reason && offline && <p className="dim">{machine} 离线，派发后会在它上线时自动开始</p>}
      <div className="action-bar status-actions">
        <button className="primary" disabled={busy || !!reason} onClick={() => void guard(() => runStart({ machine, ...deliveryInput }))}>{offline ? "排队等上线" : "派发"}</button>
        <button disabled={busy || !!reason} onClick={() => { setMessage(notesForAgent(task.notes, attachments ?? []) || task.title); setStarting(true); }}>补一句话再派…</button>
      </div>
      {starting && <form className="selection-panel" onSubmit={e => { e.preventDefault(); void guard(() => runStart({ text: message, machine, ...deliveryInput })); }}>
        <label>{task.sessionIds.length ? "这次要做什么" : "第一条消息"}<textarea value={message} maxLength={8000} onChange={e => setMessage(e.target.value)} /></label>
        <div className="action-bar"><button className="primary" disabled={busy || !!reason || !message.trim()}>{offline ? "排队，等上线后开始" : "确认开始"}</button><button type="button" onClick={() => setStarting(false)}>取消</button></div>
      </form>}
    </>}

    {form === "plain" && <>
      <div className="status-head"><h3>普通待办</h3></div>
      <p className="dim">{listenOnly && reason ? reason : "普通待办，不派给 agent"}</p>
      <div className="action-bar status-actions">
        {task.timerStartedAt
          ? <><button disabled={busy} onClick={() => void guard(async () => onSaved(await api.stopTimer(task.id)))}>结束计时</button><span className="dim">已计时 {elapsed(task.timerStartedAt)}</span></>
          : <button disabled={busy} onClick={() => void guard(async () => onSaved(await api.startTimer(task.id)))}><Icon name="timer" />开始计时</button>}
        <button disabled={busy} onClick={() => setConfigOpen(true)}>设执行人</button>
      </div>
    </>}

    {form === "done" && <>
      <div className="status-head"><h3>已完成 · {fmt(task.doneAt)}</h3>{reviewItems.length > 0 && <span className="dim">检查项 {passed}/{reviewItems.length} 通过</span>}</div>
      <div className="action-bar status-actions">
        <button disabled={busy} onClick={() => patch({ status: "todo" })}>标记为未完成</button>
      </div>
    </>}
  </section>;

  const [cfgA, cfgB] = [cfgParts.slice(0, 2).join(" · "), cfgParts.slice(2).join(" · ")];
  const lastSession = task.sessionIds[task.sessionIds.length - 1];

  return <div className="app">
    <header className="task-header">
      <div className="task-head-row">
        <button className="back-button" onClick={onBack}><Icon name="back" />返回</button>
        <div className="detail-head">
          <button className={`complete-toggle ${done ? "done" : ""}`} aria-pressed={done} title={done ? "标记为未完成" : "标记为完成"} aria-label={done ? "标记为未完成" : "标记为完成"} disabled={busy} onClick={() => patch({ status: done ? "todo" : "done" })}><Icon name="check" /></button>
          <InlineField className="title-field" value={task.title} ariaLabel="任务标题" placeholder="任务标题" maxLength={200} disabled={busy} onSave={title => patch({ title })} />
        </div>
        <span className={`task-status ${task.status}`}>{TASK_LABEL[task.status]}</span>
        {saved && <span className="save-flash" role="status">已保存</span>}
        <span className="spacer" />
        <div className="head-menu">
          <button className="icon-button" aria-label="更多操作" title="更多操作" disabled={busy} onClick={() => setMenuOpen(v => !v)}>···</button>
          {menuOpen && <>
            <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
            <div className="menu-pop" role="menu">
              <button className="danger" disabled={busy} onClick={() => { setMenuOpen(false); if (confirm("删除这个任务？关联会话会保留。")) void guard(async () => { await api.deleteTask(task.id); onDeleted(); }); }}>删除任务</button>
              <span className="dim">{goalTitle ? `属于「${goalTitle}」` : "未归属目标"}</span>
            </div>
          </>}
        </div>
      </div>
      <div className="task-head-row task-sum-row">
        <span className="dim" title={configSummary}>{configSummary}</span>
        {lastSession && <button className="link" onClick={() => onSession(lastSession)}>· 来自会话</button>}
      </div>
    </header>

    {err && <p className="form-error task-err" role="alert">{err}</p>}

    <div className="task-layout">
      <main className="task-main">
        {dispatchNote && <p className="hint" role="status">{dispatchNote}</p>}
        {statusCard}

        <section className="detail-section">
          <h3>说明</h3>
          <TaskNotes notes={task.notes} attachments={attachments} disabled={busy} onEditingChange={setNotesEditing} onSave={saveNotes} upload={uploadAttachment} onOpen={openAttachment} onImage={setPreview} />
          <Checklist items={items} disabled={busy} onChange={checklist => patch({ checklist })} />
          <h3>
            附件
            {attachments?.length ? <span className="dim"> · {attachments.length}</span> : null}
            <button className="link" disabled={busy} onClick={() => attachPicker.current?.click()}>上传</button>
            <input ref={attachPicker} type="file" multiple hidden onChange={e => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (files.length) pickAttachments(files);
            }} />
          </h3>
          {!attachments
            ? <p className="dim">正在读取附件…</p>
            : attachments.length === 0
            ? <p className="dim">还没有附件，可以在说明里粘贴截图或点上传</p>
            : <ul className="attachment-list">
              {attachments.map(a => (
                <li key={a.id} className={`attachment-item ${a.kind}`}>
                  {a.kind === "image" && a.url
                    ? <img className="attachment-thumb" src={a.url} alt={a.name} onClick={() => setPreview(a.url!)} />
                    : <span className="attachment-kind">{a.kind === "image" ? "图" : fileKind(a.name, a.mime)}</span>}
                  <span className="attachment-meta">
                    <strong>{a.name}</strong>
                    <span className="dim">{a.kind === "image" ? "图片" : "文件"} · {formatSize(a.size)}</span>
                  </span>
                  <span className="attachment-actions">
                    <button className="link" disabled={busy || notesEditing} title={notesEditing ? "先把备注保存或取消，再插入引用" : undefined} onClick={() => attachToNotes(a)}>插入备注</button>
                    <button className="link" disabled={busy} onClick={() => openAttachment(a.id)}>下载</button>
                    <button className="link danger" disabled={busy} onClick={() => removeAttachment(a)}>删除</button>
                  </span>
                </li>
              ))}
            </ul>}
        </section>

        <details className="task-fold">
          <summary>任务产物{artifact && <span className="dim"> · {artifact.edited ? "人改过" : artifact.source === "agent" ? "执行端交付" : "自动生成"} · {new Date(artifact.updatedAt).toLocaleString()}</span>}</summary>
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
              <div className="artifact-md"><Markdown text={artifact.md} /></div>
              <div className="action-bar">
                <button disabled={busy} onClick={() => { setArtifactDraft(artifact.md); setEditingArtifact(true); }}><Icon name="edit" />编辑</button>
                <button disabled={busy} onClick={rebuildArtifact}>按最新会话重建</button>
                <button disabled={busy} title={`导出文件名 ${artifactName || `docs/tasks/${task.id}-task.md`}`} onClick={downloadArtifact}>导出 .md</button>
                <button className="link" disabled={busy} onClick={removeArtifact}>删除</button>
              </div>
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
        </details>

        {task.status !== "review" && reviewItems.length > 0 && (
          <details className="task-fold">
            <summary>验收记录<span className="dim"> · {passed}/{reviewItems.length} 通过</span></summary>
            <ul className="review-list">
              {reviewItems.map(it => (
                <li key={it.id} className={`review-item ${it.status}`}>
                  <div className="review-row"><span className={`review-dot ${it.status}`} aria-hidden /><span className="review-title">{it.title}</span></div>
                  {it.note && <p className="review-note-text">{it.note}</p>}
                </li>
              ))}
            </ul>
          </details>
        )}

        <details className="task-fold" open={form === "running" || form === "stuck"}>
          <summary>过程</summary>
          {digest?.failure && form !== "stuck" && (
            <div className="digest-card bad">
              <strong>最近一次失败（{new Date(digest.failure.builtAt).toLocaleString()}）</strong>
              <p>{digest.failure.error || "（执行器未返回错误信息）"}</p>
              {digest.failure.tail.length > 0 && (
                <p className="dim">{digest.failure.tail.map(m => `[${m.role}] ${m.text}`).join(" ⏎ ")}</p>
              )}
            </div>
          )}
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
                    <span className="tl-body">{tlLine(e)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="detail-section">
            <h3>关联会话（{task.sessionIds.length}）</h3>
            {task.sessionIds.length > 0
              ? <ul className="list">{task.sessionIds.map(id => {
                const s = sessions.find(s => s.id === id) ?? extra[id] ?? undefined;
                const looked = id in extra; // 补查过：为 null 说明记录真没了
                return <li className="linked-row" key={id}>
                  <button className="entity-row" disabled={!s} onClick={() => onSession(id)}>
                    <span className="entity-main">
                      <strong>{s ? `${AGENT_LABEL[s.agent] ?? s.agent} · ${s.project || "未知项目"}` : looked ? "会话记录已删除" : "读取中…"}</strong>
                      <span className="dim">{s ? `${s.title} · ${STATE_LABEL[s.state] ?? s.state} · ${new Date(s.updatedAt).toLocaleString()}` : id}</span>
                    </span>
                  </button>
                  <button className="icon-ghost" aria-label="取消挂接" title="取消挂接" disabled={busy} onClick={() => void guard(async () => onSaved(await api.unlinkSession(task.id, id)))}><Icon name="close" /></button>
                </li>;
              })}</ul>
              : <p className="dim">还没有关联会话。开始执行后会自动挂接。</p>}
            <button className="link" disabled={busy} onClick={() => setLinking(!linking)}>关联已有会话</button>
            {linking && <div className="selection-panel"><p>选择会话（最近 30 条）</p>{sessions.filter(s => !task.sessionIds.includes(s.id)).slice(0, 30).map(s => <button className="entity-row" key={s.id} disabled={busy} onClick={() => void guard(async () => { onSaved(await api.linkSession(task.id, s.id)); setLinking(false); })}><span>{AGENT_LABEL[s.agent] ?? s.agent} · {s.project} · {s.title}</span></button>)}</div>}
          </section>
          {!hasProcess && <p className="dim">还没有过程记录。开始执行后，这里会出现时间线、关联会话和预摘要。</p>}
        </details>
      </main>

      <aside className="task-side" aria-label="任务属性">
        <div className="prop"><span className="prop-label">状态</span>
          <select className="inline-control" aria-label="任务状态" value={task.status} disabled={busy} onChange={e => patch({ status: e.target.value as Task["status"] })}>{STATUSES.map(s => <option key={s} value={s}>{TASK_LABEL[s]}</option>)}</select>
        </div>
        <div className="prop"><span className="prop-label">执行人</span>
          <span className="prop-value">{cfgA}</span>
          <span className="prop-value dim">{cfgB}</span>
          <button className="link prop-edit" disabled={busy} onClick={() => setConfigOpen(true)}>编辑</button>
        </div>
        <div className="prop"><span className="prop-label">所属目标</span>
          <select className="inline-control" aria-label="所属目标" value={task.goalId ?? ""} disabled={busy} onChange={e => patch({ goalId: e.target.value ? Number(e.target.value) : null })}><option value="">无目标</option>{goals.map(g => <option key={g.id} value={g.id}>{g.title}</option>)}</select>
        </div>
        <div className="prop"><span className="prop-label">优先级</span>
          <PrioritySelect value={task.priority ?? "medium"} onChange={priority => patch({ priority })} />
        </div>
        <div className="prop"><span className="prop-label">执行边界</span>
          {task.mandateFrozenAt
            ? <div className="bound-chips">
              {(constraintsSummary(task.constraints).length > 0 ? constraintsSummary(task.constraints) : ["不限目录 · 不联网 · 不推远端 · 不跑脚本"]).map(c => <span key={c} className="bound-chip">{c}</span>)}
              <span className="dim">· 已冻结</span>
            </div>
            : <>
              <BoundsEditor value={task.constraints ?? NO_CONSTRAINTS} disabled={busy} onChange={constraints => patch({ constraints })} />
              <span className="dim">第一次派发时冻结</span>
            </>}
        </div>
        <details className="prop task-fold">
          <summary>时间 · 提醒 · 计时</summary>
          <div className="prop"><span className="prop-label">开始时间</span>
            <input className="inline-control" type="datetime-local" aria-label="开始时间" value={localDateTime(task.startAt)} max={localDateTime(task.dueAt) || undefined} disabled={busy} onChange={e => patch({ startAt: toIso(e.target.value) })} />
            <label className="check"><input type="checkbox" checked={task.remindStart} disabled={busy || !task.startAt} onChange={e => patch({ remindStart: e.target.checked })} />开始时提醒</label>
          </div>
          <div className="prop"><span className="prop-label">截止时间</span>
            <input className={`inline-control ${task.dueAt && !done && Date.parse(task.dueAt) < now ? "overdue" : ""}`} type="datetime-local" aria-label="截止时间" value={localDateTime(task.dueAt)} min={localDateTime(task.startAt) || undefined} disabled={busy} onChange={e => patch({ dueAt: toIso(e.target.value) })} />
            <label className="check"><input type="checkbox" checked={task.remindDue} disabled={busy || !task.dueAt} onChange={e => patch({ remindDue: e.target.checked })} />截止时提醒</label>
          </div>
          {task.doneAt && <div className="prop"><span className="prop-label">完成时间</span><span className="prop-value">{fmt(task.doneAt)}</span></div>}
          <div className="prop"><span className="prop-label">计时</span>
            {task.timerStartedAt
              ? <><button disabled={busy} onClick={() => void guard(async () => onSaved(await api.stopTimer(task.id)))}>结束计时</button><span className="dim">已计时 {elapsed(task.timerStartedAt)}</span></>
              : <button disabled={busy || done} onClick={() => void guard(async () => onSaved(await api.startTimer(task.id)))}><Icon name="timer" />开始计时</button>}
          </div>
        </details>
      </aside>
    </div>

    {configOpen && (
      <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setConfigOpen(false); }}>
        <div className="modal-panel" role="dialog" aria-modal="true" aria-label="执行配置">
          <div className="modal-head">
            <h3>执行配置</h3>
            <button className="icon-button" aria-label="关闭" onClick={() => setConfigOpen(false)}><Icon name="close" /></button>
          </div>
          <div className="form-grid">
            <label>角色<select value={task.roleId ?? ""} disabled={busy} onChange={e => {
              const id = e.target.value ? Number(e.target.value) : null;
              const r = roles.find(x => x.id === id);
              // 角色绑着执行工具：选它的同时把任务上的工具对齐，免得两个字段互相打架
              patch({ roleId: id, ...(r?.agent ? { agent: r.agent } : {}) });
            }}><option value="">未指定</option>{roles.map(r => <option key={r.id} value={r.id}>{r.name}{r.model ? ` · ${r.model}` : ""}</option>)}</select></label>
            <label>项目<select value={task.projectId ?? ""} disabled={busy} onChange={e => patch({ projectId: e.target.value ? Number(e.target.value) : null, cwd: null })}><option value="">未指定</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label>项目配置
              <select
                value={chosenDir ? dirKey(chosenDir) : cwdOffList ? "custom" : ""}
                disabled={busy || !currentProject}
                aria-label="项目配置"
                onChange={e => {
                  const v = e.target.value;
                  if (v === "custom") return; // 老数据的目录不在登记里：保持原样，选了别的会被覆盖
                  if (!v) return void patch({ cwd: null });
                  const d = dirs.find(x => dirKey(x) === v);
                  // 选一条配置 = 同时定下目录和它绑的电脑（不绑电脑的只定目录）
                  if (d) patch({ cwd: d.cwd, ...(d.machine ? { machine: d.machine } : {}) });
                }}>
                <option value="">{!currentProject ? "先选项目"
                  : dirs.length ? (projectUsable ? "不选（开始执行时按电脑自动挑）" : `登记的配置都装不了 ${agentName(tool ?? "")}，项目暂不可用`)
                  : "这个项目还没登记配置"}</option>
                {dirs.map(d => <option key={dirKey(d)} value={dirKey(d)} disabled={!fitsTool(d)}>{`${d.machine ?? "任意电脑"} · ${d.cwd}${fitsTool(d) ? "" : `（没装 ${agentName(tool ?? "")}）`}`}</option>)}
                {cwdOffList && <option value="custom">{task.cwd}（不在登记里）</option>}
              </select>
            </label>
            <label>执行工具
              {currentRole?.agent
                ? <input value={`${AGENT_LABEL[currentRole.agent] ?? currentRole.agent}（由角色决定）`} readOnly disabled aria-label="执行工具" />
                : <select value={task.agent ?? ""} disabled={busy} onChange={e => patch({ agent: (e.target.value || null) as Task["agent"] })}><option value="">无（普通待办）</option>{task.agent && !isDispatchable(task.agent) && <option value={task.agent}>{AGENT_LABEL[task.agent] ?? task.agent}（只做监听，不能派活）</option>}{AGENT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>}
            </label>
            <label>电脑<select value={task.machine ?? ""} disabled={busy} onChange={e => {
              const m = e.target.value || null;
              // 当前目录来自某条绑了电脑的配置，而这次换到了别的电脑：目录跟着失效，交回服务端按新电脑挑
              const mismatch = chosenDir?.machine && chosenDir.machine !== m;
              patch({ machine: m, ...(mismatch ? { cwd: null } : {}) });
            }}><option value="">开始时自动选择</option>{options.map(c => <option key={c.name} value={c.name}>{c.name}{c.online ? "" : "（离线）"}{tool && c.agents.length > 0 && !c.agents.includes(tool) ? `（没装 ${agentName(tool)}）` : tool && c.agents.length === 0 ? "（未上报工具）" : ""}</option>)}</select></label>
          </div>
          {currentRole?.agent && <p className="hint">执行工具由角色「{currentRole.name}」决定，要换工具去角色页改它；角色不绑电脑，在哪台干活由这个任务挑。</p>}
          {currentProject && dirs.length > 0 && !projectUsable && <p className="form-error" role="alert">项目「{currentProject.name}」登记的配置所在电脑都装不了 {agentName(tool ?? "")}：这个项目当前不可用。换个角色 / 工具，或在对应电脑上装好再选。</p>}
          {machineLacks && <p className="form-error" role="alert">{machine} 没装 {agentName(tool ?? "")}：换一台装了它的电脑，或者给这个角色换工具。</p>}
          {!currentProject && <p className="hint">还没选项目：先选一个项目，再从它的配置里挑电脑 + 目录（配置在「设置 → 项目」里登记）。</p>}
          <div className="action-bar"><button className="primary" onClick={() => setConfigOpen(false)}>完成</button></div>
        </div>
      </div>
    )}

    {/* 附件图片预览：和会话里的图片同一个浮层 */}
    {preview && (
      <div className="lightbox" role="dialog" aria-modal="true" aria-label="图片预览" onClick={() => setPreview(null)}>
        <img src={preview} alt="图片预览" />
      </div>
    )}
  </div>;
}
