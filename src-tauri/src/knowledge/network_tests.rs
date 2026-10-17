use super::*;
use reqwest::header::HeaderMap;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

fn id(provider: &str, name: &str) -> PublicServiceId {
    PublicServiceId {
        provider: provider.into(),
        name: name.into(),
        version: None,
    }
}
fn reply(status: u16, value: Value) -> MockReply {
    MockReply {
        status,
        headers: HeaderMap::new(),
        body: serde_json::to_vec(&value).unwrap(),
    }
}
fn fixture(
    transport: impl Fn(&Url, Option<&Value>) -> Result<MockReply, Failure> + Send + Sync + 'static,
) -> Network {
    Network {
        limits: Mutex::new(Limits::default()),
        ai: None,
        github_token: None,
        proxy: Ok(None),
        mock: Some(Arc::new(transport)),
    }
}
fn lookup_ok(network: &Network, public: &PublicServiceId, ai: bool) -> Fetched {
    network
        .lookup(public, ai)
        .unwrap_or_else(|error| panic!("unexpected lookup failure: {}", error.status))
}
fn lookup_status(network: &Network, public: &PublicServiceId) -> &'static str {
    match network.lookup(public, false) {
        Err(error) => error.status,
        Ok(_) => panic!("lookup should fail"),
    }
}

#[test]
fn should_normalize_public_registry_coordinates() {
    assert_eq!(
        normalize_id(&id("github", "Owner/Project.git"))
            .unwrap()
            .name,
        "owner/project"
    );
    assert_eq!(
        normalize_id(&id("pypi", "Demo__Package.Name"))
            .unwrap()
            .name,
        "demo-package-name"
    );
    assert_eq!(
        normalize_id(&id("npm", "@scope/package")).unwrap().name,
        "@scope/package"
    );
}
#[test]
fn should_reject_private_paths_urls_and_invalid_coordinates() {
    for (provider, name) in [
        ("github", "owner/repo/extra"),
        ("github", "../repo"),
        ("npm", "C:/private/project"),
        ("npm", "https://registry.local/pkg"),
        ("npm", "UpperCase"),
        ("pypi", "-invalid"),
        ("file", "secret"),
        ("github", "owner/.git"),
        ("github", "owner/name?token=x"),
    ] {
        assert!(
            normalize_id(&id(provider, name)).is_err(),
            "accepted {provider}:{name}"
        );
    }
    let mut versioned = id("npm", "demo");
    versioned.version = Some("../../private".into());
    assert!(normalize_id(&versioned).is_err());
}
#[test]
fn should_accept_only_plain_https_github_repository_links() {
    assert_eq!(
        github_url("git+https://github.com/Owner/Demo.git")
            .unwrap()
            .name,
        "owner/demo"
    );
    for value in [
        "http://github.com/o/r",
        "https://user:pass@github.com/o/r",
        "https://github.com/o/r?token=x",
        "https://github.com/o/r/tree/main",
        "https://github.com.evil.test/o/r",
        "ssh://git@github.com/o/r",
    ] {
        assert!(github_url(value).is_none(), "accepted {value}");
    }
}
#[test]
fn should_allow_only_fixed_public_metadata_api_hosts() {
    for url in [
        "https://api.github.com/repos/o/r",
        "https://registry.npmjs.org/demo/latest",
        "https://pypi.org/pypi/demo/json",
    ] {
        assert!(valid_public_target(&Url::parse(url).unwrap()));
    }
    for url in [
        "http://api.github.com/repos/o/r",
        "https://127.0.0.1/",
        "https://169.254.169.254/",
        "https://api.github.com.evil.test/",
        "https://user:pass@api.github.com/",
        "https://api.github.com:444/",
        "https://pypi.org/#secret",
    ] {
        assert!(
            !valid_public_target(&Url::parse(url).unwrap()),
            "accepted {url}"
        );
    }
}
#[test]
fn should_reject_nonpublic_ipv4_ipv6_and_mapped_addresses() {
    for ip in [
        "0.0.0.0",
        "10.1.2.3",
        "127.0.0.1",
        "169.254.169.254",
        "172.16.0.1",
        "192.168.1.1",
        "100.64.0.1",
        "198.18.0.1",
        "192.0.2.1",
        "198.51.100.2",
        "203.0.113.4",
        "224.0.0.1",
        "255.255.255.255",
        "::",
        "::1",
        "::ffff:127.0.0.1",
        "::ffff:8.8.8.8",
        "fc00::1",
        "fe80::1",
        "ff02::1",
        "2001:db8::1",
        "2002:0808:0808::1",
        "3fff::1",
    ] {
        assert!(!globally_routable(ip.parse().unwrap()), "accepted {ip}");
    }
    for ip in [
        "8.8.8.8",
        "1.1.1.1",
        "2001:4860:4860::8888",
        "2606:4700:4700::1111",
    ] {
        assert!(globally_routable(ip.parse().unwrap()), "rejected {ip}");
    }
}
#[test]
fn should_fetch_npm_metadata_then_the_declared_public_repository() {
    let urls = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&urls);
    let network = fixture(move |url, body| {
        assert!(body.is_none());
        recorded.lock().unwrap().push(url.to_string());
        Ok(if url.host_str() == Some("registry.npmjs.org") {
            reply(
                200,
                json!({"description":"Registry description", "repository":{"url":"git+https://github.com/owner/demo.git"}}),
            )
        } else {
            reply(
                200,
                json!({"private":false,"description":"Repository description"}),
            )
        })
    });
    let fetched = lookup_ok(&network, &id("npm", "@scope/demo"), false);
    assert_eq!(
        fetched.software_summary.as_deref(),
        Some("Registry description")
    );
    assert_eq!(fetched.public_ids.len(), 2);
    assert_eq!(fetched.sources.len(), 2);
    assert!(fetched.candidates.is_empty());
    let urls = urls.lock().unwrap();
    assert!(urls[0].contains("@scope%2Fdemo/latest"));
    assert_eq!(urls[1], "https://api.github.com/repos/owner/demo");
}
#[test]
fn should_fetch_a_pypi_version_without_running_package_code() {
    // The package description remains useful even when repository follow-up is unavailable.
    let mut public = id("pypi", "demo");
    public.version = Some("1.2.0".into());
    // A transport must account for the declared repository request separately.
    let network = fixture(move |url, _| {
        if url.host_str() == Some("pypi.org") {
            assert_eq!(url.path(), "/pypi/demo/1.2.0/json");
            Ok(reply(
                200,
                json!({"info":{"summary":"Python library","project_urls":{"Source":"https://github.com/owner/demo"}}}),
            ))
        } else {
            Err(failure("offline", "fixture offline", 60))
        }
    });
    assert_eq!(
        lookup_ok(&network, &public, false)
            .software_summary
            .as_deref(),
        Some("Python library")
    );
}
#[test]
fn should_keep_repository_search_results_as_candidates_without_claiming_identity() {
    let network = fixture(|url, _| {
        Ok(if url.host_str() == Some("registry.npmjs.org") {
            reply(200, json!({"description":"Public package"}))
        } else {
            assert_eq!(url.path(), "/search/repositories");
            reply(
                200,
                json!({"items":[{"private":false,"full_name":"owner/demo","description":"Search match"},{"private":true,"full_name":"private/demo"},{"full_name":"unknown/demo"}]}),
            )
        })
    });
    let fetched = lookup_ok(&network, &id("npm", "demo"), false);
    assert_eq!(fetched.public_ids.len(), 1);
    assert_eq!(fetched.sources.len(), 2);
    assert!(fetched.sources.iter().any(|source| source.kind == "search"));
    assert_eq!(fetched.candidates.len(), 1);
    assert_eq!(fetched.candidates[0].name, "owner/demo");
}
#[test]
fn should_require_an_explicit_public_repository_flag() {
    for value in [
        json!({"private":true}),
        json!({"description":"no public flag"}),
        json!({"private":"false"}),
    ] {
        let network = fixture(move |_, _| Ok(reply(200, value.clone())));
        assert_eq!(
            lookup_status(&network, &id("github", "owner/demo")),
            "no_public_identifier"
        );
    }
}
#[test]
fn should_map_unavailable_missing_and_rate_limited_responses() {
    for (status, expected) in [
        (404, "no_public_identifier"),
        (503, "offline"),
        (403, "rate_limited"),
        (429, "rate_limited"),
    ] {
        let network = fixture(move |_, _| Ok(reply(status, json!({}))));
        assert_eq!(
            lookup_status(&network, &id("github", "owner/demo")),
            expected
        );
    }
    let network = fixture(|_, _| Err(failure("offline", "fixture network failed", 60)));
    assert_eq!(
        lookup_status(&network, &id("github", "owner/demo")),
        "offline"
    );
}
#[test]
fn should_reject_malformed_and_oversized_responses() {
    let network = fixture(|_, _| {
        Ok(MockReply {
            status: 200,
            headers: HeaderMap::new(),
            body: b"not JSON".to_vec(),
        })
    });
    assert_eq!(
        lookup_status(&network, &id("github", "owner/demo")),
        "error"
    );
    let network = fixture(|_, _| {
        Ok(MockReply {
            status: 200,
            headers: HeaderMap::new(),
            body: vec![b' '; BODY_LIMIT as usize + 1],
        })
    });
    assert_eq!(
        lookup_status(&network, &id("github", "owner/demo")),
        "error"
    );
    let network = fixture(|_, _| {
        let mut r = reply(200, json!({"private":false}));
        r.headers
            .insert("content-length", "262145".parse().unwrap());
        Ok(r)
    });
    assert_eq!(
        lookup_status(&network, &id("github", "owner/demo")),
        "error"
    );
}
#[test]
fn should_follow_bounded_same_api_repository_redirects() {
    let calls = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&calls);
    let network = fixture(move |url, _| {
        count.fetch_add(1, Ordering::SeqCst);
        if url.path() == "/repos/owner/demo" {
            let mut r = reply(301, json!({}));
            r.headers
                .insert("location", "/repositories/123".parse().unwrap());
            Ok(r)
        } else {
            Ok(reply(
                200,
                json!({"private":false,"description":"Moved repository"}),
            ))
        }
    });
    assert_eq!(
        lookup_ok(&network, &id("github", "owner/demo"), false)
            .software_summary
            .as_deref(),
        Some("Moved repository")
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}
#[test]
fn should_block_redirects_to_private_hosts_other_providers_and_credentials() {
    for location in [
        "http://127.0.0.1/admin",
        "https://169.254.169.254/latest/meta-data/",
        "https://registry.npmjs.org/demo",
        "https://api.github.com.evil.test/repos/o/r",
        "https://user:pass@api.github.com/repos/o/r",
        "https://api.github.com/search/repositories",
    ] {
        let location = location.to_owned();
        let calls = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&calls);
        let network = fixture(move |_, _| {
            count.fetch_add(1, Ordering::SeqCst);
            let mut r = reply(302, json!({}));
            r.headers.insert("location", location.parse().unwrap());
            Ok(r)
        });
        assert_eq!(
            lookup_status(&network, &id("github", "owner/demo")),
            "error"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
#[test]
fn should_stop_redirect_loops_after_three_requests() {
    let calls = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&calls);
    let network = fixture(move |_, _| {
        count.fetch_add(1, Ordering::SeqCst);
        let mut r = reply(302, json!({}));
        r.headers
            .insert("location", "/repos/owner/demo".parse().unwrap());
        Ok(r)
    });
    assert_eq!(
        lookup_status(&network, &id("github", "owner/demo")),
        "error"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 3);
}
#[test]
fn should_stop_requests_until_the_provider_rate_limit_reset() {
    let calls = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&calls);
    let network = fixture(move |_, _| {
        count.fetch_add(1, Ordering::SeqCst);
        let mut r = reply(429, json!({}));
        r.headers.insert("retry-after", "300".parse().unwrap());
        Ok(r)
    });
    assert_eq!(
        lookup_status(&network, &id("github", "owner/demo")),
        "rate_limited"
    );
    assert_eq!(
        lookup_status(&network, &id("github", "owner/other")),
        "rate_limited"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
#[test]
fn should_enforce_hourly_and_search_budgets_without_network() {
    let mut limits = Limits::default();
    for _ in 0..30 {
        assert!(limits.acquire(true, false).is_ok());
    }
    assert!(limits.acquire(true, false).is_err());
    let mut limits = Limits::default();
    for _ in 0..4 {
        assert!(limits.acquire(true, true).is_ok());
    }
    assert!(limits.acquire(true, true).is_err());
    let mut limits = Limits::default();
    limits.github.push_back(now().saturating_sub(3601));
    limits.search.push_back(now().saturating_sub(61));
    assert!(limits.acquire(true, true).is_ok());
    assert_eq!(limits.github.len(), 1);
    assert_eq!(limits.search.len(), 1);
}
#[test]
fn should_share_limits_between_concurrent_lookup_threads() {
    let calls = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&calls);
    let network = Arc::new(fixture(move |_, _| {
        count.fetch_add(1, Ordering::SeqCst);
        Ok(reply(200, json!({"private":false,"description":"Public"})))
    }));
    let threads = (0..40)
        .map(|_| {
            let network = Arc::clone(&network);
            std::thread::spawn(move || network.lookup(&id("github", "owner/demo"), false).is_ok())
        })
        .collect::<Vec<_>>();
    let successes = threads
        .into_iter()
        .map(|t| t.join().unwrap())
        .filter(|ok| *ok)
        .count();
    assert_eq!(successes, 30);
    assert_eq!(calls.load(Ordering::SeqCst), 30);
}
fn ai_fixture(source_ids: Value, captured: Arc<Mutex<Vec<Value>>>) -> Network {
    let mut network = fixture(move |url, body| {
        if let Some(body) = body {
            assert_eq!(url.as_str(), "https://ai.example.test/v1/chat/completions");
            captured.lock().unwrap().push(body.clone());
            Ok(reply(
                200,
                json!({"choices":[{"message":{"content":json!({"summary_zh":"公开软件的中文说明","source_ids":source_ids}).to_string()}}]}),
            ))
        } else {
            Ok(reply(
                200,
                json!({"private":false,"description":"Public software description"}),
            ))
        }
    });
    network.ai = Some(AiConfig {
        provider: "openai-compatible".into(),
        base: Url::parse("https://ai.example.test/v1").unwrap(),
        model: "fixture-model".into(),
        api_key: Some("fixture-key-never-serialize".into()),
        local: false,
    });
    network
}
#[test]
fn should_send_only_public_snippets_and_source_ids_to_optional_ai() {
    let bodies = Arc::new(Mutex::new(Vec::new()));
    let network = ai_fixture(json!(["github:owner/demo@latest"]), Arc::clone(&bodies));
    let fetched = lookup_ok(&network, &id("github", "owner/demo"), true);
    assert_eq!(fetched.ai_summary.as_deref(), Some("公开软件的中文说明"));
    assert!(fetched.sources.iter().any(|s| s.kind == "ai"));
    let bodies = bodies.lock().unwrap();
    assert_eq!(bodies.len(), 1);
    let user = &bodies[0]["messages"][1]["content"];
    let content: Value = serde_json::from_str(user.as_str().unwrap()).unwrap();
    assert_eq!(
        content,
        json!({"public_description":"Public software description","source_ids":["github:owner/demo@latest"]})
    );
    assert!(!bodies[0]
        .to_string()
        .contains("fixture-key-never-serialize"));
}
#[test]
fn should_reject_ai_answers_without_valid_citations_and_keep_public_description() {
    for ids in [json!([]), json!(["invented-source"]), json!([42])] {
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let network = ai_fixture(ids, bodies);
        let fetched = lookup_ok(&network, &id("github", "owner/demo"), true);
        assert!(fetched.ai_summary.is_none());
        assert_eq!(
            fetched.software_summary.as_deref(),
            Some("Public software description")
        );
    }
}
#[test]
fn should_never_call_ai_when_the_user_has_disabled_it() {
    let bodies = Arc::new(Mutex::new(Vec::new()));
    let network = ai_fixture(json!(["github:owner/demo@latest"]), Arc::clone(&bodies));
    assert!(lookup_ok(&network, &id("github", "owner/demo"), false)
        .ai_summary
        .is_none());
    assert!(bodies.lock().unwrap().is_empty());
}

#[test]
fn should_reject_even_same_host_redirects_when_metadata_proxy_is_active() {
    let calls = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&calls);
    let mut network = fixture(move |_, _| {
        count.fetch_add(1, Ordering::SeqCst);
        let mut response = reply(301, json!({}));
        response
            .headers
            .insert("location", "/repositories/123".parse().unwrap());
        Ok(response)
    });
    network.proxy = Ok(Some(
        super::super::proxy::MetadataProxy::parse("http://127.0.0.1:7890").unwrap(),
    ));
    assert_eq!(
        lookup_status(&network, &id("github", "owner/demo")),
        "error"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn should_reject_invalid_metadata_proxy_before_calling_transport() {
    let calls = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&calls);
    let mut network = fixture(move |_, _| {
        count.fetch_add(1, Ordering::SeqCst);
        Ok(reply(200, json!({"private": false})))
    });
    network.proxy = Err("知识代理配置无效");
    assert_eq!(
        lookup_status(&network, &id("github", "owner/demo")),
        "error"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn should_allow_cold_metadata_tls_and_ai_responses_with_bounded_timeouts() {
    assert_eq!(
        request_timeouts(true),
        (Duration::from_secs(5), Duration::from_secs(15))
    );
    assert_eq!(
        request_timeouts(false),
        (Duration::from_secs(5), Duration::from_secs(45))
    );
}

#[test]
fn should_retry_transient_metadata_http_status_once_and_charge_each_attempt() {
    for status in [500, 502, 503, 504] {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&calls);
        let network = fixture(move |_, _| {
            Ok(if count.fetch_add(1, Ordering::SeqCst) == 0 {
                reply(status, json!({}))
            } else {
                reply(
                    200,
                    json!({"private":false,"description":"Recovered public description"}),
                )
            })
        });
        let fetched = lookup_ok(&network, &id("github", "owner/demo"), false);
        assert_eq!(
            fetched.software_summary.as_deref(),
            Some("Recovered public description")
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let limits = network.limits.lock().unwrap();
        assert_eq!(limits.github.len(), 2);
        assert_eq!(limits.all.len(), 2);
    }
}

#[test]
fn should_retry_a_metadata_connection_or_timeout_failure_once() {
    let calls = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&calls);
    let network = fixture(move |_, _| {
        if count.fetch_add(1, Ordering::SeqCst) == 0 {
            Err(failure("offline", "fixture timeout", 60))
        } else {
            Ok(reply(200, json!({"private":false})))
        }
    });
    lookup_ok(&network, &id("github", "owner/demo"), false);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[test]
fn should_stop_after_the_second_transient_metadata_failure() {
    let calls = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&calls);
    let network = fixture(move |_, _| {
        count.fetch_add(1, Ordering::SeqCst);
        Ok(reply(503, json!({})))
    });
    assert_eq!(
        lookup_status(&network, &id("github", "owner/demo")),
        "offline"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[test]
fn should_never_retry_permanent_metadata_statuses_or_transport_policy_errors() {
    for status in [400, 401, 403, 404, 429, 501] {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&calls);
        let network = fixture(move |_, _| {
            count.fetch_add(1, Ordering::SeqCst);
            Ok(reply(status, json!({})))
        });
        assert!(network.lookup(&id("github", "owner/demo"), false).is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    for status in ["error", "rate_limited", "no_public_identifier"] {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&calls);
        let network = fixture(move |_, _| {
            count.fetch_add(1, Ordering::SeqCst);
            Err(failure(status, "fixture policy rejection", 60))
        });
        assert_eq!(lookup_status(&network, &id("github", "owner/demo")), status);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn should_never_retry_malformed_or_oversized_metadata_bodies() {
    for body in [b"not JSON".to_vec(), vec![b' '; BODY_LIMIT as usize + 1]] {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&calls);
        let network = fixture(move |_, _| {
            count.fetch_add(1, Ordering::SeqCst);
            Ok(MockReply {
                status: 200,
                headers: HeaderMap::new(),
                body: body.clone(),
            })
        });
        assert_eq!(
            lookup_status(&network, &id("github", "owner/demo")),
            "error"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn should_reject_an_invalid_metadata_target_before_any_retry_or_transport() {
    let calls = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&calls);
    let network = fixture(move |_, _| {
        count.fetch_add(1, Ordering::SeqCst);
        Ok(reply(503, json!({})))
    });
    assert!(network
        .json(Url::parse("https://127.0.0.1/private").unwrap())
        .is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(network.limits.lock().unwrap().all.is_empty());
}

#[test]
fn should_stop_retry_before_transport_when_the_github_budget_is_exhausted() {
    let calls = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&calls);
    let network = fixture(move |_, _| {
        count.fetch_add(1, Ordering::SeqCst);
        Ok(reply(503, json!({})))
    });
    {
        let mut limits = network.limits.lock().unwrap();
        limits.github = VecDeque::from(vec![now(); 29]);
        limits.all = VecDeque::from(vec![now(); 29]);
    }
    assert_eq!(
        lookup_status(&network, &id("github", "owner/demo")),
        "rate_limited"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let limits = network.limits.lock().unwrap();
    assert_eq!(limits.github.len(), 30);
    assert_eq!(limits.all.len(), 30);
}

#[test]
fn should_share_one_transient_retry_allowance_across_metadata_redirects() {
    let calls = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&calls);
    let network = fixture(move |_, _| {
        let attempt = count.fetch_add(1, Ordering::SeqCst);
        if attempt == 1 {
            let mut response = reply(301, json!({}));
            response
                .headers
                .insert("location", "/repositories/123".parse().unwrap());
            Ok(response)
        } else {
            Ok(reply(503, json!({})))
        }
    });
    assert_eq!(
        lookup_status(&network, &id("github", "owner/demo")),
        "offline"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 3);
}

#[test]
fn should_preserve_the_two_redirect_cap_after_a_transient_retry() {
    let calls = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&calls);
    let network = fixture(move |_, _| {
        let attempt = count.fetch_add(1, Ordering::SeqCst);
        if attempt == 0 {
            return Ok(reply(503, json!({})));
        }
        let mut response = reply(301, json!({}));
        response.headers.insert(
            "location",
            format!("/repositories/{attempt}").parse().unwrap(),
        );
        Ok(response)
    });
    assert_eq!(
        lookup_status(&network, &id("github", "owner/demo")),
        "error"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 4);
}

#[test]
fn should_not_automatically_retry_ai_post_failures() {
    for transport_failure in [true, false] {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&calls);
        let network = fixture(move |_, body| {
            assert!(body.is_some());
            count.fetch_add(1, Ordering::SeqCst);
            if transport_failure {
                Err(failure("offline", "fixture AI timeout", 60))
            } else {
                Ok(reply(503, json!({})))
            }
        });
        let ai = AiConfig {
            provider: "ollama".into(),
            base: Url::parse("http://127.0.0.1:11434/v1").unwrap(),
            model: "fixture".into(),
            api_key: None,
            local: true,
        };
        assert!(network
            .ai_json(
                &ai,
                Url::parse("http://127.0.0.1:11434/v1/chat/completions").unwrap(),
                &json!({"public_description":"Public only"})
            )
            .is_none());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn should_not_retry_dns_policy_rejection_wrapped_by_reqwest_hyper_and_io() {
    struct RefusingResolver(Arc<AtomicUsize>);
    impl reqwest::dns::Resolve for RefusingResolver {
        fn resolve(&self, _: reqwest::dns::Name) -> reqwest::dns::Resolving {
            self.0.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Err(std::io::Error::other(DnsPolicyRejected).into()) })
        }
    }
    let dns_calls = Arc::new(AtomicUsize::new(0));
    let client = Client::builder()
        .no_proxy()
        .dns_resolver(Arc::new(RefusingResolver(Arc::clone(&dns_calls))))
        .connect_timeout(Duration::from_secs(1))
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    // The resolver produces no address: this constructs the real error chain without a socket connection.
    let error = client
        .get("https://api.github.com/repos/owner/demo")
        .send()
        .expect_err("the controlled DNS resolver must reject the request");
    assert_eq!(dns_calls.load(Ordering::SeqCst), 1);
    assert!(
        error.is_connect(),
        "reqwest should expose DNS rejection as a connect error"
    );
    assert!(is_dns_policy_rejection(&error));
    assert!(!retryable_transport_error(&error));
    let mapped = transport_failure(&error);
    assert_eq!(mapped.status, "error");
    let pending = Mutex::new(Some(mapped));
    let calls = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&calls);
    let network = fixture(move |_, _| {
        count.fetch_add(1, Ordering::SeqCst);
        Err(pending
            .lock()
            .unwrap()
            .take()
            .expect("DNS policy rejection must not retry"))
    });
    assert_eq!(
        lookup_status(&network, &id("github", "owner/demo")),
        "error"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let limits = network.limits.lock().unwrap();
    assert_eq!(limits.github.len(), 1);
    assert_eq!(limits.all.len(), 1);
}

#[test]
fn should_find_typed_dns_rejection_inside_nested_io_get_ref_wrappers() {
    let wrapped = std::io::Error::other(std::io::Error::other(DnsPolicyRejected));
    assert!(is_dns_policy_rejection(&wrapped));
    let ordinary = std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        "DNS policy rejected text alone",
    );
    assert!(!is_dns_policy_rejection(&ordinary));
}

#[test]
fn should_bound_dns_policy_error_traversal_when_a_source_chain_has_a_cycle() {
    #[derive(Debug)]
    struct CyclicError;
    impl std::fmt::Display for CyclicError {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("fixture cyclic error")
        }
    }
    impl std::error::Error for CyclicError {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            Some(self)
        }
    }
    assert!(!is_dns_policy_rejection(&CyclicError));
}
