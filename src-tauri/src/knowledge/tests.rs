use super::*;
use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};

fn directory(label: &str) -> PathBuf {
    static COUNT: AtomicU64 = AtomicU64::new(0);
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".tmp/knowledge-tests");
    let path = root.join(format!(
        "{label}-{}-{}",
        std::process::id(),
        COUNT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&path).unwrap();
    path
}
fn fetched() -> Fetched {
    Fetched {
        software_summary: Some("Public software documentation".into()),
        public_ids: vec![PublicServiceId {
            provider: "github".into(),
            name: "owner/demo".into(),
            version: None,
        }],
        sources: vec![KnowledgeSource {
            id: "public-source".into(),
            kind: "github".into(),
            title: "GitHub: owner/demo".into(),
            url: Some("https://github.com/owner/demo".into()),
            fetched_at: Some(timestamp()),
        }],
        candidates: Vec::new(),
        updated_at: timestamp(),
        expires_at: now() + 3600,
        ai_summary: Some("AI软件说明".into()),
    }
}
fn test_manager() -> Manager {
    let (profile_tx, _) = mpsc::sync_channel(1);
    let (host_tx, _) = mpsc::sync_channel(1);
    Manager {
        state: Mutex::new(State {
            settings: KnowledgeSettings {
                online_enabled: false,
                ai_enabled: false,
                reverse_dns_enabled: false,
            },
            profiles: BTreeMap::new(),
            profile_seen: BTreeMap::new(),
            cache: BTreeMap::new(),
            pending: BTreeSet::new(),
            attempts: BTreeMap::new(),
            retry: BTreeMap::new(),
            failures: BTreeMap::new(),
            observed: BTreeSet::new(),
            hosts: BTreeMap::new(),
        }),
        profile_tx,
        host_tx,
        network: Network::new(),
        directory: None,
        persist_lock: Mutex::new(()),
        ignore_offline: false,
    }
}

#[test]
fn should_preserve_actual_workload_purpose_when_public_metadata_arrives() {
    let mut profile = empty_profile("local:demo".into(), "orders".into(), "workload");
    profile.summary = Some("本机订单接口".into());
    profile.sources.push(KnowledgeSource {
        id: "local".into(),
        kind: "local".into(),
        title: "systemd Description".into(),
        url: None,
        fetched_at: None,
    });
    apply_fetched(&mut profile, &fetched(), false);
    assert_eq!(profile.summary.as_deref(), Some("本机订单接口"));
    assert_eq!(
        profile.software_summary.as_deref(),
        Some("Public software documentation")
    );
    assert!(profile.sources.iter().any(|s| s.kind == "local"));
    assert!(!profile.sources.iter().any(|s| s.kind == "ai"));
}
#[test]
fn should_enable_optional_ai_only_for_the_software_summary() {
    let mut profile = empty_profile("local:demo".into(), "orders".into(), "workload");
    profile.summary = Some("真实用途".into());
    let mut public = fetched();
    public.sources.push(KnowledgeSource {
        id: "ai-summary".into(),
        kind: "ai".into(),
        title: "AI整理".into(),
        url: None,
        fetched_at: None,
    });
    apply_fetched(&mut profile, &public, true);
    assert_eq!(profile.software_summary.as_deref(), Some("AI软件说明"));
    assert_eq!(profile.summary.as_deref(), Some("真实用途"));
    apply_fetched(&mut profile, &public, false);
    assert_eq!(
        profile.software_summary.as_deref(),
        Some("Public software documentation")
    );
    assert!(!profile.sources.iter().any(|s| s.kind == "ai"));
}
#[test]
fn should_mark_expired_metadata_stale_and_clear_old_errors() {
    let mut profile = empty_profile("local:demo".into(), "orders".into(), "workload");
    profile.message = Some("old network error".into());
    let mut public = fetched();
    public.expires_at = now().saturating_sub(1);
    apply_fetched(&mut profile, &public, false);
    assert!(profile.stale);
    assert_eq!(profile.enrichment_status, "ready");
    assert!(profile.message.is_none());
}
#[test]
fn should_deduplicate_sources_when_reapplying_cached_metadata() {
    let mut profile = empty_profile("local:demo".into(), "orders".into(), "workload");
    let public = fetched();
    apply_fetched(&mut profile, &public, false);
    apply_fetched(&mut profile, &public, false);
    assert_eq!(profile.sources.len(), 1);
}
#[test]
fn should_keep_manual_public_lookup_separate_from_confirmed_local_identity() {
    let profile = public_profile(&PublicServiceId {
        provider: "github".into(),
        name: "owner/demo".into(),
        version: None,
    });
    assert!(profile.id.starts_with("public:"));
    assert_eq!(profile.identity_match, "unresolved");
    assert!(profile.summary.is_none());
}
#[test]
fn should_register_local_profiles_without_network_when_online_is_disabled() {
    let manager = test_manager();
    let mut profile = empty_profile("local:one".into(), "orders".into(), "workload");
    profile.public_ids = fetched().public_ids;
    manager.register(profile);
    let state = manager.state.lock().unwrap();
    assert_eq!(state.profiles["local:one"].enrichment_status, "disabled");
    assert!(state.pending.is_empty());
}
#[test]
fn should_bound_registered_profiles_and_still_allow_existing_profile_updates() {
    let manager = test_manager();
    for i in 0..MAX_PROFILES + 1 {
        manager.register(empty_profile(
            format!("local:{i}"),
            "test".into(),
            "workload",
        ));
    }
    let mut existing = empty_profile("local:0".into(), "updated".into(), "workload");
    existing.summary = Some("changed purpose".into());
    manager.register(existing);
    let state = manager.state.lock().unwrap();
    assert_eq!(state.profiles.len(), MAX_PROFILES);
    assert_eq!(state.profiles["local:0"].original_name, "updated");
}
#[test]
fn should_roundtrip_positive_and_negative_cache_without_losing_settings() {
    let dir = directory("roundtrip");
    let mut disk = cache::Disk::default();
    disk.settings.online_enabled = false;
    disk.records
        .insert("github:owner/demo@latest".into(), fetched());
    disk.failures.insert(
        "npm:missing@latest".into(),
        cache::CachedFailure {
            status: "no_public_identifier".into(),
            message: "not found".into(),
            retry_at: now() + 3600,
        },
    );
    cache::save(Some(&dir), &disk).unwrap();
    let result = cache::load(Some(&dir));
    assert!(!result.settings.online_enabled);
    assert_eq!(result.records.len(), 1);
    assert_eq!(result.failures.len(), 1);
    disk.settings.online_enabled = true;
    cache::save(Some(&dir), &disk).unwrap();
    assert!(cache::load(Some(&dir)).settings.online_enabled);
}
#[test]
fn should_ignore_corrupt_and_oversized_cache_files() {
    let dir = directory("invalid");
    let file = dir.join("knowledge-v1.json");
    fs::write(&file, b"not JSON").unwrap();
    assert!(cache::load(Some(&dir)).records.is_empty());
    fs::File::create(&file)
        .unwrap()
        .set_len(10 * 1024 * 1024 + 1)
        .unwrap();
    assert!(cache::load(Some(&dir)).records.is_empty());
}
#[test]
fn should_reject_relative_cache_paths_and_accept_disabled_persistence() {
    assert!(cache::save(
        Some(std::path::Path::new("relative/knowledge")),
        &cache::Disk::default()
    )
    .is_err());
    assert!(
        cache::load(Some(std::path::Path::new("relative/knowledge")))
            .records
            .is_empty()
    );
    assert!(cache::save(None, &cache::Disk::default()).is_ok());
}
#[test]
fn should_reject_cache_records_with_local_sources_or_untrusted_urls() {
    let dir = directory("untrusted");
    let mut disk = cache::Disk::default();
    disk.records.insert("valid".into(), fetched());
    let mut local = fetched();
    local.sources[0].kind = "local".into();
    disk.records.insert("local".into(), local);
    for (index, url) in [
        "https://127.0.0.1/",
        "https://github.com/owner/demo?secret=token",
        "https://user:pass@github.com/owner/demo",
        "http://github.com/owner/demo",
    ]
    .iter()
    .enumerate()
    {
        let mut bad = fetched();
        bad.sources[0].url = Some((*url).into());
        disk.records.insert(format!("bad-{index}"), bad);
    }
    cache::save(Some(&dir), &disk).unwrap();
    let loaded = cache::load(Some(&dir));
    assert_eq!(loaded.records.len(), 1);
    assert!(loaded.records.contains_key("valid"));
}
#[test]
fn should_bound_cache_record_count_and_discard_expired_negative_entries() {
    let dir = directory("bound");
    let mut disk = cache::Disk::default();
    for i in 0..1005 {
        disk.records.insert(format!("entry-{i:04}"), fetched());
    }
    disk.failures.insert(
        "expired".into(),
        cache::CachedFailure {
            status: "offline".into(),
            message: "expired".into(),
            retry_at: now().saturating_sub(1),
        },
    );
    disk.failures.insert(
        "invalid".into(),
        cache::CachedFailure {
            status: "forged-status".into(),
            message: "bad".into(),
            retry_at: now() + 60,
        },
    );
    cache::save(Some(&dir), &disk).unwrap();
    let loaded = cache::load(Some(&dir));
    assert_eq!(loaded.records.len(), 1000);
    assert!(loaded.failures.is_empty());
}
#[cfg(unix)]
#[test]
fn should_refuse_cache_directories_that_are_symbolic_links() {
    let root = directory("symlink");
    let target = root.join("target");
    fs::create_dir(&target).unwrap();
    let link = root.join("link");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    assert!(cache::save(Some(&link), &cache::Disk::default()).is_err());
    assert!(cache::load(Some(&link)).records.is_empty());
}
#[test]
fn should_classify_hosts_without_claiming_a_complete_interface_inventory() {
    for (address, kind) in [
        ("0.0.0.0", "wildcard"),
        ("::", "wildcard"),
        ("127.0.0.1", "loopback"),
        ("::1", "loopback"),
        ("::ffff:127.0.0.1", "loopback"),
        ("::ffff:192.168.1.2", "private"),
        ("192.168.1.2", "private"),
        ("fc00::1", "private"),
        ("169.254.1.2", "link_local"),
        ("fe80::1", "link_local"),
        ("224.0.0.1", "multicast"),
        ("8.8.8.8", "public"),
    ] {
        assert_eq!(host::classify(address.parse().unwrap()), kind);
    }
    let observed = vec!["192.168.1.2".into()];
    let local = host::initial(Some("192.168.1.2".parse().unwrap()), &observed);
    assert!(local.is_local);
    assert_eq!(local.observed_addresses, observed);
    let mapped = host::initial(Some("::ffff:192.168.1.2".parse().unwrap()), &observed);
    assert!(mapped.is_local);
    let peer = host::initial(Some("192.168.1.3".parse().unwrap()), &observed);
    assert!(!peer.is_local);
    assert!(peer.machine_name.is_none());
    assert!(peer.os.is_none());
    assert!(peer.observed_addresses.is_empty());
}
#[test]
fn should_reject_hostnames_paths_and_arbitrary_profile_request_fields() {
    for address in [
        "example.com",
        "https://127.0.0.1/",
        "127.0.0.1:80",
        "C:/private",
        "1.1.1.1?token=x",
    ] {
        assert!(host_context(Some(address)).is_err());
    }
    assert!(serde_json::from_value::<ServiceProfilesQuery>(
        serde_json::json!({"entries":[],"url":"http://localhost"})
    )
    .is_err());
    assert!(profiles(ServiceProfilesQuery {
        profile_ids: Some(vec!["bad identity!".into()]),
        ..Default::default()
    })
    .is_err());
    assert!(profiles(ServiceProfilesQuery {
        profile_ids: Some(vec!["a".into(); 129]),
        ..Default::default()
    })
    .is_err());
}
#[test]
fn should_reject_knowledge_configuration_writes_without_local_authority() {
    assert!(set_settings(KnowledgeSettings::default(), false).is_err());
}
#[test]
fn should_keep_catalog_chinese_names_and_public_coordinates_consistent() {
    let entries = catalog::entries();
    assert!(entries.len() >= 30);
    let mut ids = BTreeSet::new();
    for entry in entries {
        assert!(ids.insert(&entry.id));
        assert!(!entry.display_name_zh.is_empty());
        assert!(!entry.summary.is_empty());
        assert!(matches!(
            entry.component_role.as_str(),
            "workload" | "launcher" | "runtime" | "manager" | "system"
        ));
        assert!(entry.source_url.starts_with("https://"));
        for id in &entry.public_ids {
            assert!(network::normalize_id(id).is_ok());
        }
    }
    assert!(catalog::process("NODE.EXE").is_some());
    assert!(catalog::process("python3.12").is_some());
    assert!(catalog::launcher("vite").is_some());
}
#[test]
fn should_read_static_node_project_metadata_without_running_package_scripts() {
    let dir = directory("node-project");
    fs::create_dir_all(dir.join("src")).unwrap();
    fs::write(dir.join("package.json"),serde_json::json!({"name":"private-orders","description":"订单项目","private":true,"scripts":{"postinstall":"DO NOT RUN"}}).to_string()).unwrap();
    let tokens = vec![
        "node".into(),
        dir.join("src/server.js").to_string_lossy().into_owned(),
    ];
    let project = local::project(&tokens, false).unwrap();
    assert_eq!(project.name.as_deref(), Some("private-orders"));
    assert_eq!(project.description.as_deref(), Some("订单项目"));
    assert!(project.private);
    assert_eq!(project.root, dir);
}
#[test]
fn should_separate_a_node_modules_launcher_from_the_actual_app_project() {
    let dir = directory("node-launcher");
    let launcher_dir = dir.join("node_modules/vite/bin");
    fs::create_dir_all(&launcher_dir).unwrap();
    fs::write(
        dir.join("package.json"),
        serde_json::json!({"name":"orders-app","description":"本机订单项目","private":true})
            .to_string(),
    )
    .unwrap();
    fs::write(
        dir.join("node_modules/vite/package.json"),
        serde_json::json!({"name":"vite","description":"Frontend build tool"}).to_string(),
    )
    .unwrap();
    let tokens = vec![
        "node".into(),
        launcher_dir.join("vite.js").to_string_lossy().into_owned(),
    ];
    assert_eq!(local::launcher(&tokens, false).as_deref(), Some("vite"));
    let project = local::project(&tokens, false).unwrap();
    assert_eq!(project.name.as_deref(), Some("orders-app"));
    assert_eq!(project.description.as_deref(), Some("本机订单项目"));
}
#[test]
fn should_read_pep621_and_poetry_metadata_as_local_only() {
    for (label, text, name) in [
        (
            "pep621",
            "[project]\nname = 'orders-api'\ndescription = '订单 API'\n",
            "orders-api",
        ),
        (
            "poetry",
            "[tool.poetry]\nname = 'worker-app'\ndescription = '后台任务'\n",
            "worker-app",
        ),
    ] {
        let dir = directory(label);
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("pyproject.toml"), text).unwrap();
        let project = local::project(
            &[
                "python".into(),
                dir.join("src/main.py").to_string_lossy().into_owned(),
            ],
            true,
        )
        .unwrap();
        assert_eq!(project.name.as_deref(), Some(name));
        assert!(project.private);
    }
}
#[test]
fn should_reject_relative_entrypoints_bad_metadata_and_oversized_static_files() {
    assert!(local::project(&["node".into(), "relative/server.js".into()], false).is_none());
    let dir = directory("bad-project").join("deep/one/two/three/four/five");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("package.json"), b"broken JSON").unwrap();
    let tokens = vec![
        "node".into(),
        dir.join("server.js").to_string_lossy().into_owned(),
    ];
    assert!(local::project(&tokens, false).is_none());
    fs::File::create(dir.join("package.json"))
        .unwrap()
        .set_len(256 * 1024 + 1)
        .unwrap();
    assert!(local::project(&tokens, false).is_none());
}
#[test]
fn should_identify_python_module_launchers_without_guessing_project_metadata() {
    let tokens = vec![
        "python".into(),
        "-m".into(),
        "uvicorn".into(),
        "orders:app".into(),
    ];
    assert_eq!(local::launcher(&tokens, true).as_deref(), Some("uvicorn"));
    assert!(local::project(&tokens, true).is_none());
}

#[test]
fn should_parse_runtime_options_without_mistaking_preloads_or_arguments_for_entrypoints() {
    let tokens = |values: &[&str]| values.iter().map(|v| (*v).to_owned()).collect::<Vec<_>>();
    assert_eq!(
        local::entrypoint(
            &tokens(&[
                "node",
                "--require",
                "preload.js",
                "--loader",
                "loader.js",
                "/srv/orders/main.js",
                "fake.py"
            ]),
            false
        ),
        Some("/srv/orders/main.js")
    );
    assert_eq!(
        local::entrypoint(
            &tokens(&[
                "python",
                "-W",
                "ignore",
                "-X",
                "utf8",
                "/srv/orders/main.py",
                "other.py"
            ]),
            true
        ),
        Some("/srv/orders/main.py")
    );
    for values in [
        vec!["node", "-e", "require('http')", "/srv/fake.js"],
        vec!["node", "--eval", "code", "/srv/fake.js"],
    ] {
        assert!(local::entrypoint(&tokens(&values), false).is_none());
    }
    for values in [
        vec!["python", "-c", "code", "/srv/fake.py"],
        vec!["python", "-m", "uvicorn", "/srv/fake.py"],
    ] {
        assert!(local::entrypoint(&tokens(&values), true).is_none());
    }
    assert_eq!(
        local::python_module(&tokens(&["python", "-W", "ignore", "-m", "http.server"])).as_deref(),
        Some("http.server")
    );
    assert!(local::python_module(&tokens(&["python", "script.py", "-m", "uvicorn"])).is_none());
}
#[cfg(windows)]
#[test]
fn should_validate_browser_links_without_invoking_a_shell() {
    use crate::commands::knowledge::validate_external_url;
    for url in [
        "http://localhost:3000/",
        "https://192.168.1.2:8443/",
        "https://example.test/path",
        "http://[::1]:8080/",
    ] {
        assert!(validate_external_url(url).is_ok());
    }
    for url in [
        "",
        "javascript:alert(1)",
        "file:///C:/Windows/System32/cmd.exe",
        "https://user:pass@example.test/",
        "https://example.test/\r\ncommand",
        "http://",
    ] {
        assert!(validate_external_url(url).is_err());
    }
    assert!(validate_external_url(&format!("https://example.test/{}", "x".repeat(2048))).is_err());
}
#[cfg(unix)]
#[test]
fn should_reject_fifo_project_metadata_without_blocking_the_scan() {
    use std::os::unix::ffi::OsStrExt;
    let dir = directory("fifo").join("deep/one/two/three/four/five");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("package.json");
    let native = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(native.as_ptr(), 0o600) }, 0);
    assert!(local::project(
        &[
            "node".into(),
            dir.join("main.js").to_string_lossy().into_owned()
        ],
        false
    )
    .is_none());
}

fn generic_workload(pid: u32, created: &str, path: Option<&str>) -> String {
    let mut facts = vec![serde_json::json!({"label":"运行模式","value":"inline"})];
    if let Some(path) = path {
        facts.push(serde_json::json!({"label":"项目路径","value":path}));
    }
    register_port(&serde_json::json!({"pid":pid,"process_created_at":created,"local_address":"127.0.0.1","local_port":3000,
        "attributions":[{"kind":"NodeApplication","name":"node inline workload","description":null,"confidence":"High","source":"fixture process","facts":facts}]})).into_iter().find(|id|id.starts_with("local:")).unwrap()
}
#[test]
fn should_not_merge_generic_node_inline_profiles_from_different_processes() {
    assert_ne!(
        generic_workload(101, "2026-10-17T00:00:00Z", None),
        generic_workload(102, "2026-10-17T00:00:00Z", None)
    );
}
#[test]
fn should_not_merge_generic_profiles_when_a_pid_has_been_reused() {
    assert_ne!(
        generic_workload(103, "2026-10-17T00:00:00Z", None),
        generic_workload(103, "2026-10-17T01:00:00Z", None)
    );
}
#[test]
fn should_share_generic_profiles_between_connections_of_the_same_process_generation() {
    assert_eq!(
        generic_workload(104, "2026-10-17T00:00:00Z", None),
        generic_workload(104, "2026-10-17T00:00:00Z", None)
    );
}
#[test]
fn should_share_an_explicit_project_identity_across_worker_processes() {
    let path = directory("stable-workload");
    let path = path.to_string_lossy();
    assert_eq!(
        generic_workload(105, "2026-10-17T00:00:00Z", Some(&path)),
        generic_workload(106, "2026-10-17T00:00:00Z", Some(&path))
    );
}

fn ai_manager(mock: network::MockTransport) -> (Arc<Manager>, mpsc::Receiver<ProfileTask>, String) {
    let mut manager = test_manager();
    let (tx, rx) = mpsc::sync_channel(4);
    manager.profile_tx = tx;
    manager.network = Network::test_with_ai(mock);
    manager.ignore_offline = true;
    let mut public = fetched();
    public.ai_summary = None;
    let key = network::key(&public.public_ids[0]);
    {
        let state = manager.state.get_mut().unwrap();
        state.settings.online_enabled = true;
        state.settings.ai_enabled = true;
        state.cache.insert(key.clone(), public.clone());
        state.attempts.insert(key.clone(), now());
        let mut profile = empty_profile("local:ai".into(), "private-orders".into(), "workload");
        profile.summary = Some("本机私有订单用途不得发出".into());
        profile.public_ids = public.public_ids;
        state.profiles.insert(profile.id.clone(), profile);
    }
    (Arc::new(manager), rx, key)
}
fn ai_response() -> network::MockReply {
    network::MockReply{status:200,headers:reqwest::header::HeaderMap::new(),body:serde_json::to_vec(&serde_json::json!({"choices":[{"message":{"content":serde_json::json!({"summary_zh":"公开软件中文说明","source_ids":["public-source"]}).to_string()}}]})).unwrap()}
}
#[test]
fn should_queue_ai_for_fresh_cached_metadata_without_repeating_the_registry_request() {
    let captured = Arc::new(Mutex::new(Vec::new()));
    let bodies = Arc::clone(&captured);
    let (manager, receiver, key) = ai_manager(Arc::new(move |_, body| {
        let body = body.expect("cached AI must POST, never GET");
        bodies.lock().unwrap().push(body.to_string());
        Ok(ai_response())
    }));
    {
        let mut state = manager.state.lock().unwrap();
        manager.queue(&mut state, "local:ai", true);
        assert!(state.pending.contains(&key));
    }
    assert!(matches!(receiver.try_recv().unwrap(),ProfileTask::CachedAi(found) if found==key));
    manager.fetch_cached_ai(key.clone());
    let state = manager.state.lock().unwrap();
    assert_eq!(
        state.profiles["local:ai"].software_summary.as_deref(),
        Some("公开软件中文说明")
    );
    assert_eq!(
        state.profiles["local:ai"].summary.as_deref(),
        Some("本机私有订单用途不得发出")
    );
    assert!(!state.pending.contains(&key));
    let bodies = captured.lock().unwrap();
    assert_eq!(bodies.len(), 1);
    assert!(!bodies[0].contains("本机私有订单用途不得发出"));
    assert!(!bodies[0].contains("private-orders"));
}
#[test]
fn should_discard_an_inflight_ai_answer_when_the_user_disables_ai() {
    let (start_tx, start_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let release_rx = Mutex::new(release_rx);
    let (manager, _receiver, key) = ai_manager(Arc::new(move |_, body| {
        assert!(body.is_some());
        start_tx.send(()).unwrap();
        release_rx.lock().unwrap().recv().unwrap();
        Ok(ai_response())
    }));
    let worker = Arc::clone(&manager);
    let fetch_key = key.clone();
    let thread = std::thread::spawn(move || worker.fetch_cached_ai(fetch_key));
    start_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    manager.state.lock().unwrap().settings.ai_enabled = false;
    release_tx.send(()).unwrap();
    thread.join().unwrap();
    let state = manager.state.lock().unwrap();
    assert!(state.cache[&key].ai_summary.is_none());
    assert_eq!(
        state.profiles["local:ai"].software_summary.as_deref(),
        Some("Public software documentation")
    );
    assert!(!state.profiles["local:ai"]
        .sources
        .iter()
        .any(|source| source.kind == "ai"));
}
#[test]
fn should_retry_failed_cached_ai_only_after_its_separate_cooldown() {
    let (manager, receiver, key) = ai_manager(Arc::new(|_, _| {
        Ok(network::MockReply {
            status: 503,
            headers: reqwest::header::HeaderMap::new(),
            body: Vec::new(),
        })
    }));
    {
        let mut state = manager.state.lock().unwrap();
        manager.queue(&mut state, "local:ai", false);
    }
    assert!(matches!(
        receiver.try_recv().unwrap(),
        ProfileTask::CachedAi(_)
    ));
    manager.fetch_cached_ai(key.clone());
    {
        let mut state = manager.state.lock().unwrap();
        manager.queue(&mut state, "local:ai", false);
        assert!(receiver.try_recv().is_err());
        state
            .attempts
            .insert(format!("ai:{key}"), now().saturating_sub(301));
        manager.queue(&mut state, "local:ai", false);
    }
    assert!(matches!(receiver.try_recv().unwrap(),ProfileTask::CachedAi(found) if found==key));
}
#[test]
fn should_remove_old_ai_display_when_the_public_cache_has_been_evicted() {
    let (manager, _receiver, _key) = ai_manager(Arc::new(|_, _| {
        panic!("disabled AI must not call transport")
    }));
    {
        let mut state = manager.state.lock().unwrap();
        state.cache.clear();
        state.settings.ai_enabled = false;
        let profile = state.profiles.get_mut("local:ai").unwrap();
        profile.software_summary = Some("先前AI说明".into());
        profile.sources.push(KnowledgeSource {
            id: "ai-summary".into(),
            kind: "ai".into(),
            title: "AI整理".into(),
            url: None,
            fetched_at: None,
        });
        manager.queue(&mut state, "local:ai", false);
        assert_ne!(
            state.profiles["local:ai"].software_summary.as_deref(),
            Some("先前AI说明")
        );
        assert!(!state.profiles["local:ai"]
            .sources
            .iter()
            .any(|source| source.kind == "ai"));
    }
}

#[test]
fn should_keep_public_profile_churn_from_blocking_local_scan_profiles() {
    let manager = test_manager();
    let first = PublicServiceId {
        provider: "github".into(),
        name: "owner/churn-0".into(),
        version: None,
    };
    for index in 0..1000 {
        let id = PublicServiceId {
            provider: "github".into(),
            name: format!("owner/churn-{index}"),
            version: None,
        };
        manager.register(public_profile(&id));
    }
    manager.register(empty_profile(
        "local:after-churn".into(),
        "local workload".into(),
        "workload",
    ));
    let expected = public_profile(&first).id;
    manager.register(public_profile(&first));
    let state = manager.state.lock().unwrap();
    assert!(state.profiles.contains_key("local:after-churn"));
    assert!(state.profiles.contains_key(&expected));
    assert!(
        state
            .profiles
            .keys()
            .filter(|id| id.starts_with("public:"))
            .count()
            <= 256
    );
}
#[test]
fn should_admit_new_local_profiles_at_capacity_without_letting_public_queries_evict_local_data() {
    let manager = test_manager();
    for index in 0..MAX_PROFILES {
        manager.register(empty_profile(
            format!("local:quota-{index}"),
            "local".into(),
            "workload",
        ));
    }
    let public = public_profile(&PublicServiceId {
        provider: "github".into(),
        name: "owner/late-query".into(),
        version: None,
    });
    let public_id = public.id.clone();
    manager.register(public);
    assert!(!manager
        .state
        .lock()
        .unwrap()
        .profiles
        .contains_key(&public_id));
    manager.register(empty_profile(
        "local:newest".into(),
        "new scan workload".into(),
        "workload",
    ));
    let state = manager.state.lock().unwrap();
    assert_eq!(state.profiles.len(), MAX_PROFILES);
    assert!(state.profiles.contains_key("local:newest"));
}
#[test]
fn should_bound_negative_retry_metadata_after_repeated_failed_lookups() {
    let manager = test_manager();
    for index in 0..1005 {
        let id = PublicServiceId {
            provider: "github".into(),
            name: format!("owner/failure-{index}"),
            version: None,
        };
        manager.fetch(network::key(&id), id);
    }
    let state = manager.state.lock().unwrap();
    assert_eq!(state.failures.len(), 1000);
    assert!(state.retry.len() <= 1000);
}

#[test]
fn should_replace_observed_addresses_after_a_complete_scan_and_invalidate_cached_host_roles() {
    let manager = test_manager();
    manager.observe_scan(["192.168.1.20"], true);
    {
        let mut state = manager.state.lock().unwrap();
        let observed = state.observed.iter().cloned().collect::<Vec<_>>();
        let context = host::initial(Some("192.168.1.20".parse().unwrap()), &observed);
        assert!(context.is_local);
        state.hosts.insert(
            "192.168.1.20".into(),
            HostRecord {
                context,
                expires: now() + 60,
                queued_at: None,
            },
        );
    }
    manager.observe_scan(["192.168.1.21"], true);
    let state = manager.state.lock().unwrap();
    let observed = state.observed.iter().cloned().collect::<Vec<_>>();
    assert!(state.hosts.is_empty());
    assert!(!host::initial(Some("192.168.1.20".parse().unwrap()), &observed).is_local);
    assert!(host::initial(Some("192.168.1.21".parse().unwrap()), &observed).is_local);
}
#[test]
fn should_preserve_the_last_observed_host_snapshot_after_partial_or_failed_scans() {
    let manager = test_manager();
    manager.observe_scan(["192.168.2.20"], true);
    manager.observe_scan(["192.168.2.21"], false);
    let state = manager.state.lock().unwrap();
    assert!(state.observed.contains("192.168.2.20"));
    assert!(!state.observed.contains("192.168.2.21"));
    drop(state);
    manager.observe_scan(std::iter::empty::<&str>(), false);
    assert!(manager
        .state
        .lock()
        .unwrap()
        .observed
        .contains("192.168.2.20"));
}
#[test]
fn should_clear_observed_addresses_after_a_successful_empty_scan() {
    let manager = test_manager();
    manager.observe_scan(["192.168.3.20"], true);
    manager.observe_scan(std::iter::empty::<&str>(), true);
    assert!(manager.state.lock().unwrap().observed.is_empty());
}
#[test]
fn should_bound_unique_numeric_observed_addresses_and_ignore_wildcards() {
    let manager = test_manager();
    let mut addresses = vec![
        "0.0.0.0".into(),
        "::".into(),
        "not-a-host".into(),
        "10.0.0.1".into(),
    ];
    addresses.extend((0..300).map(|index| format!("10.0.{}.{}", index / 256, index % 256)));
    manager.observe_scan(addresses.iter().map(String::as_str), true);
    let state = manager.state.lock().unwrap();
    assert_eq!(state.observed.len(), 128);
    assert!(!state.observed.contains("0.0.0.0"));
    assert!(!state.observed.contains("::"));
    assert!(!state.observed.contains("not-a-host"));
}
