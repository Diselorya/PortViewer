use std::ffi::c_void;
use std::mem::{size_of, size_of_val};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    CloseHandle, ERROR_ACCESS_DISABLED_BY_POLICY, ERROR_CANCELLED, HANDLE, HWND,
};
use windows::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenElevation,
    TokenElevationType, TokenElevationTypeDefault, TokenElevationTypeFull,
    TokenElevationTypeLimited, TokenIntegrityLevel, TOKEN_ELEVATION, TOKEN_ELEVATION_TYPE,
    TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::SystemServices::{
    SECURITY_MANDATORY_HIGH_RID, SECURITY_MANDATORY_LOW_RID, SECURITY_MANDATORY_MEDIUM_RID,
    SECURITY_MANDATORY_SYSTEM_RID,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken, WaitForInputIdle};
use windows::Win32::UI::Shell::{
    FOLDERID_ProgramFiles, SHGetKnownFolderPath, ShellExecuteExW, KF_FLAG_DEFAULT,
    SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PrivilegeStatus {
    pub is_elevated: bool,
    pub elevation_type: String,
    pub integrity_level: String,
    pub can_elevate: bool,
    pub elevation_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ElevatedRestartResult {
    Started,
    AlreadyElevated,
    UacCancelled,
    PolicyBlocked,
    LaunchFailed,
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

#[tauri::command]
pub fn get_privilege_status() -> AppResult<PrivilegeStatus> {
    let mut status = query_privilege_status()
        .map_err(|error| AppError::Internal(format!("无法读取当前 Windows 权限状态：{error}")))?;
    if status.is_elevated {
        status.elevation_reason = Some("AlreadyElevated".to_string());
    } else {
        let executable = std::env::current_exe().map_err(|error| {
            AppError::Internal(format!("无法定位 PortViewer 可执行文件：{error}"))
        })?;
        status.can_elevate = is_protected_install_location(&executable)?;
        if !status.can_elevate {
            status.elevation_reason = Some("UntrustedInstallLocation".to_string());
        }
    }
    Ok(status)
}

#[tauri::command]
pub fn restart_elevated(app: AppHandle) -> AppResult<ElevatedRestartResult> {
    let status = query_privilege_status()
        .map_err(|error| AppError::Internal(format!("无法确认当前 Windows 权限状态：{error}")))?;
    if status.is_elevated {
        return Ok(ElevatedRestartResult::AlreadyElevated);
    }

    let executable = std::env::current_exe()
        .map_err(|error| AppError::Internal(format!("无法定位 PortViewer 可执行文件：{error}")))?;
    if !executable.is_absolute() {
        return Err(AppError::Internal(
            "PortViewer 可执行文件路径不是绝对路径，已拒绝提升".to_string(),
        ));
    }
    if !is_protected_install_location(&executable)? {
        log::warn!(
            "Refusing elevation outside the protected Program Files installation: {}",
            executable.display()
        );
        return Ok(ElevatedRestartResult::PolicyBlocked);
    }

    let verb = wide("runas");
    let file = executable
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let mut execute = SHELLEXECUTEINFOW {
        cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        hwnd: HWND::default(),
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        nShow: 1,
        ..Default::default()
    };

    match unsafe { ShellExecuteExW(&mut execute) } {
        Ok(()) => {
            let child_handle = execute.hProcess.0 as usize;
            tauri::async_runtime::spawn(async move {
                let ready = tauri::async_runtime::spawn_blocking(move || {
                    let child = OwnedHandle(HANDLE(child_handle as *mut c_void));
                    unsafe { WaitForInputIdle(child.0, 15_000) == 0 }
                })
                .await
                .unwrap_or(false);
                if ready {
                    app.exit(0);
                } else {
                    log::warn!("Elevated PortViewer did not become input-ready; keeping the current instance open");
                }
            });
            Ok(ElevatedRestartResult::Started)
        }
        Err(error) if error.code() == ERROR_CANCELLED.to_hresult() => {
            Ok(ElevatedRestartResult::UacCancelled)
        }
        Err(error) if error.code() == ERROR_ACCESS_DISABLED_BY_POLICY.to_hresult() => {
            Ok(ElevatedRestartResult::PolicyBlocked)
        }
        Err(error) => {
            log::warn!("restart_elevated failed: {error}");
            Ok(ElevatedRestartResult::LaunchFailed)
        }
    }
}

fn query_privilege_status() -> windows::core::Result<PrivilegeStatus> {
    let mut raw_token = HANDLE::default();
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw_token)? };
    let token = OwnedHandle(raw_token);
    let elevation: TOKEN_ELEVATION = token_information(token.0, TokenElevation)?;
    let elevation_type: TOKEN_ELEVATION_TYPE = token_information(token.0, TokenElevationType)?;

    Ok(PrivilegeStatus {
        is_elevated: elevation.TokenIsElevated != 0,
        elevation_type: elevation_type_label(elevation_type).to_string(),
        integrity_level: integrity_level(token.0).unwrap_or("Unknown").to_string(),
        can_elevate: false,
        elevation_reason: None,
    })
}

fn is_protected_install_location(executable: &Path) -> AppResult<bool> {
    let program_files = program_files_directory().map_err(AppError::Internal)?;
    let canonical_root = std::fs::canonicalize(&program_files)
        .map_err(|error| AppError::Internal(format!("无法校验 Program Files 目录：{error}")))?;
    let canonical_executable = std::fs::canonicalize(executable).map_err(|error| {
        AppError::Internal(format!("无法校验 PortViewer 可执行文件路径：{error}"))
    })?;
    Ok(canonical_executable.starts_with(canonical_root))
}

fn program_files_directory() -> Result<PathBuf, String> {
    let path = unsafe { SHGetKnownFolderPath(&FOLDERID_ProgramFiles, KF_FLAG_DEFAULT, None) }
        .map_err(|error| format!("无法读取 Windows Program Files 已知目录：{error}"))?;
    let text = unsafe { path.to_string() }
        .map_err(|error| format!("Program Files 目录不是有效 Unicode：{error}"));
    unsafe {
        CoTaskMemFree(Some(path.0.cast::<c_void>()));
    }
    text.map(PathBuf::from)
}

fn token_information<T: Default>(
    token: HANDLE,
    class: windows::Win32::Security::TOKEN_INFORMATION_CLASS,
) -> windows::core::Result<T> {
    let mut value = T::default();
    let mut returned = 0_u32;
    unsafe {
        GetTokenInformation(
            token,
            class,
            Some((&mut value as *mut T).cast::<c_void>()),
            size_of::<T>() as u32,
            &mut returned,
        )?;
    }
    Ok(value)
}

fn integrity_level(token: HANDLE) -> windows::core::Result<&'static str> {
    let mut required = 0_u32;
    let first = unsafe { GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut required) };
    if required == 0 {
        return first.map(|_| "Unknown");
    }
    let words = (required as usize).div_ceil(size_of::<usize>());
    let mut storage = vec![0_usize; words];
    unsafe {
        GetTokenInformation(
            token,
            TokenIntegrityLevel,
            Some(storage.as_mut_ptr().cast::<c_void>()),
            size_of_val(storage.as_slice()) as u32,
            &mut required,
        )?;
        let label = &*(storage.as_ptr().cast::<TOKEN_MANDATORY_LABEL>());
        let count = GetSidSubAuthorityCount(label.Label.Sid);
        if count.is_null() || *count == 0 {
            return Ok("Unknown");
        }
        let rid = *GetSidSubAuthority(label.Label.Sid, u32::from(*count) - 1) as i32;
        Ok(match rid {
            value if value >= SECURITY_MANDATORY_SYSTEM_RID => "System",
            value if value >= SECURITY_MANDATORY_HIGH_RID => "High",
            value if value >= SECURITY_MANDATORY_MEDIUM_RID => "Medium",
            value if value >= SECURITY_MANDATORY_LOW_RID => "Low",
            _ => "Unknown",
        })
    }
}

fn elevation_type_label(value: TOKEN_ELEVATION_TYPE) -> &'static str {
    match value {
        value if value == TokenElevationTypeFull => "Full",
        value if value == TokenElevationTypeLimited => "Limited",
        value if value == TokenElevationTypeDefault => "Default",
        _ => "Unknown",
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_all_documented_elevation_types() {
        assert_eq!(elevation_type_label(TokenElevationTypeFull), "Full");
        assert_eq!(elevation_type_label(TokenElevationTypeLimited), "Limited");
        assert_eq!(elevation_type_label(TokenElevationTypeDefault), "Default");
    }

    #[test]
    fn reports_current_process_privilege_without_elevating() {
        let status = query_privilege_status().unwrap();
        assert!(["Full", "Limited", "Default"].contains(&status.elevation_type.as_str()));
        assert!(["Low", "Medium", "High", "System", "Unknown"]
            .contains(&status.integrity_level.as_str()));
    }

    #[test]
    fn development_binary_is_not_treated_as_a_protected_install() {
        assert!(!is_protected_install_location(&std::env::current_exe().unwrap()).unwrap());
    }
}
