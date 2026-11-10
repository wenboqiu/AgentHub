import { useCallback, useEffect, useState } from "react";
import type { AgentAvatarSpec, Api, BriefEntry, Machine, Project, ProjectDir, ProjectInput } from "./lib/api";
import { ProjectAvatar } from "./AgentAvatar";
import AvatarField from "./AvatarField";
import Markdown from "./Markdown";

// 项目管理：一个代码库的身份与背景知识 + 它在各台电脑上的目录。
// 跟角色页一样分两级：列表只负责浏览和入口，点一条进详情页改，新建也走同一个详情页——
// 配置可能有好几条、还有项目近况，摊在列表里会把别的项目挤出屏幕。
// 「配置」(profile) = 一台电脑 + 这个项目在那台电脑上的目录：派活时按当前电脑自动挑对应那条，
// 路径不会串设备；电脑留空 = 哪台都适用，同一台/同一种最多一条（服务端也校验）。

type Form = { name: string; brief: string; dirs: ProjectDir[]; avatar: AgentAvatarSpec | null };
const BLANK: Form = { name: "", brief: "", dirs: [], avatar: null };
const toForm = (p: Project): Form => ({ name: p.name, brief: p.brief, dirs: p.dirs.map(d => ({ ...d })), avatar: p.avatar ?? null });
const toInput = (f: Form): ProjectInput => ({
  name: f.name.trim(),
  brief: f.brief.trim(),
  // 没填路径的那条等于还没配完，留着不下发
  dirs: f.dirs.filter(d => d.cwd.trim()).map(d => ({ machine: d.machine, cwd: d.cwd.trim() })),
  avatar: f.avatar,
});

/** 电脑下拉里的「其他电脑」：不在清单里的机器名也能手填 */
const OTHER = "__other__";

/**
 * 一条配置：这台电脑 + 它上面的项目目录。
 * 电脑优先从下拉里挑（账号下见过的机器，在线标出来）；要配一台没出现过的机器就选「其他电脑」手填。
 * 同一条机器只能占一条配置，所以别的行已经用掉的机器在下拉里是灰的。
 */
function ProfileRow({ index, dir, machines, taken, busy, onChange, onRemove }: {
  index: number;
  dir: ProjectDir;
  machines: Machine[];
  /** 别的行已经占用的电脑名（null = 已有一条「任意电脑」） */
  taken: Set<string | null>;
  busy: boolean;
  onChange(patch: Partial<ProjectDir>): void;
  onRemove(): void;
}) {
  // 手填模式只由人点「其他电脑…」触发：电脑清单是异步加载的，
  // 用「名字不在 machines 里」当初始条件会在加载完成前把所有人卡进输入框。
  const [typing, setTyping] = useState(false);
  const anyTaken = taken.has(null);
  // 清单里没有的名字（手填的、或机器改过名）仍然要显示出来，别把人卡在没有对应选项的下拉里
  const unknown = !!dir.machine && !machines.some(m => m.name === dir.machine);

  return (
    <div className="profile-row">
      <div className="profile-field">
        <span className="profile-label">电脑<span className="dim">{index + 1}</span></span>
        {typing ? (
          <div className="profile-fallback">
            <input value={dir.machine ?? ""} maxLength={100} disabled={busy} placeholder="电脑名，例如 MACBOOK"
              onChange={e => onChange({ machine: e.target.value.trim() || null })} />
            <button type="button" className="link" disabled={busy} onClick={() => { setTyping(false); onChange({ machine: null }); }}>列表</button>
          </div>
        ) : (
          <select value={dir.machine ?? ""} disabled={busy} onChange={e => {
            const v = e.target.value;
            if (v === OTHER) { setTyping(true); onChange({ machine: null }); return; }
            onChange({ machine: v || null });
          }}>
            <option value="" disabled={anyTaken}>{anyTaken ? "任意电脑（已有一条）" : "任意电脑（哪台都行）"}</option>
            {machines.map(m => (
              <option key={m.name} value={m.name} disabled={taken.has(m.name)}>
                {m.name}{m.online ? "（在线）" : m.listening ? "（开着，没开远程执行）" : ""}
              </option>
            ))}
            {unknown && <option value={dir.machine!}>{dir.machine}（清单里没有）</option>}
            <option value={OTHER}>其他电脑…</option>
          </select>
        )}
      </div>
      <div className="profile-field">
        <span className="profile-label">项目目录</span>
        <input value={dir.cwd} maxLength={4000} disabled={busy} placeholder="例如 D:\\Work2\\AgentHub"
          onChange={e => onChange({ cwd: e.target.value })} />
      </div>
      <button type="button" className="ghost profile-remove" disabled={busy} aria-label="移除这条配置" onClick={onRemove}>移除</button>
    </div>
  );
}

/** 项目配置列表：一条 = 一台电脑 + 目录，派活时按当前电脑自动挑 */
function Profiles({ form, machines, busy, onChange }: {
  form: Form; machines: Machine[]; busy: boolean; onChange(patch: Partial<Form>): void;
}) {
  const set = (i: number, patch: Partial<ProjectDir>) => onChange({
    dirs: form.dirs.map((d, j) => (j === i ? { ...d, ...patch } : d)),
  });
  const takenFor = (i: number) => new Set(form.dirs.filter((_, j) => j !== i).map(d => d.machine));
  // 新配置尽量先落到一台还没用过的电脑上，省得开局就是「已有一条」的灰选项
  const add = () => {
    const used = new Set(form.dirs.map(d => d.machine));
    const free = machines.find(m => m.online && !used.has(m.name)) ?? machines.find(m => !used.has(m.name));
    onChange({ dirs: [...form.dirs, { machine: free?.name ?? null, cwd: "" }] });
  };

  return (
    <div className="profile-block">
      <div className="profile-block-head">
        <span>项目配置</span>
        <span className="dim">一条配置 = 一台电脑 + 这个项目在那台电脑上的目录；派活时按当前电脑自动挑，电脑留空 = 哪台都适用</span>
      </div>
      {form.dirs.length === 0 && <p className="hint">还没有配置。加一条，派活时就不用每次手填路径。</p>}
      {form.dirs.map((d, i) => (
        <ProfileRow key={i} index={i} dir={d} machines={machines} taken={takenFor(i)} busy={busy}
          onChange={patch => set(i, patch)}
          onRemove={() => onChange({ dirs: form.dirs.filter((_, j) => j !== i) })} />
      ))}
      <button type="button" className="ghost profile-add" disabled={busy} onClick={add}>＋ 新建配置</button>
    </div>
  );
}

function Fields({ form, machines, busy, onChange }: {
  form: Form; machines: Machine[]; busy: boolean; onChange(patch: Partial<Form>): void;
}) {
  return (
    <>
      <div className="form-grid">
        <label>项目名（必填）<input value={form.name} maxLength={60} disabled={busy} placeholder="例如 AgentHub" onChange={e => onChange({ name: e.target.value })} /></label>
      </div>
      <Profiles form={form} machines={machines} busy={busy} onChange={onChange} />
      <label>项目说明（技术栈、约定、不能碰的东西；最多 4000 字）
        <textarea value={form.brief} rows={4} maxLength={4000} disabled={busy} placeholder={"例如：Fastify + Postgres；接口统一 camelCase；改完跑 npm test 和 tsc；不要动 migrations 里已有的文件。"} onChange={e => onChange({ brief: e.target.value })} />
      </label>
      <p className="hint">项目说明会随派活一起下发给执行端；角色在这个项目上的经验另存在角色记忆里。</p>
    </>
  );
}

// 项目近况：任务完成时服务端自动追加一句结论，派活时取最近几条注入提示。
// 和上面的「项目说明」分工——说明是人写的长期背景，近况是机器记的滚动进展。
function Brief({ api, projectId }: { api: Api; projectId: number }) {
  const [entries, setEntries] = useState<BriefEntry[] | null>(null);
  const [text, setText] = useState(""), [busy, setBusy] = useState(false), [err, setErr] = useState("");
  const load = () => api.projectBrief(projectId).then(setEntries, () => setEntries([]));
  const run = async (fn: () => Promise<BriefEntry[]>) => {
    setBusy(true); setErr("");
    try { setEntries(await fn()); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <details className="brief" onToggle={e => { if (e.currentTarget.open && entries === null) void load(); }}>
      <summary>项目近况<span className="dim">任务跑完自动记一句，派活时最近 8 条随上下文下发</span></summary>
      {entries === null ? <p className="hint">加载中…</p> : (
        <>
          {entries.length === 0
            ? <p className="hint">还没有近况。任务跑完会自动记一条；也可以现在手写一条约定或进展。</p>
            : (
              <ul className="brief-list">
                {entries.map(e => (
                  <li key={e.id}>
                    <span className="dim">{new Date(e.at).toLocaleDateString()}</span>
                    <div className="brief-text"><Markdown text={e.text} compact /></div>
                    <button className="link" disabled={busy} onClick={() => void run(() => api.deleteBrief(projectId, e.id))}>删除</button>
                  </li>
                ))}
              </ul>
            )}
          <form className="brief-add" onSubmit={ev => { ev.preventDefault(); if (!text.trim()) return; void run(async () => { const r = await api.addBrief(projectId, text.trim()); setText(""); return r; }); }}>
            <input value={text} maxLength={240} disabled={busy} placeholder="例如：登录改造已合并，回跳暂时仍走旧参数" onChange={e => setText(e.target.value)} />
            <button disabled={busy || !text.trim()}>记一条</button>
          </form>
          {err && <p className="form-error" role="alert">{err}</p>}
        </>
      )}
    </details>
  );
}

/**
 * 项目详情：独立一页，字段就地编辑 + 项目近况 + 删除。
 * 新建也走这里（project = null）：建完不跳走，直接变成这个项目的详情页，接着配目录。
 */
export function ProjectEditor({ api, project: initial, onBack, onSaved, onDeleted }: {
  api: Api;
  /** null = 新建 */
  project: Project | null;
  onBack(): void;
  /** 建好 / 保存后回传最新项目（外层用它的名字做页标题） */
  onSaved(p: Project): void;
  onDeleted(): void;
}) {
  const [project, setProject] = useState<Project | null>(initial);
  const [form, setForm] = useState(() => (initial ? toForm(initial) : BLANK));
  const [machines, setMachines] = useState<Machine[]>([]);
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState(""), [err, setErr] = useState("");

  // 配置的电脑下拉项：拿不到就当没有候选，只留「任意 / 其他电脑」
  useEffect(() => { api.machines().then(setMachines, () => setMachines([])); }, [api]);

  // 与上次保存下来的那份比，才判断得出有没有改动
  const dirty = JSON.stringify(form) !== JSON.stringify(project ? toForm(project) : BLANK);
  const ready = !!form.name.trim();

  const save = async () => {
    setBusy(true); setErr(""); setMsg("");
    const creating = !project;
    try {
      const p = creating
        ? await api.createProject(toInput(form) as ProjectInput & { name: string })
        : await api.updateProject(project.id, toInput(form));
      setProject(p);
      setForm(toForm(p));
      onSaved(p);
      setMsg(creating ? "项目已创建，接着配目录或直接返回" : "项目已保存");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!project) return;
    setBusy(true); setErr(""); setMsg("");
    try {
      await api.deleteProject(project.id);
      onDeleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <>
      <section className="box">
        <div className="box-head">
          <h2>基本信息</h2>
          {dirty && <span className="badge">未保存</span>}
        </div>
        <AvatarField
          value={form.avatar}
          busy={busy}
          preview={(s, size) => <ProjectAvatar project={{ name: form.name || "项目" }} spec={s} size={size} decorative />}
          defaultTitle="默认：项目名首字母"
          hideInitial
          onChange={(avatar) => setForm(f => ({ ...f, avatar }))}
        />
        <Fields form={form} machines={machines} busy={busy} onChange={(patch) => setForm(f => ({ ...f, ...patch }))} />
        <div className="btns">
          <button className="primary" disabled={busy || !dirty || !ready} onClick={() => void save()}>
            {project ? "保存" : "创建项目"}
          </button>
          <button className="ghost" disabled={busy} onClick={onBack}>返回列表</button>
          {!ready && <span className="dim">项目名必填，其余可以之后慢慢补。</span>}
        </div>
        {msg && <p className="msg">{msg}</p>}
        {err && <p className="form-error" role="alert">{err}</p>}
      </section>

      {project && (
        <section className="box">
          <Brief api={api} projectId={project.id} />
        </section>
      )}

      {project && (
        <section className="box">
          <div className="btns">
            <button className="ghost" disabled={busy} onClick={() => void remove()}>删除项目</button>
            <span className="dim">已经派出去的任务不会被删掉，只是不再带这个项目；当前有 {project.tasks} 个任务用过它。</span>
          </div>
        </section>
      )}
    </>
  );
}

/** 项目列表：一条一行，点进去才是编辑页 */
export default function Projects({ api, onEdit }: { api: Api; onEdit(project: Project | null): void }) {
  const [list, setList] = useState<Project[] | null>(null);

  const load = useCallback(() => {
    api.projects().then(setList, () => setList([]));
  }, [api]);
  useEffect(() => { load(); }, [load]);

  return (
    <section className="box">
      <div className="box-head">
        <h2>项目</h2>
      </div>
      <p className="hint">
        一个项目 = 一个代码库的身份、它的约定、以及它在你各台电脑上的目录。点项目进编辑，给它在每台电脑上配一条「配置」（电脑 + 目录）；
        派活时选中项目，说明随上下文下发、目录按当前那台电脑自动挑。角色在这个项目上的经验按项目分开记，换个项目不会带过去。
      </p>
      {list === null ? (
        <p className="hint">加载中…</p>
      ) : (
        <>
          {list.length === 0 && <p className="hint">还没有项目。建一个之后，派活时选项目就能带上它的约定和对应目录。</p>}
          {list.map((p) => (
            <div key={p.id} className="profile-card">
              <button type="button" className="role-head" onClick={() => onEdit(p)}>
                <ProjectAvatar project={p} size={28} decorative />
                <strong>{p.name}</strong>
                <span className="dim role-title">
                  {p.dirs.length
                    ? p.dirs.map(d => `${d.machine ?? "任意电脑"} · ${d.cwd}`).join("　")
                    : p.brief || "未登记配置"}
                </span>
                <span className="role-meta">
                  <span>{p.dirs.length} 个配置</span>
                  <span>{p.tasks} 个任务</span>
                </span>
                <span className="role-toggle">编辑</span>
              </button>
            </div>
          ))}
          <button className="ghost" onClick={() => onEdit(null)}>＋ 新建项目</button>
        </>
      )}
    </section>
  );
}
