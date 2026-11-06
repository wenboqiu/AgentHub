import { useCallback, useEffect, useMemo, useState } from "react";
import { Api, type Device, type NotifyKind, type NotifySettings } from "./lib/api";
import Manager from "./Manager";
import Roles from "./Roles";
import Projects from "./Projects";
import Icon from "./Icon";
import { desktop, isAndroid, isDesktop, native, saveConfig, type CollectorInfo, type Config, type HooksStatus, type RemoteInfo } from "./lib/platform";

export const DEFAULT_SERVER = "https://agenthub.wondergarden.top";

const AGENT_LABELS: { key: keyof NotifySettings["agents"]; label: string }[] = [
  { key: "claude", label: "Claude" },
  { key: "codex", label: "Codex" },
  { key: "doubao", label: "豆包" },
  { key: "workbuddy", label: "WorkBuddy" },
  { key: "zcode", label: "ZCode" },
];
const KIND_LABELS: { key: NotifyKind; label: string }[] = [
  { key: "done", label: "会话完成" },
  { key: "aborted", label: "失败 / 中断" },
  { key: "reminder", label: "时间提醒" },
];
const PRIORITY_LABEL: Record<NotifySettings["minPriority"], string> = { low: "不限优先级", medium: "中及以上", high: "仅高优先级" };

/** 登录时上报的设备名：桌面「<machine>（电脑）」，Android「<机型>（手机）」 */
export function deviceName(cfg: Config): string {
  if (isAndroid) {
    // UA 形如 "... (Linux; Android 14; OPPO PHN110 Build/...) ..."；新版 Chrome 会把机型缩成 "K"，那就取不到
    const m = /Android[^;)]*;\s*([^;)]+)/.exec(navigator.userAgent);
    const model = m?.[1]?.replace(/\s*Build\/.*$/, "").trim() ?? "";
    return model.length > 1 ? `${model}（手机）` : "Android 手机";
  }
  if (isDesktop) return `${cfg.machine.trim() || "电脑"}（电脑）`;
  return "浏览器";
}

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 设置页的一级条目：点进去才改细节，列表上先给一句现状 */
function SettingsRow({ icon, title, summary, badge, onClick }: { icon: Parameters<typeof Icon>[0]["name"]; title: string; summary: string; badge?: string; onClick(): void }) {
  return (
    <li>
      <button className="settings-row" onClick={onClick}>
        <span className="sr-icon">
          <Icon name={icon} />
        </span>
        <span className="sr-main">
          <span className="sr-title">
            <strong>{title}</strong>
            {badge && <span className="sr-badge">{badge}</span>}
          </span>
          <span className="sr-sum">{summary}</span>
        </span>
        <Icon name="chevron" />
      </button>
    </li>
  );
}

type Props = {
  cfg: Config;
  /** 已登录时的 API（401 时会通知 App 回到登录页） */
  api: Api | null;
  /** 登录页上方的提示（比如「登录已过期，请重新登录」） */
  notice?: string;
  onClose(): void;
  /** keepOpen：保存设置后留在设置页，不回到主界面 */
  onSaved(c: Config, opts?: { keepOpen?: boolean }): void;
};

/** 设置子页面：一级列表里点进来改细节，返回键回到列表 */
type Page = "root" | "account" | "notify" | "roles" | "projects" | "manager" | "desktop" | "android";

const PAGE_TITLE: Record<Exclude<Page, "root">, string> = {
  account: "账号与安全",
  notify: "通知规则",
  roles: "角色",
  projects: "项目",
  manager: "项目经理",
  desktop: "本机执行与采集",
  android: "Android 后台提醒",
};

export default function Settings({ cfg, api, notice, onClose, onSaved }: Props) {
  const loggedIn = !!cfg.token.trim();
  const [page, setPage] = useState<Page>("root");
  const [form, setForm] = useState<Config>(cfg);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [hooks, setHooks] = useState<HooksStatus | null>(null);
  const [info, setInfo] = useState<CollectorInfo | null>(null);
  const [remote, setRemote] = useState<RemoteInfo | null>(null);
  const [deniedText, setDeniedText] = useState((cfg.deniedRoots ?? []).join("\n"));
  const [autostart, setAutostart] = useState(false);
  const [bg, setBg] = useState(false);
  const [notif, setNotif] = useState(true);
  // 账号级通知规则（Fast Path 过滤管线）
  const [ns, setNs] = useState<NotifySettings | null>(null);
  const [nsMsg, setNsMsg] = useState("");
  // 一级列表上的计数（角色 / 项目各自改完后回来会变）
  const [counts, setCounts] = useState<{ roles: number; projects: number } | null>(null);

  // 登录表单
  const [server, setServer] = useState(cfg.serverUrl || DEFAULT_SERVER);
  const [email, setEmail] = useState(cfg.email ?? "");
  const [password, setPassword] = useState("");
  // 已登录：设备列表、改密码
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");

  const set = <K extends keyof Config>(k: K, v: Config[K]) => setForm((f) => ({ ...f, [k]: v }));

  // 外观类偏好即时保存，不走下方表单的「保存」按钮
  const toggleGraphMode = async (on: boolean) => {
    setForm((f) => ({ ...f, graphMode: on }));
    const c: Config = { ...cfg, graphMode: on };
    try {
      await saveConfig(c);
      onSaved(c, { keepOpen: true });
      setMsg(on ? "对话页已改为气泡图" : "对话页已改为列表");
      window.setTimeout(() => setMsg(""), 2000);
    } catch (e) {
      setMsg(`保存失败：${String(e)}`);
    }
  };

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

  const loadDevices = useCallback(() => {
    api?.devices().then(setDevices, () => {});
  }, [api]);
  useEffect(() => {
    if (loggedIn) loadDevices();
  }, [loggedIn, loadDevices]);

  // 通知规则随登录加载；改动即时保存到服务端，对所有设备生效
  useEffect(() => {
    if (!api) return;
    api.notifySettings().then(setNs).catch(() => {});
  }, [api]);

  // 列表上的条数：回到一级列表时重取，改完角色 / 项目能立刻看到
  useEffect(() => {
    if (!api || page !== "root") return;
    let dead = false;
    Promise.all([api.roles(), api.projects()]).then(
      ([roles, projects]) => {
        if (!dead) setCounts({ roles: roles.length, projects: projects.length });
      },
      () => {},
    );
    return () => {
      dead = true;
    };
  }, [api, page]);

  const saveNs = async (next: NotifySettings) => {
    setNs(next);
    if (!api) return;
    try {
      setNs(await api.saveNotifySettings(next));
      setNsMsg("已保存");
      window.setTimeout(() => setNsMsg(""), 2000);
    } catch (e) {
      setNsMsg(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const login = async () => {
    const url = server.trim().replace(/\/+$/, "");
    if (!url || !email.trim() || !password) return setMsg("请填好服务器地址、邮箱和密码");
    setBusy(true);
    setMsg("登录中…");
    try {
      const r = await Api.login(url, email, password, deviceName(cfg));
      const c: Config = { ...cfg, serverUrl: url, token: r.token, email: r.email };
      await saveConfig(c);
      // Android 后台提醒开着时，用新 token 重启原生服务
      if (isAndroid && native()?.isRunning()) native()?.start(c.serverUrl, c.token);
      setPassword("");
      setMsg("");
      onSaved(c);
    } catch (e) {
      setMsg(`登录失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    try {
      await api?.logout().catch(() => {});
      const c: Config = { ...cfg, token: "", email: "" };
      await saveConfig(c);
      if (isAndroid) native()?.stop();
      onSaved(c);
    } catch (e) {
      setMsg(`退出失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async () => {
    if (!api) return;
    if (newPw.length < 8) return setMsg("新密码至少 8 位");
    if (newPw.length > 200) return setMsg("新密码太长");
    if (newPw !== newPw2) return setMsg("两次输入的新密码不一致");
    setBusy(true);
    try {
      await api.changePassword(oldPw, newPw);
      setOldPw("");
      setNewPw("");
      setNewPw2("");
      setMsg("密码已修改，其它设备需要重新登录");
      loadDevices();
    } catch (e) {
      setMsg(`修改失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const removeDevice = async (d: Device) => {
    if (!api) return;
    try {
      await api.removeDevice(d.id);
      loadDevices();
    } catch (e) {
      setMsg(`移除失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // 黑名单路径按行拆；空列表 = 不限制目录
  const denied = useMemo(
    () => deniedText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
    [deniedText],
  );
  const dirty =
    form.machine.trim() !== cfg.machine.trim() ||
    form.notifyDesktop !== cfg.notifyDesktop ||
    form.remoteEnabled !== cfg.remoteEnabled ||
    JSON.stringify(denied) !== JSON.stringify(cfg.deniedRoots ?? []);

  const save = async () => {
    // 只改设置页管理的字段；服务器地址、token、邮箱以 App 里最新的 cfg 为准
    const c: Config = {
      ...cfg,
      machine: form.machine.trim(),
      notifyDesktop: form.notifyDesktop,
      remoteEnabled: form.remoteEnabled,
      deniedRoots: denied,
    };
    try {
      await saveConfig(c);
      // 留在本页，改动「保存」后不用再点回来
      onSaved(c, { keepOpen: true });
      setMsg("已保存");
      window.setTimeout(() => setMsg(""), 2500);
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
    if (on) n.start(cfg.serverUrl.trim().replace(/\/+$/, ""), cfg.token.trim());
    else n.stop();
    window.setTimeout(() => {
      setBg(n.isRunning());
      setNotif(n.notificationsEnabled());
    }, 500);
    setBg(on);
  };

  // ---------- 未登录：只显示登录表单 ----------
  if (!loggedIn) {
    return (
      <div className="app settings">
        <header>
          <h1>登录 AgentHub</h1>
        </header>
        <main>
          {notice && <p className="msg bad">{notice}</p>}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void login();
            }}
          >
            <label>
              服务器地址
              <input value={server} onChange={(e) => setServer(e.target.value)} placeholder={DEFAULT_SERVER} autoCapitalize="off" autoCorrect="off" />
            </label>
            <label>
              邮箱
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoCapitalize="off" autoCorrect="off" autoComplete="username" />
            </label>
            <label>
              密码
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </label>
            <div className="btns">
              <button className="primary" type="submit" disabled={busy}>
                登录
              </button>
            </div>
          </form>
          {msg && <p className="msg">{msg}</p>}
          <p className="hint">没有注册入口，账号由管理员创建。</p>
        </main>
      </div>
    );
  }

  // ---------- 一级列表上的现状摘要 ----------
  const host = (() => {
    try {
      return new URL(cfg.serverUrl).host;
    } catch {
      return cfg.serverUrl;
    }
  })();
  const mutedAgents = ns ? AGENT_LABELS.filter(({ key }) => !ns.agents[key]).length : 0;
  const quiet = ns?.quiet.enabled ? `免打扰 ${ns.quiet.start}–${ns.quiet.end}` : "免打扰关闭";
  const notifySummary = ns
    ? [mutedAgents > 0 ? `静音 ${mutedAgents} 个 agent` : "全部 agent 提醒", quiet, PRIORITY_LABEL[ns.minPriority]].join(" · ")
    : "加载中…";
  const desktopSummary = [
    form.remoteEnabled ? "远程执行已开启" : "远程执行关闭",
    denied.length > 0 ? `禁止 ${denied.length} 个目录` : "目录不限制",
    hooks ? (hooks.installed ? "hook 已安装" : "hook 未安装") : "hook …",
  ].join(" · ");
  const countText = (n: number | undefined, unit: string) => (counts ? `${n} ${unit}` : "");

  // 返回固定在左边（和任务 / 会话详情页一致）：一级列表回主界面，子页面回列表
  const back = (
    <button className="back-button" onClick={() => (page === "root" ? onClose() : (setPage("root"), setMsg("")))}>
      <Icon name="back" />
      返回
    </button>
  );

  return (
    <div className="app settings">
      <header>
        {back}
        <h1>{page === "root" ? "设置" : PAGE_TITLE[page]}</h1>
      </header>
      <main>
        {notice && <p className="msg bad">{notice}</p>}

        {page === "root" && (
          <>
            <h2>账号</h2>
            <ul className="settings-list">
              <SettingsRow icon="user" title="账号与安全" summary={`${cfg.email || "（未知邮箱）"} · ${host}`} badge="已登录" onClick={() => setPage("account")} />
              <SettingsRow icon="bell" title="通知规则" summary={notifySummary} onClick={() => setPage("notify")} />
            </ul>

            <h2>派活</h2>
            <ul className="settings-list">
              <SettingsRow icon="people" title="角色" summary="执行工具、模型与上下文，按项目攒经验" badge={countText(counts?.roles, "个")} onClick={() => setPage("roles")} />
              <SettingsRow icon="folder" title="项目" summary="项目说明、约定与各台电脑上的目录，派活时带给执行端" badge={countText(counts?.projects, "个")} onClick={() => setPage("projects")} />
              <SettingsRow icon="board" title="项目经理" summary="把处理意见排成任务单，按限额派出确认过的任务" onClick={() => setPage("manager")} />
            </ul>

            {(isDesktop || isAndroid) && (
              <>
                <h2>本机</h2>
                <ul className="settings-list">
                  {isDesktop && <SettingsRow icon="desktop" title="本机执行与采集" summary={desktopSummary} onClick={() => setPage("desktop")} />}
                  {isAndroid && (
                    <SettingsRow
                      icon="phone"
                      title="Android 后台提醒"
                      summary={`${bg ? "后台提醒已开启" : "后台提醒已关闭"} · 通知权限${notif ? "已允许" : "未允许"}`}
                      onClick={() => setPage("android")}
                    />
                  )}
                </ul>
              </>
            )}

            <h2>外观</h2>
            <section className="box">
              <label>
                对话页展示方式
                <select value={form.graphMode ? "graph" : "list"} onChange={(e) => void toggleGraphMode(e.target.value === "graph")}>
                  <option value="graph">气泡图（默认）</option>
                  <option value="list">列表</option>
                </select>
              </label>
              <p className="hint">
                {form.graphMode
                  ? "气泡图：待处理 / 进行中的对话按项目聚成气泡，点一下展开会话。"
                  : "列表：待处理 / 进行中的对话按状态分行平铺，一条一行。"}
              </p>
              {msg && <p className="msg">{msg}</p>}
            </section>
          </>
        )}

        {page === "account" && (
          <>
            <section className="box">
              <p className="kv">
                邮箱：<b>{cfg.email || "（未知）"}</b>
              </p>
              <p className="kv">
                服务器：<b>{cfg.serverUrl}</b>
              </p>
              <div className="btns">
                <button onClick={logout} disabled={busy}>
                  退出登录
                </button>
              </div>
            </section>

            <section className="box">
              <h2>修改密码</h2>
              <label>
                旧密码
                <input type="password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} autoComplete="current-password" />
              </label>
              <label>
                新密码（8 位以上）
                <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" />
              </label>
              <label>
                再输一次新密码
                <input type="password" value={newPw2} onChange={(e) => setNewPw2(e.target.value)} autoComplete="new-password" />
              </label>
              <div className="btns">
                <button className="primary" onClick={changePassword} disabled={busy || !oldPw || !newPw}>
                  修改密码
                </button>
              </div>
              {msg && <p className="msg">{msg}</p>}
            </section>

            <section className="box">
              <h2>已登录设备</h2>
              {devices === null && <p className="hint">加载中…</p>}
              <ul className="devices">
                {(devices ?? []).map((d) => (
                  <li key={d.id}>
                    <span className="dev-name">
                      {d.device || "未知设备"}
                      {d.current && <span className="tag claude">本机</span>}
                    </span>
                    <span className="dev-time">最近使用 {fmtTime(d.lastUsedAt)}</span>
                    {!d.current && (
                      <button className="link" onClick={() => removeDevice(d)}>
                        移除
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}

        {page === "notify" && (
          <section className="box">
            <p className="hint">在服务端统一过滤要弹的通知，对所有设备生效；等待授权和审批请求永远提醒，不受规则影响。</p>
            {!ns ? (
              <p className="hint">加载中…</p>
            ) : (
              <>
                <h3>按 agent 通知</h3>
                {AGENT_LABELS.map(({ key, label }) => (
                  <label className="check" key={key}>
                    <input
                      type="checkbox"
                      checked={ns.agents[key]}
                      onChange={(e) => saveNs({ ...ns, agents: { ...ns.agents, [key]: e.target.checked } })}
                    />
                    {label}
                  </label>
                ))}
                <h3>最低优先级</h3>
                <label>
                  会话事件要求关联任务达到的优先级（未关联任务的会话按中优先级处理）
                  <select value={ns.minPriority} onChange={(e) => saveNs({ ...ns, minPriority: e.target.value as NotifySettings["minPriority"] })}>
                    <option value="low">不限（全部提醒）</option>
                    <option value="medium">中及以上</option>
                    <option value="high">仅高优先级</option>
                  </select>
                </label>
                <h3>免打扰时段</h3>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={ns.quiet.enabled}
                    onChange={(e) =>
                      saveNs({
                        ...ns,
                        quiet: { ...ns.quiet, enabled: e.target.checked, tzOffsetMinutes: e.target.checked ? -new Date().getTimezoneOffset() : ns.quiet.tzOffsetMinutes },
                      })
                    }
                  />
                  启用免打扰（静音下面勾选的类型）
                </label>
                {ns.quiet.enabled && (
                  <>
                    <label>
                      开始{" "}
                      <input type="time" value={ns.quiet.start} onChange={(e) => saveNs({ ...ns, quiet: { ...ns.quiet, start: e.target.value } })} />
                      {" "}结束{" "}
                      <input type="time" value={ns.quiet.end} onChange={(e) => saveNs({ ...ns, quiet: { ...ns.quiet, end: e.target.value } })} />
                    </label>
                    {KIND_LABELS.map(({ key, label }) => (
                      <label className="check" key={key}>
                        <input
                          type="checkbox"
                          checked={ns.quiet.muteKinds.includes(key)}
                          onChange={(e) =>
                            saveNs({
                              ...ns,
                              quiet: {
                                ...ns.quiet,
                                muteKinds: e.target.checked ? [...ns.quiet.muteKinds, key] : ns.quiet.muteKinds.filter((k) => k !== key),
                              },
                            })
                          }
                        />
                        静音：{label}
                      </label>
                    ))}
                    <p className="hint">开始等于结束视为全天静音。免打扰只作用于勾选的类型；失败 / 中断建议保留提醒。</p>
                  </>
                )}
                {nsMsg && <p className="msg">{nsMsg}</p>}
              </>
            )}
          </section>
        )}

        {page === "roles" && api && <Roles api={api} />}

        {page === "projects" && api && <Projects api={api} />}

        {page === "manager" && api && <Manager api={api} />}

        {page === "desktop" && isDesktop && (
          <>
            <section className="box">
              <h2>本机</h2>
              <label>
                本机名称（machine；下次登录时作为设备名）
                <input value={form.machine} onChange={(e) => set("machine", e.target.value)} />
              </label>
              <label className="check">
                <input type="checkbox" checked={form.notifyDesktop} onChange={(e) => set("notifyDesktop", e.target.checked)} />
                会话完成 / 等待授权时弹桌面通知
              </label>
              <label className="check">
                <input type="checkbox" checked={autostart} onChange={(e) => toggleAutostart(e.target.checked)} />
                开机自启（静默启动到托盘）
              </label>
              <label className="check">
                <input type="checkbox" checked={form.remoteEnabled} onChange={(e) => set("remoteEnabled", e.target.checked)} />
                允许手机远程执行（每次授权仍要在手机上确认）
              </label>

              <h3>禁止执行的目录（黑名单）</h3>
              <p className="hint">
                当前是<b>黑名单</b>模式：留空 = 不限制目录，任何目录都能派活；填了则列在这里的目录<b>及其子目录</b>一律拒绝执行，其它目录正常。
              </p>
              <textarea
                value={deniedText}
                onChange={(e) => setDeniedText(e.target.value)}
                rows={3}
                placeholder={"每行一个目录，留空不限制；例如 D:\\Work2\\Secret"}
                spellCheck={false}
              />
              <p className="hint">
                {denied.length > 0 ? `已禁止 ${denied.length} 个目录：这些目录下的任务和会话会被执行端直接拒绝。` : "当前目录不限制：没有任何目录被禁止。"}
              </p>

              <div className="btns">
                <button className="primary" onClick={save} disabled={!dirty}>
                  保存
                </button>
              </div>
              <p className="hint">改动保存后立即生效；执行器会在几秒内用新配置重连。</p>
              {msg && <p className="msg">{msg}</p>}
            </section>

            <section className="box">
              <h2>运行状态</h2>
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

            <section className="box">
              <h2>采集说明</h2>
              <p className="hint">豆包客户端状态监听（实验性）随 AgentHub 自动启动。读取本机标准目录中的生命周期日志，每 2 秒检查一次；暂不支持完整对话、授权和远程续聊。</p>
              <p className="hint">WorkBuddy 会话监听随 AgentHub 自动启动。只读 <code>%USERPROFILE%\.workbuddy\projects</code> 下的会话记录，每 2 秒检查一次，可显示对话标题、目录、运行中与完成状态；完成状态在「回复结束 + 无未完成工具调用 + 静默确认」后判定。打开会话详情时会把本地对话记录同步过来（只读），授权与远程续聊仍不支持。</p>
            </section>
          </>
        )}

        {page === "android" && isAndroid && (
          <section className="box">
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
            {msg && <p className="msg">{msg}</p>}
          </section>
        )}
      </main>
    </div>
  );
}
