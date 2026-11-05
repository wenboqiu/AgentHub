import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Api,
  AssistantAgent,
  AssistantDraft,
  AssistantDraftFields,
  AssistantState,
  Profile,
  Task,
} from "./lib/api";
import { AGENT_LABEL } from "./lib/agents";

// 角色助手：一句话描述「要一个什么样的人」，由电脑端的 agent 出草稿，
// 用户在草稿卡上改完再点创建。agent 只出 JSON，落库始终走 POST /roles，
// 所以重名、上限、字段长度这些校验和手填表单完全一致。

const ASSISTANTS: AssistantAgent[] = ["claude", "codex", "zcode"];
const EXAMPLES = [
  "要一个负责前端实现的角色，用 Codex，改完必须跑 tsc",
  "来个代码评审，只看 diff，不改文件",
  "服务端接口和迁移交给它，用 Claude，模型 sonnet",
];

type Form = { name: string; title: string; agent: string; model: string; context: string; tools: string; profileId: string };

const toForm = (d: AssistantDraftFields | null): Form => ({
  name: d?.name ?? "",
  title: d?.title ?? "",
  agent: d?.agent ?? "",
  model: d?.model ?? "",
  context: d?.context ?? "",
  tools: (d?.tools ?? []).join("、"),
  profileId: d?.profileId === null || d?.profileId === undefined ? "" : String(d.profileId),
});

const toFields = (f: Form): Partial<AssistantDraftFields> => ({
  name: f.name.trim(),
  title: f.title.trim(),
  agent: (f.agent || null) as Task["agent"],
  model: f.model.trim() || null,
  context: f.context.trim(),
  tools: f.tools.split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean),
  profileId: f.profileId ? Number(f.profileId) : null,
});

const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
};

/** 草稿卡：字段可改，创建后才真正落库；已创建 / 已丢弃的只留一行结论 */
function DraftCard({
  api,
  draft,
  profiles,
  busy,
  onBusy,
  onCreated,
  onError,
}: {
  api: Api;
  draft: AssistantDraft;
  profiles: Profile[];
  busy: boolean;
  onBusy(v: boolean): void;
  onCreated(): void;
  onError(msg: string): void;
}) {
  const [form, setForm] = useState<Form>(() => toForm(draft.draft));
  const [handled, setHandled] = useState<null | "created" | "discarded">(null);
  const set = (patch: Partial<Form>) => setForm(f => ({ ...f, ...patch }));
  // 别处（另一台设备 / 刷新）处理过的草稿也按结果渲染，本地点过的优先
  const done = handled ?? draft.status;

  const act = async (fn: () => Promise<unknown>) => {
    onBusy(true); onError("");
    try { await fn(); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { onBusy(false); }
  };

  if (done === "created") {
    return <p className="assistant-verdict">已创建角色「{form.name}」，可以在下面继续改。</p>;
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
      <div className="form-grid">
        <label>角色名<input value={form.name} maxLength={60} disabled={busy} onChange={e => set({ name: e.target.value })} /></label>
        <label>职责<input value={form.title} maxLength={120} disabled={busy} onChange={e => set({ title: e.target.value })} /></label>
        <label>执行工具
          <select value={form.agent} disabled={busy} onChange={e => set({ agent: e.target.value, model: "" })}>
            <option value="">未指定</option>
            {ASSISTANTS.map(key => <option key={key} value={key}>{AGENT_LABEL[key]}</option>)}
          </select>
        </label>
        <label>模型<input value={form.model} maxLength={120} disabled={busy} placeholder="留空 = 执行端默认" onChange={e => set({ model: e.target.value })} /></label>
        <label>默认配置
          <select value={form.profileId} disabled={busy} onChange={e => set({ profileId: e.target.value })}>
            <option value="">不挂配置</option>
            {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>可用工具<input value={form.tools} maxLength={600} disabled={busy} onChange={e => set({ tools: e.target.value })} /></label>
      </div>
      <label>上下文（角色准则）
        <textarea value={form.context} rows={5} maxLength={4000} disabled={busy} onChange={e => set({ context: e.target.value })} />
      </label>
      <div className="btns">
        <button className="primary" disabled={busy || !form.name.trim()}
          onClick={() => void act(async () => { await api.confirmDraft(draft.id, toFields(form)); setHandled("created"); onCreated(); })}>
          创建角色
        </button>
        <button className="ghost" disabled={busy}
          onClick={() => void act(async () => { await api.discardDraft(draft.id); setHandled("discarded"); })}>不用了</button>
      </div>
    </div>
  );
}

export default function Assistant({
  api,
  profiles,
  onCreated,
  onClose,
}: {
  api: Api;
  profiles: Profile[];
  onCreated(): void;
  onClose(): void;
}) {
  const [state, setState] = useState<AssistantState | null>(null);
  const [text, setText] = useState("");
  const [agent, setAgent] = useState<AssistantAgent>("claude");
  const [machine, setMachine] = useState("");
  const [cwd, setCwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const inited = useRef(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await api.assistant();
      setState(s);
      // 首次拿到建议值就填进设置区，之后不再覆盖用户改过的内容
      if (!inited.current) {
        inited.current = true;
        setAgent(s.suggestion.agent);
        setMachine(s.suggestion.machine);
        setCwd(s.suggestion.cwd);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

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
    if (!body || busy) return;
    setBusy(true); setErr("");
    try {
      if (!thread) {
        if (!machine.trim() || !cwd.trim()) throw new Error("先选一台在线的电脑，并填一个存在的目录");
        await api.startAssistant({ agent, machine: machine.trim(), cwd: cwd.trim(), text: body });
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
        用一句话说清要什么人，电脑端的 agent 会整理成一份草稿（名字、职责、执行工具、模型、准则）；草稿你可以直接改，点「创建角色」才真正写进角色列表。
        这条通道借的是派活：电脑得开着 AgentHub，一次大概十几秒，不会读写你的文件
        {state?.roles ? `；现有 ${state.roles} 个角色，助手会避开重名` : ""}。
      </p>

      {err && <p className="form-error" role="alert">{err}</p>}
      {state?.runError && <p className="form-error" role="alert">上一轮失败：{state.runError}</p>}

      {!thread && (
        <div className="assistant-setup">
          <div className="form-grid">
            <label>执行工具
              <select value={agent} disabled={busy} onChange={e => setAgent(e.target.value as AssistantAgent)}>
                {ASSISTANTS.map(key => <option key={key} value={key}>{AGENT_LABEL[key]}</option>)}
              </select>
            </label>
            <label>电脑
              <select value={machine} disabled={busy} onChange={e => setMachine(e.target.value)}>
                <option value="">{state?.online.length ? "选一台" : "没有在线的电脑"}</option>
                {(state?.online ?? []).map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label>目录
              <input value={cwd} maxLength={4000} disabled={busy} placeholder="电脑上已存在的目录，例如 D:\\Work2\\Demo" onChange={e => setCwd(e.target.value)} />
            </label>
          </div>
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
                <div className="assistant-bubble">{m.text}</div>
                <span className="dim assistant-time">{m.role === "user" ? "你" : AGENT_LABEL[thread?.agent ?? ""] ?? "助手"} · {clock(m.createdAt)}</span>
                {draft && (
                  <DraftCard api={api} draft={draft} profiles={profiles} busy={busy}
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
        <textarea value={text} rows={2} maxLength={4000} disabled={busy || pending}
          placeholder={thread ? "继续说，例如：名字改成 前端实现，模型 sonnet" : "描述你要的角色，例如：要一个负责前端实现的人，用 Codex，改完必须跑 tsc"}
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
