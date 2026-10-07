use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::mem::{size_of, size_of_val};
use std::slice;

use windows::core::PCWSTR;
use windows::Wdk::System::Threading::{NtQueryInformationProcess, ProcessCommandLineInformation};
use windows::Win32::Foundation::{CloseHandle, ERROR_MORE_DATA, UNICODE_STRING};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Services::{
    CloseServiceHandle, EnumServicesStatusExW, OpenSCManagerW, ENUM_SERVICE_STATUS_PROCESSW,
    SC_ENUM_PROCESS_INFO, SC_HANDLE, SC_MANAGER_ENUMERATE_SERVICE, SERVICE_ACTIVE,
    SERVICE_CONTINUE_PENDING, SERVICE_PAUSED, SERVICE_PAUSE_PENDING, SERVICE_RUNNING,
    SERVICE_START_PENDING, SERVICE_STATUS_CURRENT_STATE, SERVICE_STOP_PENDING, SERVICE_WIN32,
};
use windows::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;

use crate::network::types::{
    AttributionConfidence, AttributionFact, AttributionKind, ServiceAttribution,
};
use crate::process::resolver::{get_process_creation_time, get_process_image_path, ProcessHandle};

const MAX_COMMAND_LINE_BYTES: usize = 1024 * 1024;
const SERVICE_BUFFER_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone)]
pub struct ProcessRecord {
    pub process_id: u32,
    pub parent_process_id: u32,
    pub name: Option<String>,
    pub executable_path: Option<String>,
    pub command_line: Option<String>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ServiceRecord {
    pub name: String,
    pub display_name: String,
    pub process_id: u32,
    pub path_name: Option<String>,
    pub state: String,
}

#[derive(Debug, Clone, Default)]
pub struct SystemSnapshot {
    pub processes: HashMap<u32, ProcessRecord>,
    pub services: Vec<ServiceRecord>,
    pub permission_limited_processes: usize,
    pub incomplete_processes: usize,
}

impl SystemSnapshot {
    pub fn collect(relevant_pids: &[u32]) -> Result<Self, String> {
        let mut processes = enumerate_processes()?;
        let relevant = relevant_process_closure(&processes, relevant_pids);
        let mut permission_limited_processes = 0;
        let mut incomplete_processes = 0;
        for pid in relevant {
            if let Some(process) = processes.get_mut(&pid) {
                match ProcessHandle::open(pid, PROCESS_QUERY_LIMITED_INFORMATION) {
                    Ok(handle) => {
                        process.executable_path = get_process_image_path(&handle).ok();
                        process.command_line = query_command_line(&handle);
                        process.created_at = get_process_creation_time(&handle);
                        if process.executable_path.is_none()
                            || process.command_line.is_none()
                            || process.created_at.is_none()
                        {
                            incomplete_processes += 1;
                        }
                    }
                    Err(error) => {
                        incomplete_processes += 1;
                        if error.code()
                            == windows::Win32::Foundation::ERROR_ACCESS_DENIED.to_hresult()
                        {
                            permission_limited_processes += 1;
                        }
                    }
                }
            }
        }
        let services = enumerate_services(&processes)?;
        Ok(Self {
            processes,
            services,
            permission_limited_processes,
            incomplete_processes,
        })
    }

    pub fn process(&self, pid: u32) -> Option<&ProcessRecord> {
        self.processes.get(&pid)
    }

    pub fn ancestors(&self, pid: u32) -> Vec<&ProcessRecord> {
        let mut result = Vec::new();
        let mut current = pid;
        let mut visited = HashSet::new();
        for _ in 0..12 {
            let Some(process) = self.processes.get(&current) else {
                break;
            };
            if !visited.insert(current) {
                break;
            }
            result.push(process);
            if process.parent_process_id == 0 || process.parent_process_id == current {
                break;
            }
            current = process.parent_process_id;
        }
        result
    }

    pub fn service_attributions(&self, pid: u32) -> Vec<ServiceAttribution> {
        let ancestors = self.ancestors(pid);
        let distance: HashMap<u32, usize> = ancestors
            .iter()
            .enumerate()
            .map(|(index, process)| (process.process_id, index))
            .collect();
        let direct_service_count = self
            .services
            .iter()
            .filter(|service| service.process_id == pid)
            .count();
        self.services
            .iter()
            .filter_map(|service| {
                let depth = *distance.get(&service.process_id)?;
                let is_nssm = service
                    .path_name
                    .as_deref()
                    .is_some_and(|path| path.to_ascii_lowercase().contains("nssm"));
                let kind = if is_nssm {
                    AttributionKind::NssmService
                } else {
                    AttributionKind::WindowsService
                };
                let mut facts = vec![
                    fact("服务名", &service.name),
                    fact("服务状态", &service.state),
                    fact("服务 PID", service.process_id.to_string()),
                ];
                if depth > 0 {
                    facts.push(fact("关联方式", format!("端口进程的第 {depth} 级父进程")));
                }
                Some(ServiceAttribution {
                    kind,
                    name: service.display_name.clone(),
                    description: Some(if is_nssm {
                        "NSSM 托管的 Windows 服务".to_string()
                    } else {
                        "Windows 服务".to_string()
                    }),
                    confidence: if depth == 0 && direct_service_count == 1 {
                        AttributionConfidence::Exact
                    } else {
                        AttributionConfidence::High
                    },
                    source: "Windows Service Control Manager + 原生进程父链".to_string(),
                    facts,
                })
            })
            .collect()
    }
}

fn enumerate_processes() -> Result<HashMap<u32, ProcessRecord>, String> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
        .map_err(|error| format!("无法创建 Windows 进程快照：{error}"))?;
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut result = HashMap::new();
    let mut next = unsafe { Process32FirstW(snapshot, &mut entry) };
    while next.is_ok() {
        let name_length = entry
            .szExeFile
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(entry.szExeFile.len());
        let name = String::from_utf16_lossy(&entry.szExeFile[..name_length]);
        result.insert(
            entry.th32ProcessID,
            ProcessRecord {
                process_id: entry.th32ProcessID,
                parent_process_id: entry.th32ParentProcessID,
                name: (!name.is_empty()).then_some(name),
                executable_path: None,
                command_line: None,
                created_at: None,
            },
        );
        next = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe {
        let _ = CloseHandle(snapshot);
    }
    Ok(result)
}

fn relevant_process_closure(
    processes: &HashMap<u32, ProcessRecord>,
    relevant_pids: &[u32],
) -> HashSet<u32> {
    let mut result: HashSet<u32> = relevant_pids.iter().copied().collect();
    result.extend(
        processes
            .values()
            .filter(|process| {
                let name = process.name.as_deref().unwrap_or_default();
                name.eq_ignore_ascii_case("nginx.exe") || name.eq_ignore_ascii_case("nginx")
            })
            .map(|process| process.process_id),
    );
    let seeds: Vec<u32> = result.iter().copied().collect();
    for seed in seeds {
        let mut current = seed;
        for _ in 0..12 {
            let Some(process) = processes.get(&current) else {
                break;
            };
            result.insert(process.process_id);
            if process.parent_process_id == 0 || process.parent_process_id == current {
                break;
            }
            if !result.insert(process.parent_process_id) {
                break;
            }
            current = process.parent_process_id;
        }
    }
    result
}

fn query_command_line(handle: &ProcessHandle) -> Option<String> {
    let mut required = 0_u32;
    unsafe {
        let _ = NtQueryInformationProcess(
            handle.raw(),
            ProcessCommandLineInformation,
            std::ptr::null_mut(),
            0,
            &mut required,
        );
    }
    let required = required as usize;
    if required < size_of::<UNICODE_STRING>() || required > MAX_COMMAND_LINE_BYTES {
        return None;
    }
    let words = required.div_ceil(size_of::<usize>());
    let mut storage = vec![0_usize; words];
    let mut returned = 0_u32;
    let status = unsafe {
        NtQueryInformationProcess(
            handle.raw(),
            ProcessCommandLineInformation,
            storage.as_mut_ptr().cast::<c_void>(),
            size_of_val(storage.as_slice()) as u32,
            &mut returned,
        )
    };
    if status.0 < 0 || returned as usize > size_of_val(storage.as_slice()) {
        return None;
    }
    let value = unsafe { &*(storage.as_ptr().cast::<UNICODE_STRING>()) };
    let byte_length = value.Length as usize;
    if byte_length == 0 || byte_length % 2 != 0 {
        return None;
    }
    let start = value.Buffer.0 as usize;
    let buffer_start = storage.as_ptr() as usize;
    let buffer_end = buffer_start.checked_add(size_of_val(storage.as_slice()))?;
    let end = start.checked_add(byte_length)?;
    if start < buffer_start || end > buffer_end {
        return None;
    }
    let wide = unsafe { slice::from_raw_parts(value.Buffer.0, byte_length / 2) };
    Some(String::from_utf16_lossy(wide))
}

fn enumerate_services(
    processes: &HashMap<u32, ProcessRecord>,
) -> Result<Vec<ServiceRecord>, String> {
    let manager = unsafe { OpenSCManagerW(None, None, SC_MANAGER_ENUMERATE_SERVICE) }
        .map_err(|error| format!("无法打开 Windows Service Control Manager：{error}"))?;
    let manager = ServiceManagerHandle(manager);
    let mut buffer_bytes = SERVICE_BUFFER_BYTES;
    let mut resume = 0_u32;
    let mut result = Vec::new();

    loop {
        let words = buffer_bytes.div_ceil(size_of::<usize>());
        let mut storage = vec![0_usize; words];
        let bytes = unsafe {
            slice::from_raw_parts_mut(
                storage.as_mut_ptr().cast::<u8>(),
                size_of_val(storage.as_slice()),
            )
        };
        let mut needed = 0_u32;
        let mut returned = 0_u32;
        let enumeration = unsafe {
            EnumServicesStatusExW(
                manager.0,
                SC_ENUM_PROCESS_INFO,
                SERVICE_WIN32,
                SERVICE_ACTIVE,
                Some(bytes),
                &mut needed,
                &mut returned,
                Some(&mut resume),
                PCWSTR::null(),
            )
        };
        let has_more = enumeration
            .as_ref()
            .err()
            .is_some_and(|error| error.code() == ERROR_MORE_DATA.to_hresult());
        if let Err(error) = enumeration {
            if !has_more {
                return Err(format!("无法枚举 Windows 服务：{error}"));
            }
        }

        let capacity = size_of_val(storage.as_slice()) / size_of::<ENUM_SERVICE_STATUS_PROCESSW>();
        if returned as usize > capacity {
            return Err("Windows 服务枚举返回了超出缓冲区的条目数".to_string());
        }
        let entries = unsafe {
            slice::from_raw_parts(
                storage.as_ptr().cast::<ENUM_SERVICE_STATUS_PROCESSW>(),
                returned as usize,
            )
        };
        for entry in entries
            .iter()
            .filter(|entry| entry.ServiceStatusProcess.dwProcessId != 0)
        {
            let process_id = entry.ServiceStatusProcess.dwProcessId;
            let name = unsafe { entry.lpServiceName.to_string() }
                .map_err(|error| format!("Windows 服务名不是有效 Unicode：{error}"))?;
            let display_name = unsafe { entry.lpDisplayName.to_string() }
                .map_err(|error| format!("Windows 服务显示名不是有效 Unicode：{error}"))?;
            let path_name = processes.get(&process_id).and_then(|process| {
                process
                    .executable_path
                    .clone()
                    .or_else(|| process.name.clone())
            });
            result.push(ServiceRecord {
                name,
                display_name,
                process_id,
                path_name,
                state: service_state(entry.ServiceStatusProcess.dwCurrentState).to_string(),
            });
        }
        if !has_more {
            break;
        }
        if returned == 0 {
            buffer_bytes = usize::try_from(needed)
                .ok()
                .filter(|needed| *needed > buffer_bytes)
                .unwrap_or(buffer_bytes.saturating_mul(2));
        }
        if buffer_bytes > 16 * 1024 * 1024 {
            return Err("Windows 服务枚举请求的缓冲区超过安全上限".to_string());
        }
    }
    Ok(result)
}

struct ServiceManagerHandle(SC_HANDLE);

impl Drop for ServiceManagerHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseServiceHandle(self.0);
        }
    }
}

fn service_state(state: SERVICE_STATUS_CURRENT_STATE) -> &'static str {
    match state {
        value if value == SERVICE_RUNNING => "Running",
        value if value == SERVICE_START_PENDING => "StartPending",
        value if value == SERVICE_STOP_PENDING => "StopPending",
        value if value == SERVICE_PAUSED => "Paused",
        value if value == SERVICE_PAUSE_PENDING => "PausePending",
        value if value == SERVICE_CONTINUE_PENDING => "ContinuePending",
        _ => "Active",
    }
}

pub fn fact(label: impl Into<String>, value: impl Into<String>) -> AttributionFact {
    AttributionFact {
        label: label.into(),
        value: value.into(),
    }
}

pub fn truncate(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let text: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{text}…")
    } else {
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(pid: u32, parent: u32) -> ProcessRecord {
        ProcessRecord {
            process_id: pid,
            parent_process_id: parent,
            name: Some("node.exe".to_string()),
            executable_path: None,
            command_line: None,
            created_at: None,
        }
    }

    #[test]
    fn native_snapshot_includes_current_process_and_parent_identity() {
        let pid = std::process::id();
        let snapshot = SystemSnapshot::collect(&[pid]).unwrap();
        let current = snapshot.process(pid).unwrap();
        assert!(current.name.is_some());
        assert!(current
            .command_line
            .as_deref()
            .is_some_and(|line| !line.is_empty()));
        assert!(!snapshot.ancestors(pid).is_empty());
    }

    #[test]
    fn follows_parent_chain_without_looping() {
        let snapshot = SystemSnapshot {
            processes: [(10, process(10, 20)), (20, process(20, 10))]
                .into_iter()
                .collect(),
            services: Vec::new(),
            permission_limited_processes: 0,
            incomplete_processes: 0,
        };
        assert_eq!(snapshot.ancestors(10).len(), 2);
    }

    #[test]
    fn maps_nssm_parent_service_to_child_listener() {
        let snapshot = SystemSnapshot {
            processes: [(10, process(10, 20)), (20, process(20, 0))]
                .into_iter()
                .collect(),
            services: vec![ServiceRecord {
                name: "Api".to_string(),
                display_name: "Example API".to_string(),
                process_id: 20,
                path_name: Some(r#"C:\tools\nssm.exe"#.to_string()),
                state: "Running".to_string(),
            }],
            permission_limited_processes: 0,
            incomplete_processes: 0,
        };
        let result = snapshot.service_attributions(10);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].kind, AttributionKind::NssmService);
        assert_eq!(result[0].confidence, AttributionConfidence::High);
    }

    #[test]
    fn shared_service_host_does_not_claim_multiple_exact_matches() {
        let snapshot = SystemSnapshot {
            processes: [(10, process(10, 0))].into_iter().collect(),
            services: ["ServiceA", "ServiceB"]
                .into_iter()
                .map(|name| ServiceRecord {
                    name: name.to_string(),
                    display_name: name.to_string(),
                    process_id: 10,
                    path_name: Some("svchost.exe".to_string()),
                    state: "Running".to_string(),
                })
                .collect(),
            permission_limited_processes: 0,
            incomplete_processes: 0,
        };
        let result = snapshot.service_attributions(10);
        assert_eq!(result.len(), 2);
        assert!(result
            .iter()
            .all(|item| item.confidence == AttributionConfidence::High));
    }
}
