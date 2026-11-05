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
      </section>

      <section className="box">
        <h2>代为审批</h2>
        <p className="hint">
          会话卡在等你授权时，先由规则判断：看得懂的（只读、项目内写文件、跑测试）直接放行，
          让 agent 接着干；看不透的（删文件、推送、装包、改敏感文件、向你提问）一律交回给你。
          它只会放行、不会拒绝——判不准就不批。
        </p>
        <p className="hint">
          任务自己声明了「执行边界」（任务详情页）时，边界优先：写在那里的目录、联网、推远端、
          跑脚本不再需要授权；反过来，写到边界外的动作会单独标出来交给你。
        </p>
        <div className="form-grid">
          <label>代批开关
            <select value={m.approve.enabled ? "on" : "off"} disabled={busy}
              onChange={e => void save({ approve: { ...m.approve, enabled: e.target.value === "on" } })}>
              <option value="off">关闭（每条都等我点）</option>
              <option value="on">开启（安全的自动放行）</option>
            </select>
          </label>
          <label>只读命令
            <select value={m.approve.allowRead ? "on" : "off"} disabled={busy}
              onChange={e => void save({ approve: { ...m.approve, allowRead: e.target.value === "on" } })}>
              <option value="on">放行（ls / cat / git status 等）</option>
              <option value="off">也问我</option>
            </select>
          </label>
          <label>项目内写文件
            <select value={m.approve.allowWrite ? "on" : "off"} disabled={busy}
              onChange={e => void save({ approve: { ...m.approve, allowWrite: e.target.value === "on" } })}>
              <option value="on">放行（不能越出项目目录）</option>
              <option value="off">也问我</option>
            </select>
          </label>
          <label>测试与构建
            <select value={m.approve.allowTests ? "on" : "off"} disabled={busy}
              onChange={e => void save({ approve: { ...m.approve, allowTests: e.target.value === "on" } })}>
              <option value="on">放行（npm test / tsc 等）</option>
              <option value="off">也问我</option>
            </select>
          </label>
          <label>联网
            <select value={m.approve.allowNetwork ? "on" : "off"} disabled={busy}
              onChange={e => void save({ approve: { ...m.approve, allowNetwork: e.target.value === "on" } })}>
              <option value="off">问我（装包、请求外网都拦）</option>
              <option value="on">放行</option>
            </select>
          </label>
          <label>每小时最多代批
            <select value={String(m.approve.maxPerHour)} disabled={busy}
              onChange={e => void save({ approve: { ...m.approve, maxPerHour: Number(e.target.value) } })}>
              {[10, 20, 40, 60, 100, 200, 400].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
        <p className="hint">
          无论怎么配，这些永远交给你：删除（rm）、git push / reset --hard、装包、发布、提权、
          下载即执行、越出项目目录、读写 .env / 密钥、MCP 工具，以及 agent 向你提的问题。
          超过每小时上限后，剩下的全部回到你手上。
        </p>
        {msg && <p className="msg">{msg}</p>}
        {err && <p className="msg bad">{err}</p>}
      </section>
    </>
  );
}
