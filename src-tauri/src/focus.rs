//! 按进程号找窗口并切到前台（仅 Windows）

#[cfg(windows)]
mod win {
    use std::collections::HashMap;
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, EnumWindows, GetForegroundWindow, GetWindow, GetWindowTextLengthW,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindow, GW_OWNER, SW_RESTORE,
    };

    pub struct Proc {
        pub ppid: u32,
        pub exe: String,
    }

    pub fn snapshot() -> HashMap<u32, Proc> {
        let mut map = HashMap::new();
        unsafe {
            let h = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if h.is_null() || h as isize == -1 {
                return map;
            }
            let mut e: PROCESSENTRY32W = std::mem::zeroed();
            e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut ok = Process32FirstW(h, &mut e);
            while ok != 0 {
                let len = e.szExeFile.iter().position(|c| *c == 0).unwrap_or(e.szExeFile.len());
                let exe = String::from_utf16_lossy(&e.szExeFile[..len]);
                map.insert(e.th32ProcessID, Proc { ppid: e.th32ParentProcessID, exe });
                ok = Process32NextW(h, &mut e);
            }
            windows_sys::Win32::Foundation::CloseHandle(h);
        }
        map
    }

    struct Search {
        pid: u32,
        found: HWND,
    }

    unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let s = &mut *(lparam as *mut Search);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == s.pid
            && IsWindowVisible(hwnd) != 0
            && GetWindow(hwnd, GW_OWNER).is_null()
            && GetWindowTextLengthW(hwnd) > 0
        {
            s.found = hwnd;
            return 0; // 停止枚举
        }
        1
    }

    /// 该进程拥有的可见、无 owner、有标题的顶层窗口
    pub fn window_of(pid: u32) -> Option<HWND> {
        let mut s = Search { pid, found: std::ptr::null_mut() };
        unsafe { EnumWindows(Some(enum_cb), &mut s as *mut Search as LPARAM) };
        (!s.found.is_null()).then_some(s.found)
    }

    pub fn bring_to_front(hwnd: HWND) -> Result<(), String> {
        unsafe {
            if IsIconic(hwnd) != 0 {
                ShowWindow(hwnd, SW_RESTORE);
            }
            if SetForegroundWindow(hwnd) != 0 {
                return Ok(());
            }
            // 被系统拒绝抢前台：临时挂接到当前前台窗口的输入线程再试一次
            let fg = GetForegroundWindow();
            let fg_thread = if fg.is_null() { 0 } else { GetWindowThreadProcessId(fg, std::ptr::null_mut()) };
            let me = GetCurrentThreadId();
            if fg_thread != 0 && fg_thread != me {
                AttachThreadInput(me, fg_thread, 1);
                BringWindowToTop(hwnd);
                let ok = SetForegroundWindow(hwnd);
                AttachThreadInput(me, fg_thread, 0);
                if ok != 0 {
                    return Ok(());
                }
            }
        }
        Err("系统拒绝切换到该窗口".into())
    }

    /// 从 pid 沿父链跳过 shell 进程，返回第一个非 shell 的祖先（通常是 claude.exe）
    fn cmdline(pid: u32) -> Option<String> {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
        let mut sys = System::new();
        let p = Pid::from_u32(pid);
        sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[p]), false, ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always));
        let cmd = sys.process(p)?.cmd();
        Some(cmd.iter().map(|a| a.to_string_lossy()).collect::<Vec<_>>().join(" "))
    }

    /// 从 `claude daemon run ... --spawned-by {"label":"claude","cwd":"...","pid":57584}` 里取 pid
    pub fn spawned_by_pid(cmd: &str) -> Option<u32> {
        if !cmd.contains("daemon run") {
            return None;
        }
        let rest = &cmd[cmd.find("--spawned-by")?..];
        let rest = &rest[rest.find("\"pid\"")? + 5..];
        let digits: String = rest.trim_start_matches([':', ' ', '\\']).chars().take_while(|c| c.is_ascii_digit()).collect();
        digits.parse().ok().filter(|p| *p > 0)
    }

    pub fn stable_pid_in(procs: &HashMap<u32, Proc>, pid: u32) -> u32 {
        const SHELLS: [&str; 6] = ["bash.exe", "sh.exe", "dash.exe", "zsh.exe", "env.exe", "cmd.exe"];
        let mut cur = pid;
        for _ in 0..10 {
            match procs.get(&cur) {
                Some(p) if SHELLS.contains(&p.exe.to_lowercase().as_str()) && procs.contains_key(&p.ppid) => cur = p.ppid,
                _ => break,
            }
        }
        cur
    }

    /// 没有 pid 时，哪些进程算「Codex 窗口所在进程」
    pub fn is_codex_exe(exe: &str) -> bool {
        exe.eq_ignore_ascii_case("ChatGPT.exe") || exe.to_lowercase().contains("codex")
    }

    pub fn focus(pid: Option<u32>, agent: &str) -> Result<(), String> {
        let procs = snapshot();
        if let Some(pid) = pid {
            // 沿父进程链往上找第一个有可见顶层窗口的进程
            let mut cur = pid;
            for _ in 0..16 {
                if let Some(w) = window_of(cur) {
                    return bring_to_front(w);
                }
                // Claude Code 后台会话跑在 `claude daemon run` 下，和终端没有父子关系；
                // daemon 的 --spawned-by 参数里记着启动它的前台 claude 进程号，从那里接着往上找
                if procs.get(&cur).is_some_and(|p| p.exe.eq_ignore_ascii_case("claude.exe")) {
                    if let Some(next) = cmdline(cur).as_deref().and_then(spawned_by_pid) {
                        if next != cur && procs.contains_key(&next) {
                            cur = next;
                            continue;
                        }
                    }
                }
                match procs.get(&cur) {
                    Some(p) if p.ppid != 0 && p.ppid != cur => cur = p.ppid,
                    _ => break,
                }
            }
            return Err("没找到该会话所在的窗口（可能已经关闭）".into());
        }
        if agent == "codex" {
            // Codex Desktop 的窗口进程是 ChatGPT.exe（实测），名字里没有 codex；
            // 其它形态按可执行名包含 codex 兜底。都要求有可见主窗口
            for (pid, p) in &procs {
                if is_codex_exe(&p.exe) {
                    if let Some(w) = window_of(*pid) {
                        return bring_to_front(w);
                    }
                }
            }
            return Err("没找到 Codex 窗口".into());
        }
        Err("这个会话没有记录进程号，无法跳转".into())
    }
}

/// hook 脚本的 bash 进程上报完就退出，之后无法再沿它找父进程；
/// 所以收到上报时（bash 还活着）就换成会话期间一直存在的祖先进程号
#[cfg(windows)]
pub fn stable_pid(pid: u32) -> u32 {
    win::stable_pid_in(&win::snapshot(), pid)
}

#[cfg(not(windows))]
pub fn stable_pid(pid: u32) -> u32 {
    pid
}

#[cfg(windows)]
pub fn focus_session(pid: Option<u32>, agent: &str) -> Result<(), String> {
    win::focus(pid, agent)
}

#[cfg(not(windows))]
pub fn focus_session(_pid: Option<u32>, _agent: &str) -> Result<(), String> {
    Err("窗口跳转目前只支持 Windows".into())
}

#[cfg(all(test, windows))]
mod tests {
    use super::win::{is_codex_exe, spawned_by_pid, stable_pid_in, Proc};
    use std::collections::HashMap;

    #[test]
    fn skips_hook_shells_up_to_claude() {
        let mut m = HashMap::new();
        for (pid, ppid, exe) in [(1, 0, "WindowsTerminal.exe"), (2, 1, "powershell.exe"), (3, 2, "claude.exe"), (4, 3, "bash.exe"), (5, 4, "bash.exe")] {
            m.insert(pid, Proc { ppid, exe: exe.into() });
        }
        assert_eq!(stable_pid_in(&m, 5), 3);
        assert_eq!(stable_pid_in(&m, 3), 3);
        assert_eq!(stable_pid_in(&m, 99), 99);
    }

    #[test]
    fn parses_daemon_spawned_by() {
        let cmd = r#"C:\x\claude.exe daemon run --origin transient --spawned-by {"label":"claude","cwd":"D:\\Play","pid":57584}"#;
        assert_eq!(spawned_by_pid(cmd), Some(57584));
        assert_eq!(spawned_by_pid("claude.exe --session-id abc"), None);
    }

    #[test]
    fn matches_codex_desktop_process() {
        assert!(is_codex_exe("ChatGPT.exe"));
        assert!(is_codex_exe("chatgpt.EXE"));
        assert!(is_codex_exe("codex.exe"));
        assert!(is_codex_exe("Codex Desktop.exe"));
        assert!(!is_codex_exe("chatgpt-helper.exe"));
        assert!(!is_codex_exe("claude.exe"));
        assert!(!is_codex_exe("explorer.exe"));
    }
}
