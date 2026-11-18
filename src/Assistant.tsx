import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Api,
  AssistantAgent,
  AssistantDraft,
  AssistantDraftFields,
  AssistantState,
  Machine,
  Project,
  Role,
} from "./lib/api";
import { AGENT_LABEL } from "./lib/agents";
import RoleFields, { BLANK_ROLE, formToInput, roleReady, type RoleForm } from "./RoleFields";
import Markdown from "./Markdown";

// 角色助手：一句话描述「要一个什么样的人」，由电脑端的 agent 出草稿，
// 用户在草稿卡上改完再点创建。agent 只出 JSON，落库始终走 POST /roles，
// 所以重名、上限、字段长度这些校验和手填表单完全一致。
//
// 草稿卡用的是和「新建角色」同一套 RoleFields：字段、下拉项、必填规则都一样，
// 不会出现「助手建的少了某一项」。执行工具 / 模型 / 电脑这些事仍然按角色的规矩来：
// 工具必填、模型可留空，电脑不绑角色——所以这里也不让人挑电脑，由服务端建议 + 在线情况自动定。

const ASSISTANTS: AssistantAgent[] = ["claude", "codex", "zcode"];
const EXAMPLES = [
  "要一个负责前端实现的角色，用 Codex，改完必须跑 tsc",
  "来个代码评审，只看 diff，不改文件",
  "服务端接口和迁移交给它，用 Claude，模型 sonnet",
];

const toForm = (d: AssistantDraftFields | null): RoleForm => ({
  ...BLANK_ROLE,
  name: d?.name ?? "",
  title: d?.title ?? "",
  agent: d?.agent ?? BLANK_ROLE.agent,
  model: d?.model ?? "",
  context: d?.context ?? "",
  tools: (d?.tools ?? []).join("、"),
  manager: d?.manager ?? false,
  managerProjects: d?.managerProjects ?? [],
});

const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
};

/** 草稿卡：字段可改，创建后才真正落库；已创建 / 已丢弃的只留一行结论 */
function DraftCard({
  api,
  draft,
  projects,
  busy,
  onBusy,
  onCreated,
  onError,
}: {
  api: Api;
  draft: AssistantDraft;
  projects: Project[];
  busy: boolean;
  onBusy(v: boolean): void;
  /** 创建成功后回传新角色：外层拿着它跳进角色详情页 */
  onCreated(r: Role): void;
  onError(msg: string): void;
}) {
  const [form, setForm] = useState<RoleForm>(() => toForm(draft.draft));
  const [handled, setHandled] = useState<null | "created" | "discarded">(null);
  const set = (patch: Partial<RoleForm>) => setForm(f => ({ ...f, ...patch }));
  // 别处（另一台设备 / 刷新）处理过的草稿也按结果渲染，本地点过的优先
  const done = handled ?? draft.status;

  const act = async (fn: () => Promise<unknown>) => {
    onBusy(true); onError("");
    try { await fn(); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { onBusy(false); }
  };

  if (done === "created") {
    return <p className="assistant-verdict">已创建角色「{form.name}」，正在打开它的详情页。</p>;
  }
  if (done === "discarded") return <p className="assistant-verdict dim">这张草稿不用了。</p>;

  // 解析失败：只留原文，让人知道 agent 说了什么，再让它重说
  if (!draft.draft) {
    return (
      <div className="draft-card">
        <div className="draft-head"><strong>没解析出草稿</strong><span className="dim">agent 没按 JSON 回</span></div>
        <pre className="draft-raw">{draft.raw.slice(0, 600)}</pre>
        <div className="btns">
          <button className="ghost" disabled={busy}
            onClick={() => void act(() => api.replyAssistant("上一条没有按格式回。请只回那个 JSON 对象，不要解释。"))}>
            让它重说一遍
          </button>
          <button className="ghost" disabled={busy}
            onClick={() => void act(async () => { await api.discardDraft(draft.id); setHandled("discarded"); })}>不用了</button>
        </div>
      </div>
    );
  }

  return (
    <div className="draft-card">
      <div className="draft-head">
        <strong>{form.name.trim() || "未命名角色"}</strong>
        {form.agent && <span className={`tag ${form.agent}`}>{AGENT_LABEL[form.agent] ?? form.agent}</span>}
        <span className="dim">草稿 · 确认后才创建</span>
      </div>
      {draft.draft.note && <p className="hint draft-note">{draft.draft.note}</p>}
      <RoleFields form={form} projects={projects} busy={busy} onChange={set} />
      <div className="btns">
        <button className="primary" disabled={busy || !roleReady(form)}
          onClick={() => void act(async () => {
            const r = await api.confirmDraft(draft.id, formToInput(form));
            setHandled("created");
            onCreated(r.role);
          })}>
          创建角色
        </button>
        <button className="ghost" disabled={busy}
          onClick={() => void act(async () => { await api.discardDraft(draft.id); setHandled("discarded"); })}>不用了</button>
        {!roleReady(form) && <span className="dim">角色名和执行工具必填</span>}
      </div>
    </div>
  );
}

export default function Assistant({
  api,
  onCreated,
  onClose,
}: {
  api: Api;
  /** 草稿卡确认后回传新角色：列表页刷新并跳进它的详情页 */
  onCreated(r: Role): void;
  onClose(): void;
}) {
  const [state, setState] = useState<AssistantState | null>(null);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [text, setText] = useState("");
  const [agent, setAgent] = useState<AssistantAgent>("claude");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const inited = useRef(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  // 工作目录不做成选项：建角色跟目录无关，CLI 进程统一在电脑端的
  // <文档>/AgentHub 里启动（那个目录由电脑端自动创建，不碰用户的项目文件）
  const load = useCallback(async () => {
    try {
      const s = await api.assistant();
      setState(s);
      // 首次拿到建议值就填进设置区，之后不再覆盖用户改过的内容
      if (!inited.current) {
        inited.current = true;
        setAgent(s.suggestion.agent);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);
  // 草稿卡上的「项目经理」要列项目
  useEffect(() => { api.projects().then(setProjects, () => setProjects([])); }, [api]);

  // 每台电脑装了哪些工具：执行器连上来时报给服务端。挑了起草工具就只在装了它的电脑里挑，
  // 免得挑一台根本跑不起来的。电脑不再让人选——角色不绑电脑，这里只是找台能跑的工具宿主。
  const loadMachines = useCallback(() => {
    api.machines().then(setMachines, () => setMachines([]));
  }, [api]);
  useEffect(() => { loadMachines(); }, [loadMachines]);
  /** 这台电脑能不能跑这个工具；没上报过（老电脑端）当「不知道」，照留 */
  const canRun = (m: { agents: string[] }, a: string) => m.agents.length === 0 || m.agents.includes(a);
  const candidates = useMemo(() => {
    const list = machines.length
      ? machines.filter(m => m.online && canRun(m, agent)).map(m => ({ name: m.name, at: m.at }))
      : (state?.online ?? []).map(name => ({ name, at: null }));
    // 最近活跃的排前面：多台都能跑时优先用你刚用过的那台
    return [...list].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  }, [machines, agent, state?.online]);
  // 服务端给的建议（上次那台）优先；它不在候选里就退到最近活跃的那台
  const target = candidates.some(c => c.name === state?.suggestion.machine)
    ? state!.suggestion.machine
    : candidates[0]?.name ?? "";

  // 等 agent 回话时轮询：这条通道是电脑端跑 CLI，没有流式，只能按 run 状态收尾
  const pending = !!state?.pending;
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => { void load(); }, 2500);
    return () => window.clearInterval(timer);
  }, [pending, load]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [state?.messages.length, state?.drafts.length, pending]);

  const thread = state?.thread ?? null;

  const send = async (line: string) => {
    const body = line.trim();
    if (!body || busy || pending) return;
    setBusy(true); setErr("");
    try {
      if (!thread) {
        if (!target) throw new Error(`没有在线电脑能跑 ${AGENT_LABEL[agent]}：先在装了它的那台电脑上打开 AgentHub`);
        await api.startAssistant({ agent, machine: target, cwd: "", text: body });
      } else {
        await api.replyAssistant(body);
      }
      setText("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true); setErr("");
    try { await api.resetAssistant(); inited.current = false; await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const drafts = state?.drafts ?? [];
  const draftOf = (messageId: number) => drafts.find(d => d.messageId === messageId);

  return (
    <section className="box assistant">
      <div className="assistant-head">
        <h2>让助手建角色</h2>
        <div className="assistant-actions">
          {thread && <button className="ghost" disabled={busy} onClick={() => void reset()}>重新开始</button>}
          <button className="ghost" onClick={onClose}>收起</button>
        </div>
      </div>
      <p className="hint">
        用一句话说清要什么人，电脑端的 agent 会整理成一份草稿（名字、职责、执行工具、模型、准则、项目经理）；草稿的字段和「＋ 新建角色」完全一样，点「创建角色」才真正写进角色列表，并直接打开这个角色的详情页。
        这条通道借的是派活：电脑得开着 AgentHub，一次大概十几秒，进程在那个电脑的「文档/AgentHub」里启动，不读写你的项目文件
        {state?.roles ? `；现有 ${state.roles} 个角色，助手会避开重名` : ""}。
      </p>

      {err && <p className="form-error" role="alert">{err}</p>}
      {state?.runError && <p className="form-error" role="alert">上一轮失败：{state.runError}</p>}

      {!thread && (
        <div className="assistant-setup">
          <div className="assistant-run">
            <label>用哪个工具起草
              <select value={agent} disabled={busy} onChange={e => setAgent(e.target.value as AssistantAgent)}>
                {ASSISTANTS.map(key => <option key={key} value={key}>{AGENT_LABEL[key]}</option>)}
              </select>
            </label>
            <span className="dim">
              {target
                ? `会在 ${target} 上跑（自动挑最近活跃的电脑，不用选）`
                : machines.length
                  ? `没有在线电脑装了 ${AGENT_LABEL[agent] ?? agent}`
                  : "还没有电脑连上来"}
            </span>
          </div>
          {machines.length > 0 && candidates.length === 0 && (
            <p className="hint">在装了这个工具的那台电脑上打开 AgentHub，再回来看这里。</p>
          )}
          <div className="assistant-examples">
            {EXAMPLES.map(e => <button key={e} className="chip" disabled={busy} onClick={() => void send(e)}>{e}</button>)}
          </div>
        </div>
      )}

      {!!(state?.messages.length) && (
        <div className="assistant-msgs">
          {state?.messages.map(m => {
            const draft = draftOf(m.id);
            return (
              <div key={m.id} className={`assistant-msg ${m.role === "user" ? "me" : ""}`}>
                {/* 两边都按 markdown 排版：表格、代码、列表都常见 */}
                <div className="assistant-bubble"><Markdown text={m.text} /></div>
                <span className="dim assistant-time">{m.role === "user" ? "你" : AGENT_LABEL[thread?.agent ?? ""] ?? "助手"} · {clock(m.createdAt)}</span>
                {draft && (
                  <DraftCard api={api} draft={draft} projects={projects} busy={busy}
                    onBusy={setBusy} onCreated={onCreated} onError={setErr} />
                )}
              </div>
            );
          })}
          {pending && <p className="hint assistant-waiting">{AGENT_LABEL[thread?.agent ?? ""] ?? "助手"} 在想…（十几秒，别关电脑）</p>}
          <div ref={endRef} />
        </div>
      )}

      <div className="assistant-composer">
        <textarea value={text} rows={2} maxLength={4000} disabled={busy}
          placeholder={pending ? "助手还在回上一条，可以先写下一句…" : thread ? "继续说，例如：名字改成 前端实现，模型 sonnet" : "描述你要的角色，例如：要一个负责前端实现的人，用 Codex，改完必须跑 tsc"}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(text); }
          }} />
        <div className="assistant-send">
          <span className="dim">Ctrl / ⌘ + Enter 发送</span>
          <button className="primary" disabled={busy || pending || !text.trim()} onClick={() => void send(text)}>
            {thread ? "发送" : "开始"}
          </button>
        </div>
      </div>
    </section>
  );
}
