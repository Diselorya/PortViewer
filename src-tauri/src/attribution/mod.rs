mod command;
mod docker;
mod iis;
mod nginx;
mod runtime;
mod system;

use std::collections::HashSet;
use std::thread;

use docker::DockerSnapshot;
use iis::IisSnapshot;
use nginx::NginxSnapshot;
use system::SystemSnapshot;

use crate::network::types::{
    AttributionKind, AttributionResolverReport, AttributionScanStatus, PortEntry,
    ServiceAttribution,
};

#[derive(Clone)]
struct AttributionData {
    system: Option<SystemSnapshot>,
    docker: Option<DockerSnapshot>,
    iis: Option<IisSnapshot>,
    nginx: Option<NginxSnapshot>,
    reports: Vec<AttributionResolverReport>,
}

pub struct AttributionResolver;

impl AttributionResolver {
    pub fn new() -> Self {
        Self
    }

    pub fn enrich(&self, entries: &mut [PortEntry]) -> Vec<AttributionResolverReport> {
        let data = AttributionData::collect(entries);
        let mut reports = data.reports.clone();
        for entry in entries {
            let mut attributions = Vec::new();
            let system_identity_matches = entry.pid <= 4
                || data
                    .system
                    .as_ref()
                    .and_then(|system| system.process(entry.pid))
                    .is_some_and(|process| {
                        match (&process.created_at, &entry.process_created_at) {
                            (Some(current), Some(scanned)) => current == scanned,
                            _ => false,
                        }
                    });
            if let Some(docker) = &data.docker {
                attributions.extend(docker.matches(entry));
            }
            if let Some(iis) = &data.iis {
                attributions.extend(
                    iis.matches(
                        entry,
                        system_identity_matches
                            .then_some(data.system.as_ref())
                            .flatten(),
                    ),
                );
            }
            if system_identity_matches {
                if let Some(nginx) = &data.nginx {
                    attributions.extend(nginx.matches(entry));
                }
            }
            if system_identity_matches {
                if let Some(system) = &data.system {
                    attributions.extend(system.service_attributions(entry.pid));
                    attributions.extend(runtime::classify(entry.pid, system));
                }
            }
            deduplicate_and_sort(&mut attributions);
            update_match_counts(&mut reports, &attributions);
            entry.attributions = attributions;
        }
        reports
    }
}

impl Default for AttributionResolver {
    fn default() -> Self {
        Self::new()
    }
}

impl AttributionData {
    fn collect(entries: &[PortEntry]) -> Self {
        let relevant_pids: Vec<u32> = entries.iter().map(|entry| entry.pid).collect();
        let system_task = thread::spawn(move || SystemSnapshot::collect(&relevant_pids));
        let docker_task = thread::spawn(DockerSnapshot::collect);
        let system_result = system_task
            .join()
            .unwrap_or_else(|_| Err("Windows 进程/服务解析线程异常结束".to_string()));
        let docker_result = docker_task
            .join()
            .unwrap_or_else(|_| Err("Docker 解析线程异常结束".to_string()));
        let mut reports = Vec::new();
        let system = match system_result {
            Ok(snapshot) => {
                let status = if snapshot.incomplete_processes > 0 {
                    AttributionScanStatus::Partial
                } else {
                    AttributionScanStatus::Complete
                };
                let message = (snapshot.incomplete_processes > 0).then(|| {
                    if snapshot.permission_limited_processes > 0 {
                        format!(
                            "{} 个相关进程详情未完整读取，其中 {} 个被 Windows 拒绝访问；管理员模式可能补全部分信息",
                            snapshot.incomplete_processes, snapshot.permission_limited_processes
                        )
                    } else {
                        format!(
                            "{} 个相关进程详情未完整读取，可能已退出或不提供命令行",
                            snapshot.incomplete_processes
                        )
                    }
                });
                reports.push(report("Windows 服务 / NSSM", status, message.clone()));
                reports.push(report("Node.js / Python", status, message));
                Some(snapshot)
            }
            Err(error) => {
                reports.push(report(
                    "Windows 服务 / NSSM",
                    AttributionScanStatus::Failed,
                    Some(error.clone()),
                ));
                reports.push(report(
                    "Node.js / Python",
                    AttributionScanStatus::Failed,
                    Some(error),
                ));
                None
            }
        };
        let docker = match docker_result {
            Ok(snapshot) => {
                reports.push(report("Docker", AttributionScanStatus::Complete, None));
                Some(snapshot)
            }
            Err(error) => {
                let skipped = error.contains("无法启动 docker.exe")
                    || error.contains("远端 Docker")
                    || error.contains("已跳过 Docker 归属识别");
                reports.push(report(
                    "Docker",
                    if skipped {
                        AttributionScanStatus::Skipped
                    } else {
                        AttributionScanStatus::Failed
                    },
                    Some(error),
                ));
                None
            }
        };
        let iis = match IisSnapshot::collect() {
            Ok(Some(snapshot)) => {
                reports.push(report("IIS", AttributionScanStatus::Complete, None));
                Some(snapshot)
            }
            Ok(None) => {
                reports.push(report(
                    "IIS",
                    AttributionScanStatus::Skipped,
                    Some("未安装 IIS 或未找到 applicationHost.config".to_string()),
                ));
                None
            }
            Err(error) => {
                reports.push(report("IIS", AttributionScanStatus::Failed, Some(error)));
                None
            }
        };
        let nginx = match NginxSnapshot::collect(system.as_ref(), entries) {
            Ok(Some(snapshot)) => {
                reports.push(report("Nginx", AttributionScanStatus::Complete, None));
                Some(snapshot)
            }
            Ok(None) => {
                reports.push(report(
                    "Nginx",
                    AttributionScanStatus::Skipped,
                    Some("未发现本机 Nginx 进程".to_string()),
                ));
                None
            }
            Err(error) => {
                reports.push(report("Nginx", AttributionScanStatus::Partial, Some(error)));
                None
            }
        };
        Self {
            system,
            docker,
            iis,
            nginx,
            reports,
        }
    }
}

fn report(
    resolver: &str,
    status: AttributionScanStatus,
    message: Option<String>,
) -> AttributionResolverReport {
    let elevation_may_help = message.as_deref().is_some_and(|message| {
        let message = message.to_ascii_lowercase();
        message.contains("拒绝访问")
            || message.contains("权限不足")
            || message.contains("access is denied")
            || message.contains("permission denied")
    });
    AttributionResolverReport {
        resolver: resolver.to_string(),
        status,
        matched_count: 0,
        message,
        elevation_may_help,
    }
}

fn deduplicate_and_sort(items: &mut Vec<ServiceAttribution>) {
    let mut seen = HashSet::new();
    items.retain(|item| {
        seen.insert((
            item.kind,
            item.name.to_ascii_lowercase(),
            item.source.clone(),
        ))
    });
    items.sort_by_key(|item| match item.kind {
        AttributionKind::DockerContainer => 0,
        AttributionKind::NginxSite | AttributionKind::IisSite | AttributionKind::IisAppPool => 1,
        AttributionKind::NssmService => 2,
        AttributionKind::NodeApplication | AttributionKind::PythonApplication => 3,
        AttributionKind::WindowsService => 4,
    });
}

fn update_match_counts(reports: &mut [AttributionResolverReport], items: &[ServiceAttribution]) {
    let mut matched = HashSet::new();
    for item in items {
        let resolver = match item.kind {
            AttributionKind::DockerContainer => "Docker",
            AttributionKind::NginxSite => "Nginx",
            AttributionKind::IisSite | AttributionKind::IisAppPool => "IIS",
            AttributionKind::NssmService | AttributionKind::WindowsService => "Windows 服务 / NSSM",
            AttributionKind::NodeApplication | AttributionKind::PythonApplication => {
                "Node.js / Python"
            }
        };
        matched.insert(resolver);
    }
    for report in reports
        .iter_mut()
        .filter(|report| matched.contains(report.resolver.as_str()))
    {
        report.matched_count += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::types::{AttributionConfidence, ServiceAttribution};

    #[test]
    fn prioritizes_specific_workloads_and_keeps_distinct_virtual_hosts() {
        let make = |kind, name: &str| ServiceAttribution {
            kind,
            name: name.to_string(),
            description: None,
            confidence: AttributionConfidence::High,
            source: "test".to_string(),
            facts: Vec::new(),
        };
        let mut items = vec![
            make(AttributionKind::WindowsService, "Service"),
            make(AttributionKind::NginxSite, "a.test"),
            make(AttributionKind::NginxSite, "b.test"),
            make(AttributionKind::DockerContainer, "api"),
        ];
        deduplicate_and_sort(&mut items);
        assert_eq!(items[0].kind, AttributionKind::DockerContainer);
        assert_eq!(
            items
                .iter()
                .filter(|item| item.kind == AttributionKind::NginxSite)
                .count(),
            2
        );
    }
}
