import { useCallback, useEffect, useState } from "react";
import { Api, type Machine } from "./lib/api";
import { DEVICE_STATE_LABEL, deviceSummary, deviceTools, groupDevices, machineState } from "./lib/devices";
import { ago, fullAt } from "./lib/time";

/**
 * 设备总览：哪些电脑装了 AgentHub、此刻能不能接活。
 *
 * 数据就是派活下拉用的那份 /machines（在线 + 历史记录里的机器名），这里把它平铺出来，
 * 不再需要先点开一个任务才能看见别的电脑在不在线。电脑状态会自己变，页面上按 10 秒轮询，
 * 时间文案另按 30 秒走一次，省得「3 分钟前」一直停在原处。
 */
export default function Devices({ api, localMachine, onOpenAccount }: { api: Api; localMachine: string; onOpenAccount?(): void }) {
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => {
    api.machines().then(
      (ms) => {
        setMachines(ms);
        setErr("");
      },
      (e) => setErr(`拉取设备失败：${e instanceof Error ? e.message : String(e)}`),
    );
  }, [api]);

  useEffect(() => {
    load();
    const t = window.setInterval(load, 10_000);
    return () => window.clearInterval(t);
  }, [load]);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const groups = machines ? groupDevices(machines) : [];
  const sum = machines ? deviceSummary(machines) : null;

  return (
    <>
      <section className="box">
        <h2>设备</h2>
        <p className="hint">
          装着 AgentHub、连过这台服务器的电脑。状态直接来自执行器：在线能立刻接单；「没开远程执行」表示 AgentHub
          在跑但那个开关关着，派给它的单会排队，等开关打开才动。
        </p>
        {sum && machines && machines.length > 0 && (
          <p className="kv">
            共 <b>{machines.length}</b> 台：
            <b className="dev-online-count">{sum.online}</b> 台在线
            {sum.listening > 0 && <>、{sum.listening} 台没开远程执行</>}
            {sum.offline > 0 && <>、{sum.offline} 台离线</>}
          </p>
        )}

        {err && <p className="msg bad">{err}</p>}
        {machines === null && <p className="hint">加载中…</p>}
        {machines?.length === 0 && (
          <p className="hint">还没有电脑上报过状态：在要监控的电脑上打开 AgentHub 并登录，几秒内就会出现在这里。</p>
        )}

        {groups.map((g) =>
          g.items.length === 0 ? null : (
            <div key={g.key} className="dev-group">
              <h3 className="dev-group-head">
                <i className={`dev-dot ${g.key}`} />
                {g.label}
                <span className="dev-group-count">{g.items.length} 台</span>
              </h3>
              <ul className="devices">
                {g.items.map((m) => {
                  const state = machineState(m);
                  const local = m.name === localMachine.trim() || m.name.toLowerCase() === localMachine.trim().toLowerCase();
                  return (
                    <li key={m.name}>
                      <span className="dev-name">
                        <b>{m.name}</b>
                        {local && <span className="tag local">本机</span>}
                        <span className={`dev-state ${state}`}>{DEVICE_STATE_LABEL[state]}</span>
                      </span>
                      <span className="dev-time" title={fullAt(m.at)}>
                        {m.at ? `最近活动 ${ago(m.at, now)}` : "没有活动记录"}
                      </span>
                      <span className="dev-tools">
                        {m.agents.length > 0
                          ? deviceTools(m.agents).map((t) => `${t.label}${t.listenOnly ? "（只监听）" : ""}`).join(" · ")
                          : "未上报装了哪些工具"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ),
        )}

        <div className="btns">
          <button onClick={load}>刷新</button>
          {onOpenAccount && <button className="link" onClick={onOpenAccount}>已登录的手机 / 平板</button>}
        </div>
        <p className="hint">
          这里只列会执行任务的电脑。手机、平板这类只收通知、不发执行状态的设备在「账号与安全 → 已登录设备」里。
        </p>
      </section>
    </>
  );
}
