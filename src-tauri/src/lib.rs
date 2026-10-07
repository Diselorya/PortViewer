mod attribution;
mod commands;
mod error;
mod network;
mod process;

use attribution::AttributionResolver;
pub use process::resolver::ProcessResolver;

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use commands::build_identity::get_build_identity;
use commands::kill_process::kill_process;
use commands::privilege::{get_privilege_status, restart_elevated};
use commands::save_export::save_export;
use commands::scan_ports::{enrich_ports, scan_all_ports};

pub struct BackendState {
    pub(crate) resolver: Arc<ProcessResolver>,
    pub(crate) attribution_resolver: Arc<AttributionResolver>,
    pub(crate) scan_running: Arc<AtomicBool>,
}

/// Headless WebGUI adapter for Windows. The separate cross-platform web
/// service consumes JSON so the Tauri-only internal types remain private.
pub fn scan_for_web_json() -> Result<serde_json::Value, String> {
    let resolver = ProcessResolver::new();
    let attribution_resolver = AttributionResolver::new();
    let result = commands::scan_ports::scan_for_web(&resolver, &attribution_resolver)
        .map_err(|error| error.to_string())?;
    serde_json::to_value(result).map_err(|error| format!("无法序列化扫描结果：{error}"))
}

/// Fast headless adapter used by the LAN occupancy API. It deliberately skips
/// Docker/Nginx/IIS/runtime attribution; the API discards process fields for
/// anonymous callers and only uses endpoint ownership to decide occupancy.
pub fn scan_basic_for_web_json() -> Result<serde_json::Value, String> {
    let resolver = ProcessResolver::new();
    let result =
        commands::scan_ports::scan_basic_for_web(&resolver).map_err(|error| error.to_string())?;
    serde_json::to_value(result).map_err(|error| format!("无法序列化基础扫描结果：{error}"))
}

pub fn build_identity_for_web_json() -> Result<serde_json::Value, String> {
    serde_json::to_value(get_build_identity())
        .map_err(|error| format!("无法序列化构建身份：{error}"))
}

impl BackendState {
    fn new() -> Self {
        Self {
            resolver: Arc::new(ProcessResolver::new()),
            attribution_resolver: Arc::new(AttributionResolver::new()),
            scan_running: Arc::new(AtomicBool::new(false)),
        }
    }
}

/// 注册所有 Tauri IPC 命令并启动应用。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(BackendState::new())
        .invoke_handler(tauri::generate_handler![
            get_build_identity,
            scan_all_ports,
            enrich_ports,
            kill_process,
            get_privilege_status,
            restart_elevated,
            save_export,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
