use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime};

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::network::tcp::{
    scan_tcp_v4, scan_tcp_v4_identities, scan_tcp_v6, scan_tcp_v6_identities,
};
use crate::network::types::{
    AttributionResult, EndpointIdentity, IpVersion, PortEntry, Protocol, ScanResult, ScanScope,
    ScanScopeStatus, ScanWarning,
};
use crate::network::udp::{
    scan_udp_v4, scan_udp_v4_identities, scan_udp_v6, scan_udp_v6_identities,
};
use crate::process::resolver::{ProcessInfo, ProcessResolver};
use crate::BackendState;

/// 扫描是阻塞 Win32 I/O；放入 blocking 线程，并在后端保证最多一个活动扫描。
#[tauri::command]
pub async fn scan_all_ports(state: State<'_, BackendState>) -> AppResult<ScanResult> {
    let lease = ScanLease::acquire(Arc::clone(&state.scan_running))?;
    let resolver = Arc::clone(&state.resolver);

    tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        scan_all_scopes(&resolver)
    })
    .await
    .map_err(|error| AppError::Internal(format!("扫描任务异常结束：{error}")))?
}

struct ScanLease(Arc<AtomicBool>);

impl ScanLease {
    fn acquire(running: Arc<AtomicBool>) -> AppResult<Self> {
        running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| AppError::ScanBusy("已有扫描正在进行，请等待其完成".to_string()))?;
        Ok(Self(running))
    }
}

impl Drop for ScanLease {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn scan_all_scopes(resolver: &ProcessResolver) -> AppResult<ScanResult> {
    let started = Instant::now();
    resolver.begin_scan();

    let results = [
        (Protocol::Tcp, IpVersion::V4, scan_tcp_v4(resolver)),
        (Protocol::Tcp, IpVersion::V6, scan_tcp_v6(resolver)),
        (Protocol::Udp, IpVersion::V4, scan_udp_v4(resolver)),
        (Protocol::Udp, IpVersion::V6, scan_udp_v6(resolver)),
    ];

    let mut result = assemble_result(results, started.elapsed().as_millis() as u64, utc_now())?;
    // Resolve each surviving PID once at the end of the four table reads. This
    // keeps one coherent process identity per result even if a PID is reused
    // while the protocol scopes are being collected.
    let identities: HashMap<u32, ProcessInfo> = result
        .entries
        .iter()
        .map(|entry| entry.pid)
        .collect::<HashSet<_>>()
        .into_iter()
        .map(|pid| (pid, resolver.resolve_fresh(pid)))
        .collect();
    for entry in &mut result.entries {
        if let Some(process) = identities.get(&entry.pid) {
            apply_process_info(entry, process);
        }
    }
    result.scan_duration_ms = started.elapsed().as_millis() as u64;
    Ok(result)
}

pub(crate) fn scan_for_web(
    resolver: &ProcessResolver,
    attribution_resolver: &crate::attribution::AttributionResolver,
) -> AppResult<ScanResult> {
    let mut result = scan_all_scopes(resolver)?;
    let enriched = enrich_entries(result.entries, attribution_resolver)?;
    result.entries = enriched.entries;
    result.total_count = result.entries.len();
    result.attribution_reports = enriched.reports;
    result.attribution_deferred = false;
    result.scan_duration_ms = result.scan_duration_ms.saturating_add(enriched.duration_ms);
    Ok(result)
}

pub(crate) fn scan_basic_for_web(resolver: &ProcessResolver) -> AppResult<ScanResult> {
    scan_all_scopes(resolver)
}

#[tauri::command]
pub async fn enrich_ports(
    entries: Vec<PortEntry>,
    state: State<'_, BackendState>,
) -> AppResult<AttributionResult> {
    let attribution_resolver = Arc::clone(&state.attribution_resolver);
    tauri::async_runtime::spawn_blocking(move || enrich_entries(entries, &attribution_resolver))
        .await
        .map_err(|error| AppError::Internal(format!("归属解析任务异常结束：{error}")))?
}

fn enrich_entries(
    mut entries: Vec<PortEntry>,
    attribution_resolver: &crate::attribution::AttributionResolver,
) -> AppResult<AttributionResult> {
    let started = Instant::now();
    let live = live_endpoint_identities()?;
    entries.retain(|entry| live.contains(&EndpointIdentity::from(entry)));
    let reports = attribution_resolver.enrich(&mut entries);
    Ok(AttributionResult {
        entries,
        reports,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

fn live_endpoint_identities() -> AppResult<HashSet<EndpointIdentity>> {
    let scopes = [
        scan_tcp_v4_identities(),
        scan_tcp_v6_identities(),
        scan_udp_v4_identities(),
        scan_udp_v6_identities(),
    ];
    let mut live = HashSet::new();
    for scope in scopes {
        live.extend(scope?);
    }
    Ok(live)
}

fn apply_process_info(entry: &mut PortEntry, process: &ProcessInfo) {
    entry.process_name = process.name.clone();
    entry.process_path = process.path.clone();
    entry.process_created_at = process.created_at.clone();
    entry.process_status = process.status;
    entry.process_status_message = process.status_message.clone();
}

fn assemble_result<const N: usize>(
    results: [(Protocol, IpVersion, AppResult<Vec<PortEntry>>); N],
    scan_duration_ms: u64,
    timestamp: String,
) -> AppResult<ScanResult> {
    let mut entries = Vec::new();
    let mut scopes = Vec::with_capacity(N);
    let mut warnings = Vec::new();
    let mut successful_scopes = 0;

    for (protocol, ip_version, result) in results {
        match result {
            Ok(mut scope_entries) => {
                successful_scopes += 1;
                scopes.push(ScanScope {
                    protocol,
                    ip_version,
                    status: ScanScopeStatus::Complete,
                    entry_count: scope_entries.len(),
                    message: None,
                });
                entries.append(&mut scope_entries);
            }
            Err(error) => {
                let message = error.to_string();
                scopes.push(ScanScope {
                    protocol,
                    ip_version,
                    status: ScanScopeStatus::Failed,
                    entry_count: 0,
                    message: Some(message.clone()),
                });
                warnings.push(ScanWarning {
                    code: "scope_failed".to_string(),
                    protocol,
                    ip_version,
                    message,
                });
            }
        }
    }

    if successful_scopes == 0 {
        let detail = warnings
            .iter()
            .map(|warning| warning.message.as_str())
            .collect::<Vec<_>>()
            .join("；");
        return Err(AppError::ScanError(format!("所有扫描范围均失败：{detail}")));
    }

    let total_count = entries.len();
    let is_partial = !warnings.is_empty();
    log::info!(
        "scan_all_ports: {} entries, {}/{} scopes, duration={}ms",
        total_count,
        successful_scopes,
        N,
        scan_duration_ms
    );

    Ok(ScanResult {
        entries,
        total_count,
        timestamp,
        scan_duration_ms,
        is_partial,
        scopes,
        warnings,
        attribution_reports: Vec::new(),
        attribution_deferred: true,
    })
}

fn utc_now() -> String {
    let duration = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    unix_seconds_to_iso8601(duration.as_secs())
}

fn unix_seconds_to_iso8601(seconds: u64) -> String {
    let days = (seconds / 86_400) as i64;
    let seconds_of_day = seconds % 86_400;
    let (year, month, day) = days_to_date(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        seconds_of_day / 3_600,
        (seconds_of_day % 3_600) / 60,
        seconds_of_day % 60
    )
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

    fn failed(message: &str) -> AppResult<Vec<PortEntry>> {
        Err(AppError::ScanError(message.to_string()))
    }

    #[test]
    fn partial_scan_keeps_successful_scopes_and_warning() {
        let result = assemble_result(
            [
                (Protocol::Tcp, IpVersion::V4, Ok(Vec::new())),
                (Protocol::Tcp, IpVersion::V6, failed("IPv6 disabled")),
            ],
            12,
            "2020-01-01T00:00:00Z".to_string(),
        )
        .unwrap();

        assert!(result.is_partial);
        assert_eq!(result.scopes.len(), 2);
        assert_eq!(result.warnings.len(), 1);
        assert_eq!(result.scopes[1].status, ScanScopeStatus::Failed);
    }

    #[test]
    fn should_assemble_complete_scopes_and_preserve_metadata() {
        let entry = PortEntry {
            protocol: Protocol::Udp,
            ip_version: IpVersion::V4,
            local_address: "0.0.0.0".to_string(),
            local_port: 0,
            remote_address: None,
            remote_port: None,
            state: None,
            pid: 10,
            process_name: None,
            process_path: None,
            process_created_at: None,
            process_status: crate::network::types::ProcessStatus::Unavailable,
            process_status_message: None,
            attributions: Vec::new(),
        };

        let result = assemble_result(
            [
                (Protocol::Udp, IpVersion::V4, Ok(vec![entry])),
                (Protocol::Udp, IpVersion::V6, Ok(Vec::new())),
            ],
            7,
            "2026-08-23T00:00:00Z".to_string(),
        )
        .unwrap();

        assert_eq!(result.total_count, 1);
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.scopes.len(), 2);
        assert!(!result.is_partial);
        assert!(result.warnings.is_empty());
        assert_eq!(result.scan_duration_ms, 7);
        assert_eq!(result.timestamp, "2026-08-23T00:00:00Z");
    }

    #[test]
    fn all_failed_scopes_return_a_hard_error() {
        let result = assemble_result(
            [(Protocol::Tcp, IpVersion::V4, failed("unavailable"))],
            0,
            String::new(),
        );
        assert!(matches!(result, Err(AppError::ScanError(_))));
    }

    #[test]
    fn scan_lease_rejects_overlap_and_recovers_after_drop() {
        let running = Arc::new(AtomicBool::new(false));
        let first = ScanLease::acquire(Arc::clone(&running)).unwrap();
        assert!(matches!(
            ScanLease::acquire(Arc::clone(&running)),
            Err(AppError::ScanBusy(_))
        ));
        drop(first);
        assert!(ScanLease::acquire(running).is_ok());
    }

    #[test]
    fn formats_known_utc_dates() {
        assert_eq!(unix_seconds_to_iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(
            unix_seconds_to_iso8601(1_582_934_400),
            "2020-02-29T00:00:00Z"
        );
    }
}
