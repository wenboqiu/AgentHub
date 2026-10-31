import { useEffect, useState } from "react";
import { Api } from "./lib/api";
import { desktop, isAndroid, isDesktop, native, saveConfig, type CollectorInfo, type Config, type HooksStatus, type RemoteInfo } from "./lib/platform";

export default function Settings({ cfg, onClose, onSaved }: { cfg: Config; onClose(): void; onSaved(c: Config): void }) {
  const [form, setForm] = useState<Config>(cfg);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [hooks, setHooks] = useState<HooksStatus | null>(null);
  const [info, setInfo] = useState<CollectorInfo | null>(null);
  const [remote, setRemote] = useState<RemoteInfo | null>(null);
  const [rootsText, setRootsText] = useState((cfg.allowedRoots ?? []).join("\n"));
  const [autostart, setAutostart] = useState(false);
  const [bg, setBg] = useState(false);
  const [notif, setNotif] = useState(true);

  const set = <K extends keyof Config>(k: K, v: Config[K]) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    if (isDesktop) {
      desktop.hooksStatus().then(setHooks).catch((e) => setMsg(String(e)));
      desktop.status().then(setInfo).catch(() => {});
      desktop.remoteStatus().then(setRemote).catch(() => {});
      import("@tauri-apps/plugin-autostart").then((m) => m.isEnabled().then(setAutostart)).catch(() => {});
    }
    const n = native();
    if (isAndroid && n) {
      setBg(n.isRunning());
      setNotif(n.notificationsEnabled());
    }
  }, []);

  // 执行器连接状态：保存配置后几秒内会变化，定时刷新
  useEffect(() => {
    if (!isDesktop) return;
    const t = window.setInterval(() => desktop.remoteStatus().then(setRemote).catch(() => {}), 2000);
    return () => window.clearInterval(t);
  }, []);

  const test = async () => {
    setBusy(true);
    setMsg("测试中…");
    try {
      const api = new Api(form.serverUrl, form.token, form.controlToken);
      await api.health();
      const list = await api.sessions();
      setMsg(`连接成功，服务端当前有 ${list.length} 个会话`);
    } catch (e) {
      setMsg(`连接失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const c: Config = {
      ...form,
      serverUrl: form.serverUrl.trim().replace(/\/+$/, ""),
      token: form.token.trim(),
      machine: form.machine.trim(),
      controlToken: form.controlToken.trim(),
      allowedRoots: rootsText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
    };
    try {
      await saveConfig(c);
      // Android 后台服务已开启时，把新地址同步给原生
      if (isAndroid && bg && c.serverUrl && c.token) native()?.start(c.serverUrl, c.token);
      onSaved(c);
    } catch (e) {
      setMsg(`保存失败：${String(e)}`);
    }
  };

  const hookAction = async (install: boolean) => {
    try {
      setHooks(await (install ? desktop.installHooks() : desktop.uninstallHooks()));
      setMsg(install ? "已安装 Claude Code hook（原 settings.json 已备份为 settings.json.agenthub-bak）" : "已卸载 Claude Code hook");
    } catch (e) {
      setMsg(String(e));
    }
  };

  const toggleAutostart = async (on: boolean) => {
    try {
      const m = await import("@tauri-apps/plugin-autostart");
      if (on) await m.enable();
      else await m.disable();
      setAutostart(await m.isEnabled());
    } catch (e) {
      setMsg(String(e));
    }
  };

  const toggleBg = (on: boolean) => {
    const n = native();
    if (!n) return setMsg("当前环境没有 Android 原生桥");
    if (on) {
      if (!form.serverUrl || !form.token) return setMsg("请先填好服务器地址和 token");
      // 先把配置存下来，原生服务才拿到最新值
      saveConfig({ ...form }).catch(() => {});
      n.start(form.serverUrl.trim().replace(/\/+$/, ""), form.token.trim());
    } else n.stop();
    window.setTimeout(() => {
      setBg(n.isRunning());
      setNotif(n.notificationsEnabled());
    }, 500);
    setBg(on);
  };

  return (
    <div className="app settings">
      <header>
        <h1>设置</h1>
        <span className="spacer" />
        <button onClick={onClose}>返回</button>
      </header>
      <main>
        <label>
          服务器地址
          <input value={form.serverUrl} onChange={(e) => set("serverUrl", e.target.value)} placeholder="https://agenthub.example.com" autoCapitalize="off" autoCorrect="off" />
        </label>
        <label>
          Token
          <input type="password" value={form.token} onChange={(e) => set("token", e.target.value)} autoCapitalize="off" autoCorrect="off" />
        </label>
        <label>
          控制密钥（可选；填了才能在手机 / 电脑上给会话发消息、批授权）
          <input type="password" value={form.controlToken} onChange={(e) => set("controlToken", e.target.value)} autoCapitalize="off" autoCorrect="off" />
        </label>
        {isDesktop && (
          <label>
            本机名称（machine）
            <input value={form.machine} onChange={(e) => set("machine", e.target.value)} />
          </label>
        )}
        <div className="btns">
          <button onClick={test} disabled={busy || !form.serverUrl}>
            测试连接
          </button>
          <button className="primary" onClick={save}>
            保存
          </button>
        </div>
        {msg && <p className="msg">{msg}</p>}

        {isDesktop && (
          <section className="box">
            <h2>桌面端</h2>
            <label className="check">
              <input type="checkbox" checked={form.notifyDesktop} onChange={(e) => set("notifyDesktop", e.target.checked)} />
              会话完成 / 等待授权时弹桌面通知（保存后生效）
            </label>
            <label className="check">
              <input type="checkbox" checked={autostart} onChange={(e) => toggleAutostart(e.target.checked)} />
              开机自启（静默启动到托盘）
            </label>
            <label className="check">
              <input type="checkbox" checked={form.remoteEnabled} onChange={(e) => set("remoteEnabled", e.target.checked)} />
              允许手机远程执行（保存后生效；需要填上面的控制密钥）
            </label>
            <label>
              允许的项目目录（每行一个；只有位于这些目录下的会话才能被远程接着跑）
              <textarea value={rootsText} onChange={(e) => setRootsText(e.target.value)} rows={3} placeholder={"D:\\Work2"} spellCheck={false} />
            </label>
            <p className="kv">
              远程执行器：
              <b className={remote?.lastError ? "bad" : ""}>
                {remote ? (remote.connected ? "已连接" : remote.lastError ? `未连接（${remote.lastError}）` : form.remoteEnabled ? "连接中…" : "未启用") : "…"}
              </b>
            </p>
            <p className="kv">
              Claude Code hook：<b>{hooks ? (hooks.installed ? "已安装" : "未安装") : "…"}</b>
            </p>
            <div className="btns">
              <button onClick={() => hookAction(true)}>{hooks?.installed ? "重新安装" : "安装 Claude Code hook"}</button>
              <button onClick={() => hookAction(false)} disabled={!hooks?.installed && !hooks?.scriptExists}>
                卸载
              </button>
            </div>
            <p className="kv">
              采集端口 {info?.port ?? 47821}：<b className={info?.collectorError ? "bad" : ""}>{info ? (info.collectorError ?? "正常") : "…"}</b>
            </p>
            <p className="kv">
              上报队列：{info?.forward.queued ?? 0} 条待发{info?.forward.lastError ? `（${info.forward.lastError}）` : ""}
            </p>
          </section>
        )}

        {isAndroid && (
          <section className="box">
            <h2>Android 后台提醒</h2>
            <label className="check">
              <input type="checkbox" checked={bg} onChange={(e) => toggleBg(e.target.checked)} />
              开启后台提醒（前台服务保持连接，完成 / 等待授权时弹通知）
            </label>
            <p className="kv">
              通知权限：<b className={notif ? "" : "bad"}>{notif ? "已允许" : "未允许"}</b>
            </p>
            <div className="btns">
              <button onClick={() => native()?.openBatterySettings()}>电池优化设置</button>
            </div>
            <p className="hint">建议把 AgentHub 设为「不限制」电池使用，否则系统可能在后台杀掉连接。</p>
          </section>
        )}
      </main>
    </div>
  );
}
