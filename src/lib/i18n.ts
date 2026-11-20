import { useEffect, useState } from "react";

/**
 * 前端多语言：默认英文，可切中文。
 * key 直接用中文原文 —— 中文模式原样返回，英文查词典、查不到回退中文原文。
 * 这样可以分阶段迁移：没接进来的字符串在英文模式下先显示中文，不会崩。
 */
export type Lang = "en" | "zh";
const STORE_KEY = "agenthub.lang";

/** 语言显示名（语言列表里保持原文，不翻译） */
export const LANG_LABEL: Record<Lang, string> = { en: "English", zh: "中文" };

// ---- 英文词典 ----
const en: Record<string, string> = {
  // 导航与页头
  "会话": "Sessions",
  "任务": "Tasks",
  "目标": "Goals",
  "日历": "Calendar",
  "统计": "Stats",
  "设置": "Settings",
  "已连接": "Connected",
  "连接中…": "Connecting…",
  "已断开，重连中": "Disconnected, reconnecting",
  "未配置服务器": "No server configured",
  "工作空间": "Workspace",
  "关注运行进展，及时处理需要你的事项。": "Track progress and handle what needs you in time.",
  "全部标为已处理": "Mark all handled",
  "待处理": "Pending",
  "{n} 运行中": "{n} running",
  "没有待处理或运行中的会话": "No pending or running sessions",
  "没有待处理的会话": "No pending sessions",
  "没有运行中的会话": "No running sessions",
  "其它（{n}）": "Others ({n})",
  "内部会话（{n}）": "Internal sessions ({n})",
  "AgentHub 自己开的：角色助手造角色、意见细化写任务单。点开能看到发给 agent 的指令原文。": "Opened by AgentHub itself: the role assistant creates roles and refines ideas into task briefs. Open one to see the exact instructions sent to the agent.",
  "历史会话": "History",
  "（{n}）": "({n})",
  "已结束或超过 24 小时的会话；库里保留最近 30 天，点开就能看对话正文。": "Sessions that ended or have been idle for over 24 hours; the server keeps the last 30 days — open one to read the full conversation.",
  "展开后读取…": "Loaded on expand…",
  "没有更早的会话": "No earlier sessions",
  "空": "Empty",
  "重试": "Retry",
  "关闭": "Close",
  "保存": "Save",
  "取消": "Cancel",
  "删除": "Delete",
  "确认": "Confirm",
  "加载中…": "Loading…",
  "返回": "Back",
  "搜索": "Search",
  "没有更多了": "No more",
  "暂无": "None",
  "版本 {v}": "Version {v}",
  "主要功能": "Primary",
  "{n} 件等你处理": "{n} items need you",
  "这个任务已经不存在了": "This task no longer exists",
  "这个目标已经不存在了": "This goal no longer exists",
  // 会话列表
  "（未知项目）": "(unknown project)",
  "打开会话": "Open session",
  "：{title}": ": {title}",
  "待授权": "Approval",
  "点击展开/收起": "Click to expand/collapse",
  "跳转": "Focus",
  "标为已处理": "Mark handled",
  "{ago}完成": "Completed {ago}",
  "{ago}开始等待授权": "Waiting for approval since {ago}",
  "{ago}中断": "Aborted {ago}",
  "{ago}开始运行": "Running since {ago}",
  "{ago}结束": "Ended {ago}",
  "{ago}登记": "Registered {ago}",
  "本机记录缺失，状态未知": "No local record; state unknown",
  "可能卡住了": "may be stuck",
  "反复失败": "keeps failing",
  "运行中超过 45 分钟没有新事件，点开看看要不要处理。{brief}": "Running for over 45 minutes with no new events. Open to check on it. {brief}",
  "短时间内多次中断，点开看看要不要处理。{brief}": "Aborted several times in a short period. Open to check on it. {brief}",
  "开始时间到了": "Start time reached",
  "已到截止时间": "Past due",
  "请求授权": "Approval requested",
  // 会话侧栏
  "进行中": "In progress",
  "已处理": "Handled",
  "等你处理": "needs you",
  "在跑": "running",
  "历史": "history",
  "AgentHub 自己开的": "opened by AgentHub",
  "会话列表": "Session list",
  "关闭会话列表": "Close session list",
  "收起会话列表": "Collapse session list",
  "还没有会话": "No sessions yet",
  "{n} 个后台任务": "{n} background tasks",
  "调整会话列表宽度": "Resize session list",
  "拖动调整宽度，双击恢复默认": "Drag to resize, double-click to reset",
  // 设置页
  "豆包": "Doubao",
  "会话完成": "Session done",
  "失败 / 中断": "Failure / abort",
  "时间提醒": "Time reminder",
  "不限优先级": "Any priority",
  "中及以上": "Medium and up",
  "仅高优先级": "High only",
  "对话页已改为气泡图": "Session view switched to bubbles",
  "对话页已改为列表": "Session view switched to list",
  "保存失败：{e}": "Save failed: {e}",
  "已保存": "Saved",
  "请填好服务器地址、邮箱和密码": "Fill in the server URL, email and password",
  "登录中…": "Signing in…",
  "登录失败：{e}": "Sign-in failed: {e}",
  "退出失败：{e}": "Sign-out failed: {e}",
  "新密码至少 8 位": "New password must be at least 8 characters",
  "新密码太长": "New password is too long",
  "两次输入的新密码不一致": "The two new passwords do not match",
  "密码已修改，其它设备需要重新登录": "Password changed. Other devices need to sign in again.",
  "修改失败：{e}": "Change failed: {e}",
  "移除失败：{e}": "Removal failed: {e}",
  "已安装 Claude Code hook（原 settings.json 已备份为 settings.json.agenthub-bak）": "Claude Code hook installed (your settings.json was backed up as settings.json.agenthub-bak)",
  "已卸载 Claude Code hook": "Claude Code hook uninstalled",
  "当前环境没有 Android 原生桥": "No Android native bridge in this environment",
  "登录 AgentHub": "Sign in to AgentHub",
  "服务器地址": "Server URL",
  "邮箱": "Email",
  "密码": "Password",
  "登录": "Sign in",
  "没有注册入口，账号由管理员创建。": "There is no sign-up page; accounts are created by the administrator.",
  "免打扰 {a}–{b}": "Quiet {a}–{b}",
  "免打扰关闭": "Quiet hours off",
  "静音 {n} 个 agent": "{n} agents muted",
  "全部 agent 提醒": "All agents notify",
  "远程执行已开启": "Remote execution on",
  "远程执行关闭": "Remote execution off",
  "禁止 {n} 个目录": "{n} directories blocked",
  "目录不限制": "No directory restrictions",
  "hook 已安装": "hook installed",
  "hook 未安装": "hook not installed",
  "hook …": "hook …",
  "{n} 个": "{n}",
  "新建角色": "New role",
  "新建项目": "New project",
  "账号": "Account",
  "账号与安全": "Account & security",
  "（未知邮箱）": "(unknown email)",
  "已登录": "Signed in",
  "通知规则": "Notification rules",
  "设备": "Devices",
  "派活": "Dispatch",
  "角色": "Roles",
  "执行工具、模型与上下文，按项目攒经验": "Executors, models and context — experience accrues per project",
  "项目": "Projects",
  "项目说明、约定与各台电脑上的目录，派活时带给执行端": "Project brief, conventions and per-machine directories, passed to executors on dispatch",
  "项目经理": "Project manager",
  "把处理意见排成任务单，按限额派出确认过的任务": "Turns your decisions into task briefs and dispatches confirmed tasks within quotas",
  "本机": "This machine",
  "本机执行与采集": "Local execution & collection",
  "Android 后台提醒": "Android background alerts",
  "后台提醒已开启": "Background alerts on",
  "后台提醒已关闭": "Background alerts off",
  "通知权限": "Notification permission ",
  "已允许": "granted",
  "未允许": "denied",
  "外观": "Appearance",
  "agent 头像": "Agent avatars",
  "对话页展示方式": "Session view",
  "气泡图（默认）": "Bubbles (default)",
  "列表": "List",
  "气泡图：待处理 / 进行中的对话按项目聚成气泡，点一下展开会话。": "Bubbles: pending / running sessions cluster into per-project bubbles; tap one to expand.",
  "列表：待处理 / 进行中的对话按状态分行平铺，一条一行。": "List: pending / running sessions laid out one per row by state.",
  "界面语言": "Language",
  "切换后立即生效；还没翻译完的部分会暂时保持中文。": "Takes effect immediately; parts not yet translated stay in Chinese for now.",
  "邮箱：": "Email: ",
  "（未知）": "(unknown)",
  "服务器：": "Server: ",
  "退出登录": "Sign out",
  "旧密码": "Current password",
  "新密码（8 位以上）": "New password (8+ characters)",
  "再输一次新密码": "Repeat new password",
  "已登录设备": "Signed-in devices",
  "未知设备": "Unknown device",
  "最近使用 {time}": "Last used {time}",
  "移除": "Remove",
  "在服务端统一过滤要弹的通知，对所有设备生效；等待授权和审批请求永远提醒，不受规则影响。": "Notification rules are filtered on the server and apply to every device. Approval requests always notify, regardless of rules.",
  "按 agent 通知": "Notify by agent",
  "最低优先级": "Minimum priority",
  "会话事件要求关联任务达到的优先级（未关联任务的会话按中优先级处理）": "Sessions must relate to a task at or above this priority to notify (sessions without a task count as medium)",
  "不限（全部提醒）": "Any (notify all)",
  "免打扰时段": "Quiet hours",
  "启用免打扰（静音下面勾选的类型）": "Enable quiet hours (mutes the kinds checked below)",
  "开始": "Start",
  "结束": "End",
  "静音：{label}": "Mute: {label}",
  "开始等于结束视为全天静音。免打扰只作用于勾选的类型；失败 / 中断建议保留提醒。": "Start equals end means all-day quiet. Quiet hours only apply to the checked kinds; keep failure / abort notifications on.",
  "本机名称（派活时按它认电脑；改名后服务端旧记录会一起迁到新名下）": "Machine name (dispatch matches computers by it; renaming migrates the server's old records too)",
  "会话完成 / 等待授权时弹桌面通知": "Desktop notification when a session finishes / waits for approval",
  "开机自启（静默启动到托盘）": "Start at login (silently to tray)",
  "允许手机远程执行（每次授权仍要在手机上确认）": "Allow remote execution from the phone (each approval still confirmed on the phone)",
  "关掉后这台电脑仍显示「开着，没开远程执行」，派给它的单会排队，直到这里重新打开。": "With this off, the machine still shows \"online, remote execution off\" and tasks queued for it wait until you turn it back on.",
  "在客户端处理 Claude 终端的权限确认": "Handle Claude terminal permission prompts in the app",
  "允许在客户端远程放行（风险：手机上点允许就会在电脑上执行）": "Allow remote approval in the app (risk: tapping Allow on the phone runs it on this computer)",
  "开启后，终端里的 Claude 弹出权限确认时，客户端会出现一张审批卡，最多等 25 秒；没人处理就回到终端原生确认框。只开第一项时，客户端只能点「拒绝」。": "When Claude in a terminal asks for permission, an approval card appears in the app for up to 25 seconds; if nobody answers, the terminal's native prompt returns. With only the first option on, the app can only Deny.",
  "禁止执行的目录（黑名单）": "Denied directories (blacklist)",
  "当前是": "This is a ",
  "黑名单": "blacklist",
  "模式：留空 = 不限制目录，任何目录都能派活；填了则列在这里的目录": ": leave empty for no restrictions; listed directories",
  "及其子目录": " and their subdirectories",
  "一律拒绝执行，其它目录正常。": " are always denied; everything else runs normally.",
  "每行一个目录，留空不限制；例如 D:\\\\Work2\\\\Secret": "One directory per line, empty = no restrictions; e.g. D:\\\\Work2\\\\Secret",
  "已禁止 {n} 个目录：这些目录下的任务和会话会被执行端直接拒绝。": "{n} directories blocked: tasks and sessions under them are rejected outright by the executor.",
  "当前目录不限制：没有任何目录被禁止。": "No directory restrictions: nothing is blocked.",
  "ZCode 自动放行": "ZCode auto-approval",
  "ZCode 权限请求的自动放行档位": "Auto-approval level for ZCode permission requests",
  "关闭：每条都要确认": "Off: confirm every request",
  "放行低风险（默认）": "Auto-approve low risk (default)",
  "放行中低风险": "Auto-approve medium and low risk",
  "档位内的请求直接放行并在会话里留痕，不弹审批卡；高风险与致命风险永远弹卡等你确认，ZCode 没标风险等级的也不放。": "Requests within the level run immediately and are logged in the session without an approval card; high and critical risk always asks, and requests without a risk label are never auto-approved.",
  "改动保存后立即生效；执行器会在几秒内用新配置重连。": "Changes take effect on save; the executor reconnects with the new config within seconds.",
  "运行状态": "Runtime status",
  "远程执行器：": "Remote executor: ",
  "未连接（{e}）": "Not connected ({e})",
  "未启用": "Disabled",
  "Claude Code hook：": "Claude Code hook: ",
  "未安装": "Not installed",
  "重新安装": "Reinstall",
  "安装 Claude Code hook": "Install Claude Code hook",
  "卸载": "Uninstall",
  "采集端口 {port}：": "Collection port {port}: ",
  "正常": "OK",
  "上报队列：{n} 条待发": "Report queue: {n} pending",
  "（{e}）": " ({e})",
  "采集说明": "Collection notes",
  "豆包客户端状态监听（实验性）随 AgentHub 自动启动。读取本机标准目录中的生命周期日志，每 2 秒检查一次；暂不支持完整对话、授权和远程续聊。": "Doubao client state listening (experimental) starts with AgentHub. It reads lifecycle logs from the standard local directory every 2 seconds; full conversation, approvals and remote follow-up are not supported yet.",
  "WorkBuddy 会话监听随 AgentHub 自动启动。只读": "WorkBuddy session listening starts with AgentHub. It reads ",
  "下的会话记录，每 2 秒检查一次，可显示对话标题、目录、运行中与完成状态；完成状态在「回复结束 + 无未完成工具调用 + 静默确认」后判定。打开会话详情时会把本地对话记录同步过来（只读），授权与远程续聊仍不支持。": " session records every 2 seconds, showing titles, directories and running / done states; done is decided by \"reply ended + no pending tool calls + silence confirmed\". Opening a session syncs the local transcript (read-only); approvals and remote follow-up are not supported.",
  "CodeBuddy 命令行版（npm 全局包": "CodeBuddy CLI (npm package ",
  "）与 WorkBuddy 是同一份 CLI，记录落在": ") is the same CLI as WorkBuddy; records live in ",
  "，用同一套规则监听；派活时用本机 node 跑它自己的登录态，装了它才会出现在角色的候选电脑里。": " and are listened to with the same rules; dispatch runs it with local node and its own login state — it only appears as a candidate machine once installed.",
  "开启后台提醒（前台服务保持连接，完成 / 等待授权时弹通知）": "Background alerts on (a foreground service keeps the connection and notifies on completion / approval requests)",
  "通知权限：": "Notification permission: ",
  "电池优化设置": "Battery optimization settings",
  "建议把 AgentHub 设为「不限制」电池使用，否则系统可能在后台杀掉连接。": "Set AgentHub to \"Unrestricted\" battery use, or the system may kill the connection in the background.",
  // 状态
  "等待授权": "Waiting for approval",
  "已完成": "Done",
  "已中断": "Aborted",
  "空闲": "Idle",
  "未知": "Unknown",
};

let current: Lang = (() => {
  try { return localStorage.getItem(STORE_KEY) === "zh" ? "zh" : "en"; }
  catch { return "en"; }
})();

const listeners = new Set<() => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(l: Lang): void {
  if (l === current) return;
  current = l;
  try { localStorage.setItem(STORE_KEY, l); } catch { /* 隐私模式等存不了就算了 */ }
  listeners.forEach(f => f());
}

/** 订阅语言变化：挂在组件树根部一处即可，变化时整棵树重渲染 */
export function useLang(): Lang {
  const [lang, set] = useState<Lang>(current);
  useEffect(() => {
    const f = () => set(current);
    listeners.add(f);
    return () => { listeners.delete(f); };
  }, []);
  return lang;
}

type Vars = Record<string, string | number>;

export function t(key: string, vars?: Vars): string {
  let s = current === "en" ? (en[key] ?? key) : key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
