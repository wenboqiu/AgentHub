import { useCallback, useEffect, useState } from "react";
import { desktop, type HubTask, type HubWorker } from "./lib/platform";
import Icon from "./Icon";

const STATE_LABEL: Record<HubTask["state"], string> = {
  queued: "排队",
  dispatched: "已派发",
  running: "运行中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
const ACTIVE: HubTask["state"][] = ["queued", "dispatched", "running"];
const WORKERS = ["workbuddy", "doubao", "claude", "codex", "zcode"];
const WORKER_LABEL: Record<string, string> = { workbuddy: "WorkBuddy", doubao: "豆包", claude: "Claude", codex: "Codex", zcode: "ZCode" };

const fmtTime = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const seenText = (lastSeen: number) => {
  if (!lastSeen) return "从未来过";
  const s = Math.max(0, Math.round((Date.now() - lastSeen) / 1000));
  if (s < 60) return "刚刚报到";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前来过`;
  return `${Math.floor(s / 3600)} 小时前来过`;
};

function TaskRow({ t, onChanged, onNotice }: { t: HubTask; onChanged(): void; onNotice(m: string): void }) {
  const [open, setOpen] = useState(false);
  const active = ACTIVE.includes(t.state);
  return (
    <li className={`row hub-task st-${t.state}`}>
      <div className="row-head">
        <span className={`tag ${t.worker}`}>{WORKER_LABEL[t.worker] ?? t.worker}</span>
        <button className="session-open" onClick={() => setOpen(!open)} aria-expanded={open}>
          {t.title}
        </button>
        <span className="badge">{STATE_LABEL[t.state]}</span>
        {t.dispatches > 1 && <span className="badge">重派 {t.dispatches - 1} 次</span>}
      </div>
      {open && (
        <div className="hub-detail">
          {t.workspace && (
            <p className="kv">
              工作区：<b>{t.workspace}</b>
            </p>
          )}
          <pre className="hub-body">{t.body || "（无正文）"}</pre>
          {t.result && (
            <p className="kv">
              结果：<b className={t.ok === false ? "bad" : ""}>{t.result}</b>
            </p>
          )}
          {t.artifacts.length > 0 && (
            <p className="kv">
              产物：
              {t.artifacts.map((a) => (
                <code key={a}>{a} </code>
              ))}
            </p>
          )}
          <p className="kv hint">
            创建 {fmtTime(t.createdAt)} · 更新 {fmtTime(t.updatedAt)}
          </p>
        </div>
      )}
      <div className="row-foot">
        <span className="since">{fmtTime(t.updatedAt)}</span>
        <span className="actions">
          {active && (
            <button
              className="link"
              onClick={() => {
                desktop
                  .hubCancel(t.id)
                  .then(onChanged)
                  .catch((e) => onNotice(String(e)));
              }}
            >
              取消
            </button>
          )}
        </span>
      </div>
    </li>
  );
}

export default function HubPanel({ onNotice }: { onNotice(m: string): void }) {
  const [tasks, setTasks] = useState<HubTask[]>([]);
  const [workers, setWorkers] = useState<HubWorker[]>([]);
  const [title, setTitle] = useState("");
  const [worker, setWorker] = useState("workbuddy");
  const [workspace, setWorkspace] = useState("");
  const [body, setBody] = useState("");
  const [msg, setMsg] = useState("");
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const refresh = useCallback(() => {
    desktop.hubTasks().then(setTasks).catch(() => {});
    desktop.hubWorkers().then(setWorkers).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 5000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const create = async () => {
    if (!title.trim()) return setMsg("标题不能为空");
    setCreating(true);
    try {
      await desktop.hubCreate({ title, body, worker, workspace });
      setTitle("");
      setBody("");
      setMsg(`已发单给 ${WORKER_LABEL[worker] ?? worker}`);
      window.setTimeout(() => setMsg(""), 2500);
      refresh();
    } catch (e) {
      setMsg(`发单失败：${String(e)}`);
    } finally {
      setCreating(false);
    }
  };

  const active = tasks.filter((t) => ACTIVE.includes(t.state));
  const finished = tasks.filter((t) => !ACTIVE.includes(t.state));

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">本地派单队列</p>
          <h2>派单</h2>
          <p>把工单发给指定 worker（轮询拉单），超时自动回队重派。</p>
        </div>
        <button onClick={refresh} aria-label="刷新">
          <Icon name="refresh" /> 刷新
        </button>
      </div>

      <section>
        <h2>Worker 状态</h2>
        {workers.length === 0 ? (
          <p className="empty">还没有 worker 来报到。按 docs/hub-worker.md 给 WorkBuddy / 豆包配上轮询自动化。</p>
        ) : (
          <ul className="hub-workers">
            {workers.map((w) => (
              <li key={w.name} className="hub-worker">
                <strong>{WORKER_LABEL[w.name] ?? w.name}</strong>
                <span>
                  排 {w.queued} · 跑 {w.running} · {seenText(w.lastSeen)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>
          进行中 <span className="count dim">{active.length}</span>
        </h2>
        {active.length ? (
          <ul className="list">
            {active.map((t) => (
              <TaskRow key={t.id} t={t} onChanged={refresh} onNotice={onNotice} />
            ))}
          </ul>
        ) : (
          <p className="empty">没有进行中的单子</p>
        )}
      </section>

      <details>
        <summary>已结束（{finished.length}）</summary>
        {finished.length ? (
          <ul className="list">
            {finished.map((t) => (
              <TaskRow key={t.id} t={t} onChanged={refresh} onNotice={onNotice} />
            ))}
          </ul>
        ) : (
          <p className="empty">空</p>
        )}
      </details>

      <section className="box">
        <h2>
          <button className="link" onClick={() => setShowForm(!showForm)} aria-expanded={showForm}>
            <Icon name="plus" /> 发新单
          </button>
        </h2>
        {showForm && (
          <>
            <label>
              标题（一句话）
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：给 README 补安装说明" />
            </label>
            <label>
              派给谁
              <select value={worker} onChange={(e) => setWorker(e.target.value)}>
                {WORKERS.map((w) => (
                  <option key={w} value={w}>
                    {WORKER_LABEL[w] ?? w}
                  </option>
                ))}
              </select>
            </label>
            <label>
              工作区（可选，绝对路径）
              <input value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="D:/Work2/AgentHub" spellCheck={false} />
            </label>
            <label>
              工单正文（自包含：背景 / 约束 / 验收标准；worker 无上下文，按这个干活）
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} placeholder={"## 目标\n...\n## 约束\n...\n## 验收标准\n- ..."} spellCheck={false} />
            </label>
            <div className="btns">
              <button className="primary" onClick={() => void create()} disabled={creating || !title.trim()}>
                发单
              </button>
            </div>
            <p className="hint">发单后 worker 的轮询自动化会自己来拉；拉单 5 分钟未确认或运行中 10 分钟无心跳会自动回队，重派 3 次后判失败。</p>
          </>
        )}
        {msg && <p className="msg">{msg}</p>}
      </section>
    </>
  );
}
