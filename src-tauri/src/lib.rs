// 桌面专用模块（托盘、本地采集器、Codex 轮询、上报、窗口跳转）都在 cfg(desktop) 下；
// Android 构建只跑 UI，不编译这些。
#[cfg(desktop)]
mod activity;
#[cfg(desktop)]
mod claude;
#[cfg(desktop)]
mod claude_live;
#[cfg(desktop)]
mod codex;
#[cfg(desktop)]
mod codex_read;
#[cfg(desktop)]
mod doubao;
#[cfg(desktop)]
mod workbuddy;
#[cfg(desktop)]
mod zcode;
#[cfg(desktop)]
mod zcode_exec;
#[cfg(desktop)]
mod collector;
#[cfg(desktop)]
mod config;
#[cfg(desktop)]
mod focus;
#[cfg(desktop)]
mod forwarder;
#[cfg(desktop)]
mod machines;
#[cfg(desktop)]
mod remote;
#[cfg(desktop)]
mod reconcile;
#[cfg(desktop)]
mod runner;
#[cfg(desktop)]
mod message_history;
#[cfg(desktop)]
mod terminal;
#[cfg(desktop)]
mod tray;
#[cfg(desktop)]
mod workdir;

#[cfg(desktop)]
mod desktop {
    use crate::claude::{self, HooksStatus};
    use crate::collector::{self, CollectorStatus};
    use crate::config::{self, Config, SharedConfig};
    use crate::forwarder::{ForwardStatus, Forwarder};
    use crate::remote::{self, RemoteStatus, Status as RemoteInfo};
    use crate::{codex, focus, machines, terminal, tray};
    use serde::Serialize;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex, RwLock};
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
    use tauri_plugin_autostart::MacosLauncher;

    struct AppState {
        config: SharedConfig,
        config_path: PathBuf,
        forwarder: Forwarder,
        collector: CollectorStatus,
        remote: RemoteStatus,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Status {
        collector_error: Option<String>,
        forward: ForwardStatus,
        port: u16,
    }

    #[tauri::command]
    fn get_config(state: State<AppState>) -> Config {
        state.config.read().unwrap().clone()
    }

    #[tauri::command]
    fn set_config(state: State<AppState>, config: Config) -> Result<(), String> {
        let (old_machine, old_url, old_token) = {
            let c = state.config.read().unwrap();
            (c.machine.clone(), c.server_url.clone(), c.token.clone())
        };
        config::save(&state.config_path, &config)?;
        // 改了「本机名称」：服务端按机器名归档会话 / 运行 / 项目目录，旧名下的记录要一起改过去，
        // 不然项目配置的下拉里会多出一台名字已经没人用的电脑
        if old_machine.trim() != config.machine.trim() {
            let url = if config.server_url.trim().is_empty() { old_url } else { config.server_url.clone() };
            let token = if config.token.trim().is_empty() { old_token } else { config.token.clone() };
            machines::spawn_rename(&url, &token, &old_machine, &config.machine);
        }
        *state.config.write().unwrap() = config;
        Ok(())
    }

    #[tauri::command]
    fn get_status(state: State<AppState>) -> Status {
        Status {
            collector_error: state.collector.lock().unwrap().clone(),
            forward: state.forwarder.status(),
            port: collector::PORT,
        }
    }

    #[tauri::command]
    fn remote_status(state: State<AppState>) -> RemoteInfo {
        state.remote.lock().unwrap().clone()
    }

    #[tauri::command]
    fn claude_hooks_status() -> Result<HooksStatus, String> {
        Ok(claude::hooks_status(&claude::default_settings_path()?, &claude::default_hooks_dir()?))
    }

    #[tauri::command]
    fn install_claude_hooks() -> Result<HooksStatus, String> {
        let (s, d) = (claude::default_settings_path()?, claude::default_hooks_dir()?);
        claude::install_hooks(&s, &d)?;
        Ok(claude::hooks_status(&s, &d))
    }

    #[tauri::command]
    fn uninstall_claude_hooks() -> Result<HooksStatus, String> {
        let (s, d) = (claude::default_settings_path()?, claude::default_hooks_dir()?);
        claude::uninstall_hooks(&s, &d)?;
        Ok(claude::hooks_status(&s, &d))
    }

    #[tauri::command]
    fn focus_session(pid: Option<u32>, agent: String, session_key: Option<String>) -> Result<(), String> {
        focus::focus_session(pid, &agent, session_key.as_deref())
    }

    #[tauri::command]
    fn open_in_terminal(agent: String, session_key: String, cwd: String) -> Result<String, String> {
        terminal::open_in_terminal(&agent, &session_key, &cwd)
    }

    #[tauri::command]
    fn set_badge(app: AppHandle, count: u32) {
        let Some(t) = app.tray_by_id("main") else { return };
        let tip = if count == 0 { "AgentHub".to_string() } else { format!("AgentHub：{count} 个待处理") };
        let _ = t.set_tooltip(Some(&tip));
        let icon = if count == 0 { None } else { tray::badge(count) }.or_else(|| app.default_window_icon().cloned());
        if let Some(img) = icon {
            let _ = t.set_icon(Some(img));
        }
    }

    fn show_main(app: &AppHandle) {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
            // 被托盘 / 系统通知唤起时，系统常常拒绝「抢前台」，补一次强制前置
            #[cfg(windows)]
            if let Ok(hwnd) = w.hwnd() {
                let _ = crate::focus::win::bring_to_front(hwnd.0 as _);
            }
        }
    }

    /// 前端在「用户点了系统通知」时调用：把主窗口叫回前台
    #[tauri::command]
    fn show_main_window(app: AppHandle) {
        show_main(&app);
    }

    fn build_tray(app: &AppHandle) -> tauri::Result<()> {
        let open_i = MenuItem::with_id(app, "open", "打开", true, None::<&str>)?;
        let ack_i = MenuItem::with_id(app, "ack-all", "全部标为已处理", true, None::<&str>)?;
        let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&open_i, &ack_i, &PredefinedMenuItem::separator(app)?, &quit_i])?;
        let mut b = TrayIconBuilder::with_id("main")
            .tooltip("AgentHub")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, e| match e.id.as_ref() {
                "open" => show_main(app),
                // 由前端调服务端接口（主窗口隐藏时 webview 仍在运行）
                "ack-all" => {
                    let _ = app.emit("tray-ack-all", ());
                }
                "quit" => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, e| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                    show_main(tray.app_handle());
                }
            });
        if let Some(icon) = app.default_window_icon() {
            b = b.icon(icon.clone());
        }
        b.build(app)?;
        Ok(())
    }

    pub fn run() {
        let silent = std::env::args().any(|a| a == "--silent");
        tauri::Builder::default()
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
            .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--silent"])))
            .plugin(tauri_plugin_notification::init())
            .invoke_handler(tauri::generate_handler![
                get_config,
                set_config,
                get_status,
                remote_status,
                claude_hooks_status,
                install_claude_hooks,
                uninstall_claude_hooks,
                focus_session,
                open_in_terminal,
                set_badge,
                show_main_window
            ])
            .setup(move |app| {
                let config_path = config::config_path(app.path().app_config_dir()?);
                let mut cfg = config::load(&config_path);
                // 老版本在 macOS 上读不到主机名，把本机名兜底成了 "my-pc"，界面上就像多了一台陌生电脑。
                // 换回系统里的真名（访达里显示的那个），并把服务端记在旧名下的记录一起改名。
                let mut pending_rename = None;
                if config::is_legacy_name(&cfg.machine) {
                    let real = config::hostname();
                    if !real.is_empty() && real != cfg.machine {
                        pending_rename = Some((cfg.machine.clone(), real.clone()));
                        cfg.machine = real;
                        let _ = config::save(&config_path, &cfg);
                    }
                }
                let shared: SharedConfig = Arc::new(RwLock::new(cfg));
                if let Some((from, to)) = pending_rename {
                    let c = shared.read().unwrap();
                    machines::spawn_rename(&c.server_url, &c.token, &from, &to);
                }
                let forwarder = Forwarder::new();
                let collector_status: CollectorStatus = Arc::new(Mutex::new(None));
                forwarder.spawn(shared.clone());
                if let Ok(d) = claude::default_hooks_dir() {
                    claude::refresh_script(&d);
                }
                collector::spawn(forwarder.clone(), collector_status.clone());
                codex::spawn(forwarder.clone());
                crate::doubao::spawn(forwarder.clone());
                crate::workbuddy::spawn(forwarder.clone());
                crate::zcode::spawn(forwarder.clone());
                crate::reconcile::spawn(shared.clone());
                let remote_status = remote::spawn(shared.clone());
                app.manage(AppState { config: shared, config_path, forwarder, collector: collector_status, remote: remote_status });
                build_tray(app.handle())?;
                if silent {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.hide();
                    }
                }
                Ok(())
            })
            // 关闭按钮 = 隐藏到托盘，不退出
            .on_window_event(|w, e| {
                if let WindowEvent::CloseRequested { api, .. } = e {
                    api.prevent_close();
                    let _ = w.hide();
                }
            })
            .run(tauri::generate_context!())
            .expect("error while running tauri application");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)]
    desktop::run();
    // Android：只跑 UI，不启动任何桌面采集逻辑
    #[cfg(not(desktop))]
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
