use std::collections::HashMap;
use std::mem::size_of;
use std::sync::Mutex;

use windows::core::{Error, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, ERROR_NOT_FOUND, FILETIME, HANDLE,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_ACCESS_RIGHTS,
    PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::network::types::ProcessStatus;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessInfo {
    pub name: Option<String>,
    pub path: Option<String>,
    pub created_at: Option<String>,
    pub status: ProcessStatus,
    pub status_message: Option<String>,
}

/// 缓存生命周期由 `begin_scan` 明确限定为单次扫描，避免 PID 复用污染后续快照。
pub struct ProcessResolver {
    cache: Mutex<HashMap<u32, ProcessInfo>>,
    toolhelp_names: Mutex<Option<HashMap<u32, String>>>,
}

impl ProcessResolver {
    pub fn new() -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
            toolhelp_names: Mutex::new(None),
        }
    }

    pub fn begin_scan(&self) {
        self.cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        *self
            .toolhelp_names
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }

    pub fn resolve(&self, pid: u32) -> ProcessInfo {
        if let Some(info) = self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&pid)
            .cloned()
        {
            return info;
        }

        let info = self.resolve_fresh(pid);
        self.cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(pid, info.clone());
        info
    }

    /// 绕过缓存重新读取身份，供详情查询和安全边界使用。
    pub fn resolve_fresh(&self, pid: u32) -> ProcessInfo {
        if pid == 0 {
            return system_process_info("System Idle Process");
        }
        if pid == 4 {
            return system_process_info("System");
        }

        let handle = match ProcessHandle::open(pid, PROCESS_QUERY_LIMITED_INFORMATION) {
            Ok(handle) => handle,
            Err(error) => {
                let name = self.toolhelp_process_name(pid);
                return unavailable_process_info(error, name);
            }
        };

        let path_result = get_process_image_path(&handle);
        let created_at = get_process_creation_time(&handle);
        let (path, name, path_error) = match path_result {
            Ok(path) => {
                let name = process_name_from_path(&path);
                (Some(path), name, None)
            }
            Err(error) => (None, None, Some(error.to_string())),
        };

        let status = if path_error.is_none() && created_at.is_some() {
            ProcessStatus::Available
        } else {
            ProcessStatus::Partial
        };
        let status_message = match (path_error, created_at.is_none()) {
            (Some(error), true) => Some(format!("无法读取进程路径和创建时间：{error}")),
            (Some(error), false) => Some(format!("无法读取进程路径：{error}")),
            (None, true) => Some("无法读取进程创建时间".to_string()),
            (None, false) => None,
        };

        ProcessInfo {
            name,
            path,
            created_at,
            status,
            status_message,
        }
    }

    fn toolhelp_process_name(&self, pid: u32) -> Option<String> {
        let mut names = self
            .toolhelp_names
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let names = names.get_or_insert_with(toolhelp_process_names);
        names.get(&pid).cloned()
    }
}

impl Default for ProcessResolver {
    fn default() -> Self {
        Self::new()
    }
}

fn system_process_info(name: &str) -> ProcessInfo {
    ProcessInfo {
        name: Some(name.to_string()),
        path: None,
        created_at: None,
        status: ProcessStatus::System,
        status_message: Some("系统进程不提供可终止身份".to_string()),
    }
}

fn unavailable_process_info(error: Error, fallback_name: Option<String>) -> ProcessInfo {
    let (status, message) = if error.code() == ERROR_ACCESS_DENIED.to_hresult() {
        (ProcessStatus::AccessDenied, "权限不足，无法读取进程详情")
    } else if error.code() == ERROR_INVALID_PARAMETER.to_hresult()
        || error.code() == ERROR_NOT_FOUND.to_hresult()
    {
        (ProcessStatus::Exited, "进程已退出或 PID 已失效")
    } else {
        (ProcessStatus::Unavailable, "无法读取进程详情")
    };

    ProcessInfo {
        // ToolHelp often exposes the executable basename even when opening the
        // high-integrity process is denied. Keep that useful identity while
        // still marking the path and lifetime fields as permission-limited.
        name: fallback_name,
        path: None,
        created_at: None,
        status,
        status_message: Some(format!("{message}：{error}")),
    }
}

fn toolhelp_process_names() -> HashMap<u32, String> {
    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return HashMap::new();
    };
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut current = unsafe { Process32FirstW(snapshot, &mut entry) };
    let mut result = HashMap::new();
    while current.is_ok() {
        let length = entry
            .szExeFile
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(entry.szExeFile.len());
        let name = String::from_utf16_lossy(&entry.szExeFile[..length]);
        if !name.is_empty() {
            result.insert(entry.th32ProcessID, name);
        }
        current = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe {
        let _ = CloseHandle(snapshot);
    }
    result
}

pub(crate) struct ProcessHandle(HANDLE);

impl ProcessHandle {
    pub(crate) fn open(pid: u32, access: PROCESS_ACCESS_RIGHTS) -> Result<Self, Error> {
        let handle = unsafe { OpenProcess(access, false, pid)? };
        if handle.is_invalid() {
            Err(Error::from_win32())
        } else {
            Ok(Self(handle))
        }
    }

    pub(crate) fn raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for ProcessHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

pub(crate) fn get_process_image_path(handle: &ProcessHandle) -> Result<String, Error> {
    let mut buffer = vec![0_u16; 32_768];
    let mut size = buffer.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            handle.raw(),
            PROCESS_NAME_FORMAT(0),
            PWSTR::from_raw(buffer.as_mut_ptr()),
            &mut size,
        )?;
    }
    Ok(String::from_utf16_lossy(&buffer[..size as usize]))
}

fn process_name_from_path(path: &str) -> Option<String> {
    path.rsplit(['\\', '/'])
        .next()
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

pub(crate) fn get_process_creation_time(handle: &ProcessHandle) -> Option<String> {
    unsafe {
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        GetProcessTimes(
            handle.raw(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
        .ok()?;
        filetime_to_iso8601(creation)
    }
}

fn filetime_to_iso8601(filetime: FILETIME) -> Option<String> {
    const WINDOWS_EPOCH_OFFSET_100NS: u64 = 116_444_736_000_000_000;
    let ticks = ((filetime.dwHighDateTime as u64) << 32) | filetime.dwLowDateTime as u64;
    unix_100ns_to_iso8601(ticks.checked_sub(WINDOWS_EPOCH_OFFSET_100NS)?)
}

fn unix_100ns_to_iso8601(ticks: u64) -> Option<String> {
    let unix_seconds = ticks / 10_000_000;
    let nanoseconds = (ticks % 10_000_000) * 100;
    let days = i64::try_from(unix_seconds / 86_400).ok()?;
    let seconds_of_day = unix_seconds % 86_400;
    let (year, month, day) = days_to_date(days);
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{nanoseconds:09}Z",
        seconds_of_day / 3_600,
        (seconds_of_day % 3_600) / 60,
        seconds_of_day % 60,
    ))
}

fn days_to_date(mut days: i64) -> (i64, u32, u32) {
    days += 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_position = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_position + 2) / 5 + 1;
    let month = if month_position < 10 {
        month_position + 3
    } else {
        month_position - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month as u32, day as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_protected_special_pids_without_environment_dependencies() {
        let resolver = ProcessResolver::new();
        assert_eq!(
            resolver.resolve(0).name.as_deref(),
            Some("System Idle Process")
        );
        assert_eq!(resolver.resolve(4).name.as_deref(), Some("System"));
        assert_eq!(resolver.resolve(4).status, ProcessStatus::System);
    }

    #[test]
    fn begin_scan_drops_previous_cache() {
        let resolver = ProcessResolver::new();
        let _ = resolver.resolve(0);
        assert_eq!(resolver.cache.lock().unwrap().len(), 1);
        resolver.begin_scan();
        assert!(resolver.cache.lock().unwrap().is_empty());
    }

    #[test]
    fn formats_unix_epoch_and_leap_day() {
        assert_eq!(
            unix_100ns_to_iso8601(0).as_deref(),
            Some("1970-01-01T00:00:00.000000000Z")
        );
        assert_eq!(
            unix_100ns_to_iso8601(1_582_934_400 * 10_000_000).as_deref(),
            Some("2020-02-29T00:00:00.000000000Z")
        );
    }

    #[test]
    fn should_preserve_subsecond_filetime_precision() {
        assert_eq!(
            unix_100ns_to_iso8601(12_345_678).as_deref(),
            Some("1970-01-01T00:00:01.234567800Z")
        );
    }

    #[test]
    fn should_reject_filetime_values_before_the_unix_epoch() {
        assert_eq!(filetime_to_iso8601(FILETIME::default()), None);
    }

    #[test]
    fn extracts_windows_and_slash_separated_process_names() {
        assert_eq!(
            process_name_from_path(r"C:\Program Files\App\程序.exe").as_deref(),
            Some("程序.exe")
        );
        assert_eq!(
            process_name_from_path("C:/App/tool.exe").as_deref(),
            Some("tool.exe")
        );
        assert_eq!(process_name_from_path(""), None);
    }

    #[test]
    fn toolhelp_fallback_finds_current_process_basename() {
        let name = toolhelp_process_names()
            .remove(&std::process::id())
            .unwrap();
        assert!(!name.is_empty());
    }
}
