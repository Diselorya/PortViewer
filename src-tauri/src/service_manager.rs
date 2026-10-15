use serde::{Deserialize, Serialize};

/// The management layer identified by attribution evidence, independent of the
/// workload name or runtime. Unknown never asserts that a process is unmanaged.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ServiceManager {
    Docker,
    Systemd,
    WindowsService,
    Nssm,
    Iis,
    Nginx,
    #[default]
    #[serde(other)]
    Unknown,
}

impl ServiceManager {
    pub fn from_kinds<'a>(kinds: impl IntoIterator<Item = &'a str>) -> Self {
        kinds
            .into_iter()
            .filter_map(|kind| match kind {
                "DockerContainer" => Some((0, Self::Docker)),
                "NssmService" => Some((1, Self::Nssm)),
                "WindowsService" => Some((2, Self::WindowsService)),
                "SystemdService" => Some((3, Self::Systemd)),
                "IisSite" | "IisAppPool" => Some((4, Self::Iis)),
                "NginxSite" => Some((5, Self::Nginx)),
                _ => None,
            })
            .min_by_key(|(priority, _)| *priority)
            .map(|(_, manager)| manager)
            .unwrap_or_default()
    }
}

#[cfg(test)]
#[path = "service_manager_tests.rs"]
mod tests;
