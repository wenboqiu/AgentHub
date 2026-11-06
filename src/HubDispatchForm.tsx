import { useState } from "react";
import { desktop } from "./lib/platform";

const WORKERS = ["workbuddy", "doubao", "claude", "codex", "zcode"];
const WORKER_LABEL: Record<string, string> = { workbuddy: "WorkBuddy", doubao: "豆包", claude: "Claude", codex: "Codex", zcode: "ZCode" };

/** 发单表单（自包含工单）：派单 tab 和看板页共用 */
export default function HubDispatchForm({ onCreated, onNotice }: { onCreated?(): void; onNotice?(msg: string): void }) {
  const [title, setTitle] = useState("");
  const [worker, setWorker] = useState("workbuddy");
  const [workspace, setWorkspace] = useState("");
  const [body, setBody] = useState("");
  const [msg, setMsg] = useState("");
  const [creating, setCreating] = useState(false);

  const create = async () => {
    if (!title.trim()) return setMsg("标题不能为空");
    setCreating(true);
    try {
      await desktop.hubCreate({ title, body, worker, workspace });
      setTitle("");
      setBody("");
      setMsg(`已发单给 ${WORKER_LABEL[worker] ?? worker}`);
      window.setTimeout(() => setMsg(""), 2500);
      onCreated?.();
    } catch (e) {
      const m = `发单失败：${String(e)}`;
      setMsg(m);
      onNotice?.(m);
    } finally {
      setCreating(false);
    }
  };

  return (
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
      {msg && <p className="msg">{msg}</p>}
    </>
  );
}

export { WORKERS, WORKER_LABEL };
