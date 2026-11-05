import { useCallback, useEffect, useState } from "react";
import type { Api, DispatchManager, ManagerState } from "./lib/api";
import { AGENT_LABEL } from "./lib/agents";

// 项目经理：一个账号一个。它做两件事——把处理意见重写成任务单，以及（开关打开时）
// 把「人已经确认、还没派出去」的任务按限额派给自己安排好的执行人。
//
// 这里能改的只有「谁当项目经理、开不开自动派发、最多同时几个、每小时最多几次」。
// 范围规则写在服务端（server/src/dispatch-manager.ts）：只派由处理意见确认生成的任务。

const PRIORITY_HINT = "只派由处理意见确认生成、且还没派过的任务；历史待办一律不动。";

export default function Manager({ api }: { api: Api }) {
  const [state, setState] = useState<ManagerState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(() => {
    api.dispatchManager().then(setState, () => setState(null));
  }, [api]);
  useEffect(() => { load(); }, [load]);

  const save = async (patch: Partial<DispatchManager>) => {
    setBusy(true); setErr(""); setMsg("");
    try {
      setState(await api.saveDispatchManager(patch));
      setMsg("已保存");
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (!state) return <p className="hint">正在读取项目经理的配置…</p>;
  const m = state.manager;
  const roles = state.roles ?? [];
  const role = roles.find(r => r.id === m.roleId);

  return (
    <>
      <section className="box">
        <h2>项目经理</h2>
        <p className="hint">
          项目经理不亲自写代码：它读会话、排任务单、定执行人，你确认后它再把活派出去。
          没选角色时只能用「规则档」整理，自动派发也不会开。
        </p>
        <div className="form-grid">
          <label>由谁担任
            <select value={m.roleId === null ? "" : String(m.roleId)} disabled={busy}
              onChange={e => void save({ roleId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">还没选</option>
              {roles.map(r => <option key={r.id} value={r.id}>{r.name}{r.title ? ` · ${r.title}` : ""}</option>)}
            </select>
          </label>
          <label>自动派发
            <select value={m.enabled ? "on" : "off"} disabled={busy}
              onChange={e => void save({ enabled: e.target.value === "on" })}>
              <option value="off">关闭（只出任务单，等我自己派）</option>
              <option value="on">开启（确认过的任务由它派）</option>
            </select>
          </label>
          <label>最多同时几个
            <select value={String(m.maxRunning)} disabled={busy}
              onChange={e => void save({ maxRunning: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5, 6, 8, 10].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label>每小时最多几次
            <select value={String(m.maxPerHour)} disabled={busy}
              onChange={e => void save({ maxPerHour: Number(e.target.value) })}>
              {[1, 2, 3, 4, 6, 8, 12, 20, 40, 60].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
        {role && (
          <p className="hint">
            用的是 {role.name}{role.agent ? ` 背后的 ${AGENT_LABEL[role.agent] ?? role.agent}` : ""}：重写任务单时借这台电脑上已登录的 agent，服务端不存模型凭据。
          </p>
        )}
        <p className="hint">
          现在在跑 {state.running} 个、最近一小时自动派了 {state.recent} 次；这轮还能再派 {state.quota} 个。
        </p>
        <p className="hint">{PRIORITY_HINT}</p>
        {msg && <p className="msg">{msg}</p>}
        {err && <p className="msg bad">{err}</p>}
      </section>
    </>
  );
}
