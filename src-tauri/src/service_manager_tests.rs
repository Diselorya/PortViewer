use super::ServiceManager;
use serde::{Deserialize, Serialize};

#[test]
fn should_identify_each_management_layer_from_attribution_evidence() {
    for (kind, expected) in [
        ("DockerContainer", ServiceManager::Docker),
        ("NssmService", ServiceManager::Nssm),
        ("WindowsService", ServiceManager::WindowsService),
        ("SystemdService", ServiceManager::Systemd),
        ("IisSite", ServiceManager::Iis),
        ("IisAppPool", ServiceManager::Iis),
        ("NginxSite", ServiceManager::Nginx),
    ] {
        assert_eq!(ServiceManager::from_kinds([kind]), expected, "{kind}");
    }
}

#[test]
fn should_prefer_container_management_over_runtime_and_host_services() {
    let kinds = ["NodeApplication", "SystemdService", "DockerContainer"];
    assert_eq!(ServiceManager::from_kinds(kinds), ServiceManager::Docker);
    assert_eq!(
        ServiceManager::from_kinds(kinds.into_iter().rev()),
        ServiceManager::Docker
    );
}

#[test]
fn should_apply_manager_precedence_independently_of_candidate_order() {
    for (preferred, fallback, expected) in [
        ("DockerContainer", "NssmService", ServiceManager::Docker),
        ("NssmService", "WindowsService", ServiceManager::Nssm),
        (
            "WindowsService",
            "SystemdService",
            ServiceManager::WindowsService,
        ),
        ("SystemdService", "IisAppPool", ServiceManager::Systemd),
        ("IisSite", "NginxSite", ServiceManager::Iis),
    ] {
        assert_eq!(ServiceManager::from_kinds([preferred, fallback]), expected);
        assert_eq!(ServiceManager::from_kinds([fallback, preferred]), expected);
    }
}

#[test]
fn should_keep_unknown_when_only_program_or_runtime_identity_is_known() {
    assert_eq!(ServiceManager::from_kinds([]), ServiceManager::Unknown);
    assert_eq!(
        ServiceManager::from_kinds(["NodeApplication", "PythonApplication", "SystemProcess"]),
        ServiceManager::Unknown
    );
    assert_eq!(
        ServiceManager::from_kinds(["future-manager", "docker-proxy", "systemd"]),
        ServiceManager::Unknown
    );
}

#[test]
fn should_preserve_enum_values_across_json_round_trips() {
    for (manager, json) in [
        (ServiceManager::Docker, "\"Docker\""),
        (ServiceManager::Systemd, "\"Systemd\""),
        (ServiceManager::WindowsService, "\"WindowsService\""),
        (ServiceManager::Nssm, "\"Nssm\""),
        (ServiceManager::Iis, "\"Iis\""),
        (ServiceManager::Nginx, "\"Nginx\""),
        (ServiceManager::Unknown, "\"Unknown\""),
    ] {
        assert_eq!(serde_json::to_string(&manager).unwrap(), json);
        assert_eq!(
            serde_json::from_str::<ServiceManager>(json).unwrap(),
            manager
        );
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct LegacyCompatibleEndpoint {
    #[serde(default)]
    service_manager: ServiceManager,
}

#[test]
fn should_read_legacy_snapshots_without_a_service_manager_field() {
    let endpoint: LegacyCompatibleEndpoint = serde_json::from_str("{}").unwrap();
    assert_eq!(endpoint.service_manager, ServiceManager::Unknown);
}

#[test]
fn should_read_future_manager_values_as_unknown_without_losing_the_endpoint() {
    let endpoint: LegacyCompatibleEndpoint =
        serde_json::from_str(r#"{"service_manager":"FutureSupervisor"}"#).unwrap();
    assert_eq!(endpoint.service_manager, ServiceManager::Unknown);
}
