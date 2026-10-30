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

    pub fn focus(pid: Option<u32>, agent: &str) -> Result<(), String> {
        let procs = snapshot();
        if let Some(pid) = pid {
            // 沿父进程链往上找第一个有可见顶层窗口的进程
            let mut cur = pid;
            for _ in 0..10 {
                if let Some(w) = window_of(cur) {
                    return bring_to_front(w);
                }
                match procs.get(&cur) {
                    Some(p) if p.ppid != 0 && p.ppid != cur => cur = p.ppid,
                    _ => break,
                }
            }
            return Err("没找到该会话所在的窗口（可能已经关闭）".into());
        }
        if agent == "codex" {
            // 尽力而为：按可执行名包含 codex 找带窗口的进程（该进程名没有实测过）
            for (pid, p) in &procs {
                if p.exe.to_lowercase().contains("codex") {
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

#[cfg(windows)]
pub fn focus_session(pid: Option<u32>, agent: &str) -> Result<(), String> {
    win::focus(pid, agent)
}

#[cfg(not(windows))]
pub fn focus_session(_pid: Option<u32>, _agent: &str) -> Result<(), String> {
    Err("窗口跳转目前只支持 Windows".into())
}
