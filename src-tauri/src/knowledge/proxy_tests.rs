use super::*;

fn configured(server: &str) -> SystemProxySettings {
    SystemProxySettings {
        enabled: true,
        server: Some(server.into()),
        ..SystemProxySettings::default()
    }
}

#[test]
fn should_accept_explicit_numeric_loopback_http_and_https_proxies() {
    for (input, expected) in [
        ("http://127.0.0.1:7890", "http://127.0.0.1:7890/"),
        ("https://127.0.0.2:9443/", "https://127.0.0.2:9443/"),
        ("http://[::1]:8080", "http://[::1]:8080/"),
        (" HTTPS://127.0.0.1:443 ", "https://127.0.0.1/"),
    ] {
        assert_eq!(MetadataProxy::parse(input).unwrap().url.as_str(), expected);
    }
}

#[test]
fn should_reject_nonloopback_ambiguous_and_credential_bearing_proxies() {
    for input in [
        "",
        "127.0.0.1:7890",
        "socks5://127.0.0.1:7890",
        "http://localhost:7890",
        "http://127.0.0.1",
        "http://127.1:7890",
        "http://127.0.0.1:0",
        "http://127.0.0.1:65536",
        "http://192.168.1.2:7890",
        "https://example.com:443",
        "http://[::]:7890",
        "http://[::ffff:192.168.1.2]:7890",
        "http://fixture-user:fixture-secret@127.0.0.1:7890",
        "http://127.0.0.1:7890/path",
        "http://127.0.0.1:7890?token=fixture-secret",
        "http://127.0.0.1:7890#fixture-secret",
        "http://127.0.0.1:7890\n",
    ] {
        assert!(
            MetadataProxy::parse(input).is_err(),
            "accepted unsafe fixture proxy"
        );
    }
}

#[test]
fn should_bound_proxy_input_and_never_include_rejected_credentials_in_errors() {
    assert!(MetadataProxy::parse(&"a".repeat(2049)).is_err());
    let input = "http://fixture-user:fixture-secret@127.0.0.1:7890";
    let message = match MetadataProxy::parse(input) {
        Err(message) => message,
        Ok(_) => panic!("credentials accepted"),
    };
    assert!(!message.contains(input));
    assert!(!message.contains("fixture-secret"));
    assert!(!message.contains("fixture-user"));
}

#[test]
fn should_allow_proxy_connect_only_to_fixed_https_metadata_hosts() {
    let proxy = MetadataProxy::parse("http://127.0.0.1:7890").unwrap();
    for target in [
        "https://api.github.com/repos/o/r",
        "https://registry.npmjs.org/demo/latest",
        "https://pypi.org/pypi/demo/json",
    ] {
        assert!(proxy.for_target(&Url::parse(target).unwrap()).is_ok());
    }
    for target in [
        "http://api.github.com/repos/o/r",
        "https://example.com/",
        "https://127.0.0.1/",
        "https://api.github.com.evil.test/",
        "https://user:fixture-secret@api.github.com/",
        "https://api.github.com:444/",
        "https://pypi.org/#fixture-secret",
    ] {
        assert!(proxy.for_target(&Url::parse(target).unwrap()).is_err());
    }
}

#[test]
fn should_prefer_explicit_proxy_over_disabled_or_different_system_configuration() {
    let system = SystemProxySettings {
        enabled: false,
        auto_detect: true,
        has_pac: true,
        server: Some("127.0.0.1:8000".into()),
    };
    let selected = choose(Some("http://127.0.0.1:9000"), &system)
        .unwrap()
        .unwrap();
    assert_eq!(selected.url.port(), Some(9000));
}

#[test]
fn should_fail_invalid_explicit_proxy_without_silent_system_fallback() {
    assert!(choose(
        Some("http://192.168.1.2:7890"),
        &configured("127.0.0.1:8000")
    )
    .is_err());
    assert!(choose(Some(""), &configured("127.0.0.1:8000")).is_err());
}

#[test]
fn should_skip_disabled_pac_or_auto_detect_system_proxies() {
    for (enabled, auto_detect, has_pac) in [
        (false, false, false),
        (true, true, false),
        (true, false, true),
    ] {
        let system = SystemProxySettings {
            enabled,
            auto_detect,
            has_pac,
            server: Some("127.0.0.1:7890".into()),
        };
        assert!(choose(None, &system).unwrap().is_none());
    }
    assert!(choose(None, &SystemProxySettings::default())
        .unwrap()
        .is_none());
}

#[test]
fn should_select_https_system_endpoint_or_single_numeric_endpoint() {
    for (value, port) in [
        ("127.0.0.1:7890", 7890),
        (
            "http=192.168.1.2:8000; https=127.0.0.1:7891; socks=127.0.0.1:7892",
            7891,
        ),
        ("HTTPS=[::1]:7893", 7893),
        ("https://127.0.0.1:9443", 9443),
    ] {
        let proxy = choose(None, &configured(value)).unwrap().unwrap();
        assert_eq!(proxy.url.port(), Some(port));
    }
}

#[test]
fn should_ignore_unsupported_system_proxy_settings_without_leaking_them() {
    for value in [
        "http=127.0.0.1:7890",
        "https=127.0.0.1:7890;https=127.0.0.1:7891",
        "127.0.0.1:7890;127.0.0.1:7891",
        "https=192.168.1.2:7890",
        "https=localhost:7890",
        "https=fixture-user:fixture-secret@127.0.0.1:7890",
        "https=127.0.0.1:7890/path",
        "https=127.0.0.1:7890\r\n",
    ] {
        assert!(
            choose(None, &configured(value)).unwrap().is_none(),
            "accepted unsupported system fixture"
        );
    }
    assert!(system_endpoint(&"a".repeat(4097)).is_none());
}
