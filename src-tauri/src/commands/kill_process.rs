use windows::core::Error;
use windows::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, ERROR_NOT_FOUND};
use windows::Win32::System::Threading::{
    IsProcessCritical, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
};

use crate::error::{AppError, AppResult};
use crate::network::scan_endpoint_scope;
use crate::network::types::EndpointIdentity;
use crate::process::resolver::{get_process_creation_time, get_process_image_path, ProcessHandle};

const PROTECTED_SYSTEM_IMAGES: &[&str] = &[
    "smss.exe",
    "csrss.exe",
    "wininit.exe",
    "services.exe",
    "lsass.exe",
    "winlogon.exe",
];

/// 终止前以完整端点、创建时间和同一进程句柄三重绑定目标。
#[tauri::command]
pub fn kill_process(endpoint: EndpointIdentity, expected_created_at: String) -> AppResult<()> {
    validate_kill_request(&endpoint, &expected_created_at)?;
    let pid = endpoint.pid;

    let handle = ProcessHandle::open(pid, PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION)
        .map_err(|error| classify_open_error(pid, error))?;

    let current_created_at = get_process_creation_time(&handle).ok_or_else(|| {
        AppError::AccessDenied(format!(
            "无法复核 PID {pid} 的创建时间，已拒绝终止；请刷新后重试"
        ))
    })?;
    if current_created_at != expected_created_at {
        return Err(AppError::AccessDenied(
            "进程身份已变化，已拒绝终止；请刷新列表后重试".to_string(),
        ));
    }

    // 进程句柄已固定到创建时间匹配的内核对象；此时重读对应协议族的原始
    // owner-PID table，防止旧快照中的 PID 已被新进程复用。
    let current_endpoints = scan_endpoint_scope(&endpoint)?;
    if !endpoint_is_present(&endpoint, &current_endpoints) {
        return Err(AppError::AccessDenied(
            "目标端点已消失、发生变化或不再属于该进程，已拒绝终止；请刷新列表后重试".to_string(),
        ));
    }

    let image_path = get_process_image_path(&handle).map_err(|error| {
        AppError::AccessDenied(format!(
            "无法复核 PID {pid} 的可执行文件，已拒绝终止：{error}"
        ))
    })?;
    if is_protected_system_image(&image_path) {
        return Err(AppError::AccessDenied(format!(
            "拒绝终止受保护的 Windows 系统进程：{image_path}"
        )));
    }

    let mut is_critical = windows::core::BOOL::default();
    unsafe { IsProcessCritical(handle.raw(), &mut is_critical) }.map_err(|error| {
        AppError::AccessDenied(format!(
            "无法确认 PID {pid} 是否为关键进程，已拒绝终止：{error}"
        ))
    })?;
    if is_critical.as_bool() {
        return Err(AppError::AccessDenied(
            "拒绝终止 Windows 关键进程".to_string(),
        ));
    }

    unsafe { TerminateProcess(handle.raw(), 1) }
        .map_err(|error| classify_terminate_error(pid, error))
}

fn validate_kill_request(endpoint: &EndpointIdentity, expected_created_at: &str) -> AppResult<()> {
    let pid = endpoint.pid;
    if pid == 0 {
        return Err(AppError::AccessDenied(
            "无法终止 System Idle Process".to_string(),
        ));
    }
    if pid == 4 {
        return Err(AppError::AccessDenied("无法终止 System 进程".to_string()));
    }
    if pid == std::process::id() {
        return Err(AppError::AccessDenied(
            "无法终止 PortViewer 自身".to_string(),
        ));
    }
    if expected_created_at.trim().is_empty() {
        return Err(AppError::AccessDenied(
            "缺少进程创建时间，无法安全确认进程身份".to_string(),
        ));
    }
    Ok(())
}

fn endpoint_is_present(expected: &EndpointIdentity, current: &[EndpointIdentity]) -> bool {
    current.iter().any(|candidate| candidate == expected)
}

fn classify_open_error(pid: u32, error: Error) -> AppError {
    if error.code() == ERROR_INVALID_PARAMETER.to_hresult()
        || error.code() == ERROR_NOT_FOUND.to_hresult()
    {
        AppError::ProcessNotFound(format!("PID {pid} 已退出或不存在"))
    } else if error.code() == ERROR_ACCESS_DENIED.to_hresult() {
        AppError::AccessDenied(format!("无权打开 PID {pid}；可尝试以管理员身份运行"))
    } else {
        AppError::Internal(format!("无法打开 PID {pid}：{error}"))
    }
}

fn classify_terminate_error(pid: u32, error: Error) -> AppError {
    if error.code() == ERROR_INVALID_PARAMETER.to_hresult()
        || error.code() == ERROR_NOT_FOUND.to_hresult()
    {
        AppError::ProcessNotFound(format!("PID {pid} 在终止前已退出"))
    } else if error.code() == ERROR_ACCESS_DENIED.to_hresult() {
        AppError::AccessDenied(format!("无权终止 PID {pid}；可尝试以管理员身份运行"))
    } else {
        AppError::KillFailed(format!("终止 PID {pid} 失败：{error}"))
    }
}

fn is_protected_system_image(path: &str) -> bool {
    let normalized = path.replace('/', "\\").to_ascii_lowercase();
    let Some(file_name) = normalized.rsplit('\\').next() else {
        return false;
    };
    PROTECTED_SYSTEM_IMAGES.contains(&file_name)
        && (normalized.contains("\\windows\\system32\\")
            || normalized.contains("\\windows\\sysnative\\"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::types::{IpVersion, Protocol};

    fn endpoint() -> EndpointIdentity {
        EndpointIdentity {
            protocol: Protocol::Tcp,
            ip_version: IpVersion::V6,
            local_address: "::1".to_string(),
            local_port: 3000,
            remote_address: Some("::1".to_string()),
            remote_port: Some(50_000),
            pid: 42,
        }
    }

    #[test]
    fn rejects_reserved_pids_and_missing_identity() {
        assert!(matches!(
            validate_kill_request(
                &EndpointIdentity {
                    pid: 0,
                    ..endpoint()
                },
                "time"
            ),
            Err(AppError::AccessDenied(_))
        ));
        assert!(matches!(
            validate_kill_request(
                &EndpointIdentity {
                    pid: 4,
                    ..endpoint()
                },
                "time"
            ),
            Err(AppError::AccessDenied(_))
        ));
        assert!(matches!(
            validate_kill_request(&endpoint(), "  "),
            Err(AppError::AccessDenied(_))
        ));
    }

    #[test]
    fn exact_endpoint_identity_matches() {
        let expected = endpoint();
        assert!(endpoint_is_present(
            &expected,
            std::slice::from_ref(&expected)
        ));
    }

    #[test]
    fn missing_endpoint_fails_closed() {
        assert!(!endpoint_is_present(&endpoint(), &[]));
    }

    #[test]
    fn every_endpoint_identity_field_must_match() {
        let expected = endpoint();
        let variants = [
            EndpointIdentity {
                protocol: Protocol::Udp,
                ..expected.clone()
            },
            EndpointIdentity {
                ip_version: IpVersion::V4,
                ..expected.clone()
            },
            EndpointIdentity {
                local_address: "::".to_string(),
                ..expected.clone()
            },
            EndpointIdentity {
                local_port: 3001,
                ..expected.clone()
            },
            EndpointIdentity {
                remote_address: Some("2001:db8::1".to_string()),
                ..expected.clone()
            },
            EndpointIdentity {
                remote_port: Some(50_001),
                ..expected.clone()
            },
            EndpointIdentity {
                pid: 43,
                ..expected.clone()
            },
        ];

        for variant in variants {
            assert!(!endpoint_is_present(&expected, &[variant]));
        }
    }

    #[test]
    fn protects_only_known_images_in_windows_system_directories() {
        assert!(is_protected_system_image(r"C:\Windows\System32\lsass.exe"));
        assert!(is_protected_system_image(r"C:/Windows/System32/CSRSS.EXE"));
        assert!(!is_protected_system_image(r"D:\tools\lsass.exe"));
        assert!(!is_protected_system_image(
            r"C:\Windows\System32\notepad.exe"
        ));
    }
}
