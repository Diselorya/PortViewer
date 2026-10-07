#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "linux")]
pub use linux::scan;

#[cfg(target_os = "linux")]
pub fn scan_basic() -> Result<serde_json::Value, String> {
    linux::scan()
}

#[cfg(windows)]
pub fn scan() -> Result<serde_json::Value, String> {
    portviewer_lib::scan_for_web_json()
}

#[cfg(windows)]
pub fn scan_basic() -> Result<serde_json::Value, String> {
    portviewer_lib::scan_basic_for_web_json()
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn scan() -> Result<serde_json::Value, String> {
    Err(format!(
        "当前 WebGUI 服务不支持 {} 平台",
        std::env::consts::OS
    ))
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn scan_basic() -> Result<serde_json::Value, String> {
    scan()
}
