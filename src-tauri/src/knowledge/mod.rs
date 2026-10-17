//! Scanner-owned profile registry. Scanning never waits for internet or reverse DNS.
mod cache;
mod catalog;
mod host;
pub mod local;
mod model;
pub mod network;
mod proxy;
pub use model::*;

use network::{Fetched, Network};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_PROFILES: usize = 4096;
const MAX_BATCH: usize = 128;
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub fn timestamp() -> String {
    let seconds = now();
    let z = (seconds / 86400) as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        seconds % 86400 / 3600,
        seconds % 3600 / 60,
        seconds % 60
    )
}
pub fn clean(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(limit)
        .collect::<String>()
        .trim()
        .to_owned()
}
fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn offline() -> bool {
    std::env::var("PORTVIEWER_KNOWLEDGE_OFFLINE")
        .ok()
        .as_deref()
        == Some("1")
}
struct HostRecord {
    context: HostContext,
    expires: u64,
    queued_at: Option<u64>,
}
struct State {
    settings: KnowledgeSettings,
    profiles: BTreeMap<String, ServiceProfile>,
    profile_seen: BTreeMap<String, u64>,
    cache: BTreeMap<String, Fetched>,
    pending: BTreeSet<String>,
    attempts: BTreeMap<String, u64>,
    retry: BTreeMap<String, u64>,
    failures: BTreeMap<String, cache::CachedFailure>,
    observed: BTreeSet<String>,
    hosts: BTreeMap<String, HostRecord>,
}
enum ProfileTask {
    Metadata(String, PublicServiceId),
    CachedAi(String),
}
struct Manager {
    state: Mutex<State>,
    profile_tx: mpsc::SyncSender<ProfileTask>,
    host_tx: mpsc::SyncSender<IpAddr>,
    network: Network,
    directory: Option<PathBuf>,
    persist_lock: Mutex<()>,
    #[cfg(test)]
    ignore_offline: bool,
}
fn prune_registry_maps(state: &mut State) {
    let active = state
        .profiles
        .values()
        .filter_map(|profile| profile.public_ids.first().map(network::key))
        .chain(state.pending.iter().cloned())
        .collect::<BTreeSet<_>>();
    state
        .attempts
        .retain(|key, _| active.contains(key.strip_prefix("ai:").unwrap_or(key)));
    state
        .retry
        .retain(|key, _| state.failures.contains_key(key) || active.contains(key));
}
fn manager() -> &'static Arc<Manager> {
    static MANAGER: OnceLock<Arc<Manager>> = OnceLock::new();
    MANAGER.get_or_init(Manager::new)
}
impl Manager {
    fn new() -> Arc<Self> {
        let directory = cache::directory();
        let disk = cache::load(directory.as_deref());
        let (profile_tx, profile_rx) = mpsc::sync_channel::<ProfileTask>(128);
        let (host_tx, host_rx) = mpsc::sync_channel::<IpAddr>(64);
        let result = Arc::new(Self {
            state: Mutex::new(State {
                settings: disk.settings,
                profiles: BTreeMap::new(),
                profile_seen: BTreeMap::new(),
                cache: disk.records,
                pending: BTreeSet::new(),
                attempts: BTreeMap::new(),
                retry: disk
                    .failures
                    .iter()
                    .map(|(key, value)| (key.clone(), value.retry_at))
                    .collect(),
                failures: disk.failures,
                observed: BTreeSet::new(),
                hosts: BTreeMap::new(),
            }),
            profile_tx,
            host_tx,
            network: Network::new(),
            directory,
            persist_lock: Mutex::new(()),
            #[cfg(test)]
            ignore_offline: false,
        });
        let profile_rx = Arc::new(Mutex::new(profile_rx));
        let host_rx = Arc::new(Mutex::new(host_rx));
        for number in 0..2 {
            let this = Arc::clone(&result);
            let receiver = Arc::clone(&profile_rx);
            let _ = std::thread::Builder::new()
                .name(format!("portviewer-knowledge-{number}"))
                .spawn(move || loop {
                    let task = receiver.lock().unwrap_or_else(|p| p.into_inner()).recv();
                    let Ok(task) = task else {
                        break;
                    };
                    match task {
                        ProfileTask::Metadata(key, id) => this.fetch(key, id),
                        ProfileTask::CachedAi(key) => this.fetch_cached_ai(key),
                    }
                });
            let this = Arc::clone(&result);
            let receiver = Arc::clone(&host_rx);
            let _ = std::thread::Builder::new()
                .name(format!("portviewer-dns-{number}"))
                .spawn(move || loop {
                    let task = receiver.lock().unwrap_or_else(|p| p.into_inner()).recv();
                    let Ok(ip) = task else {
                        break;
                    };
                    this.resolve(ip);
                });
        }
        result
    }
    fn observe_scan<'a>(&self, addresses: impl IntoIterator<Item = &'a str>, complete: bool) {
        if !complete {
            return;
        }
        let mut observed = BTreeSet::new();
        for address in addresses {
            if let Ok(ip) = address.parse::<IpAddr>() {
                if !ip.is_unspecified() {
                    observed.insert(ip.to_string());
                }
                if observed.len() >= 128 {
                    break;
                }
            }
        }
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.observed != observed {
            state.observed = observed;
            state.hosts.clear();
        }
    }
    fn effective(&self, state: &State) -> KnowledgeSettings {
        let mut result = state.settings.clone();
        #[cfg(test)]
        let forced_offline = offline() && !self.ignore_offline;
        #[cfg(not(test))]
        let forced_offline = offline();
        if forced_offline {
            result.online_enabled = false;
            result.reverse_dns_enabled = false;
        }
        if self.network.ai.is_none() {
            result.ai_enabled = false;
        }
        result
    }
    fn configuration(&self, can_configure: bool) -> KnowledgeConfiguration {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        KnowledgeConfiguration {
            settings: self.effective(&state),
            ai_configured: self.network.ai.is_some(),
            ai_provider: self.network.ai.as_ref().map(|v| v.provider()),
            ai_model: self.network.ai.as_ref().map(|v| v.model()),
            can_configure,
        }
    }
    fn persist(&self) -> Result<(), String> {
        let _disk = self.persist_lock.lock().unwrap_or_else(|p| p.into_inner());
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let disk = cache::Disk {
            settings: state.settings.clone(),
            records: state.cache.clone(),
            failures: state.failures.clone(),
        };
        drop(state);
        cache::save(self.directory.as_deref(), &disk)
    }
    fn register(&self, mut profile: ServiceProfile) -> String {
        let id = profile.id.clone();
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if !state.profiles.contains_key(&id) {
            let public = id.starts_with("public:");
            let public_count = if public {
                state
                    .profiles
                    .keys()
                    .filter(|id| id.starts_with("public:"))
                    .count()
            } else {
                0
            };
            let mut recycled = false;
            let evict_public =
                (public && public_count >= 256) || state.profiles.len() >= MAX_PROFILES;
            if evict_public {
                let oldest = state
                    .profiles
                    .keys()
                    .filter(|candidate| candidate.starts_with("public:"))
                    .min_by_key(|candidate| {
                        state.profile_seen.get(*candidate).copied().unwrap_or(0)
                    })
                    .cloned();
                if let Some(oldest) = oldest {
                    state.profiles.remove(&oldest);
                    state.profile_seen.remove(&oldest);
                    recycled = true;
                } else if public {
                    return id;
                }
            }
            if state.profiles.len() >= MAX_PROFILES {
                if let Some(oldest) = state
                    .profiles
                    .keys()
                    .min_by_key(|candidate| {
                        state.profile_seen.get(*candidate).copied().unwrap_or(0)
                    })
                    .cloned()
                {
                    state.profiles.remove(&oldest);
                    state.profile_seen.remove(&oldest);
                    recycled = true;
                }
            }
            if recycled {
                prune_registry_maps(&mut state);
            }
        }
        static REGISTRATIONS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        state.profile_seen.insert(
            id.clone(),
            REGISTRATIONS.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        );
        if let Some(previous) = state.profiles.get(&id) {
            profile.software_summary = previous
                .software_summary
                .clone()
                .or(profile.software_summary);
            profile.candidates = previous.candidates.clone();
            profile.updated_at = previous.updated_at.clone();
            profile.sources.extend(
                previous
                    .sources
                    .iter()
                    .filter(|s| matches!(s.kind.as_str(), "registry" | "github" | "search" | "ai"))
                    .cloned(),
            );
            profile.enrichment_status = previous.enrichment_status.clone();
            profile.message = previous.message.clone();
            profile.stale = previous.stale;
        }
        if state.profiles.len() < MAX_PROFILES || state.profiles.contains_key(&id) {
            state.profiles.insert(id.clone(), profile);
        }
        self.queue(&mut state, &id, false);
        id
    }
    fn queue(&self, state: &mut State, id: &str, refresh: bool) {
        let settings = self.effective(state);
        let Some(profile) = state.profiles.get_mut(id) else {
            return;
        };
        if !settings.ai_enabled {
            remove_ai(profile);
        }
        let Some(public) = profile
            .public_ids
            .first()
            .and_then(|id| network::normalize_id(id).ok())
        else {
            profile.enrichment_status =
                if profile.summary.is_some() || profile.software_summary.is_some() {
                    "ready"
                } else {
                    "no_public_identifier"
                }
                .into();
            return;
        };
        let key = network::key(&public);
        let time = now();
        if let Some(fetched) = state.cache.get(&key) {
            apply_fetched(profile, fetched, settings.ai_enabled);
            let wants_ai = settings.online_enabled
                && settings.ai_enabled
                && fetched.ai_summary.is_none()
                && fetched.software_summary.is_some()
                && fetched
                    .sources
                    .iter()
                    .any(|s| matches!(s.kind.as_str(), "github" | "registry"));
            if fetched.expires_at > time && (!refresh || wants_ai) {
                if wants_ai {
                    let attempt_key = format!("ai:{key}");
                    if state.pending.contains(&key) {
                        profile.enrichment_status = "queued".into();
                    } else if state
                        .attempts
                        .get(&attempt_key)
                        .is_none_or(|last| time.saturating_sub(*last) >= 300)
                    {
                        state.attempts.insert(attempt_key, time);
                        if self
                            .profile_tx
                            .try_send(ProfileTask::CachedAi(key.clone()))
                            .is_ok()
                        {
                            state.pending.insert(key);
                            profile.enrichment_status = "queued".into();
                        } else {
                            profile.message = Some("AI 整理队列已满，将在后续查询重试".into());
                        }
                    } else {
                        profile.message = Some("AI 整理暂未完成，冷却后将根据后续查询重试".into());
                    }
                }
                return;
            }
        }
        if !settings.online_enabled {
            profile.enrichment_status = "disabled".into();
            return;
        }
        if let Some(failure) = state
            .failures
            .get(&key)
            .filter(|failure| failure.retry_at > time)
        {
            profile.enrichment_status = failure.status.clone();
            profile.message = Some(failure.message.clone());
            return;
        }
        if state.pending.contains(&key) {
            profile.enrichment_status = "queued".into();
            return;
        }
        if state.retry.get(&key).is_some_and(|retry| *retry > time)
            || state
                .attempts
                .get(&key)
                .is_some_and(|last| time.saturating_sub(*last) < 60)
        {
            return;
        }
        state.pending.insert(key.clone());
        state.attempts.insert(key.clone(), time);
        if self
            .profile_tx
            .try_send(ProfileTask::Metadata(key.clone(), public))
            .is_ok()
        {
            profile.enrichment_status = "queued".into();
            profile.message = None;
        } else {
            state.pending.remove(&key);
            profile.message = Some("资料补充队列已满，将在后续查询重试".into());
        }
    }
    fn fetch_cached_ai(&self, key: String) {
        let cached = {
            let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            let settings = self.effective(&state);
            if settings.online_enabled && settings.ai_enabled {
                state.cache.get(&key).cloned()
            } else {
                None
            }
        };
        let mut cached = cached;
        if let Some(fetched) = &mut cached {
            self.network.supplement_ai(fetched);
        }
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.pending.remove(&key);
        let settings = self.effective(&state);
        let completed = cached.filter(|fetched| {
            settings.online_enabled && settings.ai_enabled && fetched.ai_summary.is_some()
        });
        if let Some(fetched) = completed {
            if state
                .cache
                .get(&key)
                .is_some_and(|current| current.software_summary == fetched.software_summary)
            {
                state.cache.insert(key.clone(), fetched);
            }
        }
        if let Some(fetched) = state.cache.get(&key).cloned() {
            for profile in state.profiles.values_mut().filter(|p| {
                p.public_ids
                    .first()
                    .is_some_and(|id| network::key(id) == key)
            }) {
                apply_fetched(profile, &fetched, settings.ai_enabled);
                if settings.ai_enabled && fetched.ai_summary.is_none() {
                    profile.message = Some("AI 整理暂未完成，冷却后将根据后续查询重试".into());
                }
            }
        }
        drop(state);
        let _ = self.persist();
    }
    fn fetch(&self, key: String, id: PublicServiceId) {
        let settings = {
            let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            self.effective(&state)
        };
        let result = if settings.online_enabled {
            self.network.lookup(&id, settings.ai_enabled)
        } else {
            Err(network::Failure {
                status: "disabled",
                message: "联网补充已关闭",
                retry_at: now() + 60,
            })
        };
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.pending.remove(&key);
        let current_ai_enabled = self.effective(&state).ai_enabled;
        match result {
            Ok(mut fetched) => {
                if !current_ai_enabled {
                    fetched.ai_summary = None;
                    fetched.sources.retain(|source| source.kind != "ai");
                }
                for profile in state.profiles.values_mut().filter(|p| {
                    p.public_ids
                        .first()
                        .is_some_and(|id| network::key(id) == key)
                }) {
                    apply_fetched(profile, &fetched, current_ai_enabled);
                }
                state.failures.remove(&key);
                state.retry.remove(&key);
                state.cache.insert(key, fetched);
                while state.cache.len() > 1000 {
                    if let Some(key) = state.cache.keys().next().cloned() {
                        state.cache.remove(&key);
                    }
                }
            }
            Err(error) => {
                state.retry.insert(key.clone(), error.retry_at);
                state.failures.insert(
                    key.clone(),
                    cache::CachedFailure {
                        status: error.status.to_owned(),
                        message: error.message.to_owned(),
                        retry_at: error.retry_at,
                    },
                );
                while state.failures.len() > 1000 {
                    if let Some(old) = state.failures.keys().next().cloned() {
                        state.failures.remove(&old);
                        state.retry.remove(&old);
                    }
                }
                for profile in state.profiles.values_mut().filter(|p| {
                    p.public_ids
                        .first()
                        .is_some_and(|id| network::key(id) == key)
                }) {
                    profile.enrichment_status = error.status.into();
                    profile.message = Some(error.message.into());
                }
            }
        }
        prune_registry_maps(&mut state);
        drop(state);
        let _ = self.persist();
    }
    fn resolve(&self, ip: IpAddr) {
        let enabled = {
            let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            self.effective(&state).reverse_dns_enabled
        };
        let name = if enabled && !cfg!(test) {
            host::reverse(ip)
        } else {
            None
        };
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(record) = state.hosts.get_mut(&ip.to_string()) {
            record.context.hostname = name.clone();
            record.context.hostname_source = name.as_ref().map(|_| "reverse_dns".into());
            record.context.dns_status = if !enabled {
                "disabled"
            } else if name.is_some() {
                "ready"
            } else {
                "not_found"
            }
            .into();
            record.context.resolved_at = Some(timestamp());
            record.expires = now() + if name.is_some() { 600 } else { 60 };
            record.queued_at = None;
        }
    }
}
fn remove_ai(profile: &mut ServiceProfile) {
    if profile.sources.iter().any(|source| source.kind == "ai") {
        profile.software_summary = profile
            .sources
            .iter()
            .filter(|source| source.kind == "catalog")
            .filter_map(|source| source.id.strip_prefix("catalog:").and_then(catalog::by_id))
            .map(|entry| entry.summary.clone())
            .next();
        profile.sources.retain(|source| source.kind != "ai");
    }
}
fn apply_fetched(profile: &mut ServiceProfile, fetched: &Fetched, ai: bool) {
    profile.software_summary = if ai {
        fetched
            .ai_summary
            .clone()
            .or_else(|| fetched.software_summary.clone())
    } else {
        fetched.software_summary.clone()
    }
    .or_else(|| profile.software_summary.clone());
    profile
        .sources
        .retain(|s| matches!(s.kind.as_str(), "local" | "catalog"));
    profile.sources.extend(
        fetched
            .sources
            .iter()
            .filter(|s| ai || s.kind != "ai")
            .cloned(),
    );
    for id in fetched.public_ids.iter().take(8) {
        if !profile.public_ids.contains(id) {
            profile.public_ids.push(id.clone());
        }
    }
    profile.candidates = fetched.candidates.clone();
    profile.updated_at = Some(fetched.updated_at.clone());
    profile.stale = fetched.expires_at <= now();
    profile.enrichment_status = "ready".into();
    profile.message = None;
}
pub fn configuration(can_configure: bool) -> KnowledgeConfiguration {
    manager().configuration(can_configure)
}
pub fn set_settings(
    settings: KnowledgeSettings,
    can_configure: bool,
) -> Result<KnowledgeConfiguration, String> {
    if !can_configure {
        return Err("仅本机界面可以更改知识补充设置".into());
    }
    if settings.ai_enabled && manager().network.ai.is_none() {
        return Err("后端尚未配置可用的 AI 服务".into());
    }
    {
        let mut state = manager().state.lock().unwrap_or_else(|p| p.into_inner());
        state.settings = settings;
    }
    manager().persist()?;
    Ok(configuration(can_configure))
}
pub fn profiles(query: ServiceProfilesQuery) -> Result<ServiceProfilesResult, String> {
    let ids = query.profile_ids.unwrap_or_default();
    let public = query.public_ids.unwrap_or_default();
    if ids.len() > MAX_BATCH
        || public.len() > MAX_BATCH
        || ids.iter().any(|id| {
            id.len() > 128
                || !id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || ":@._-/".contains(c))
        })
    {
        return Err("单次最多查询128个有效服务资料标识".into());
    }
    let mut selected = ids;
    for id in public {
        let public = network::normalize_id(&id)?;
        let profile = public_profile(&public);
        let registered = manager().register(profile);
        if !manager()
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .profiles
            .contains_key(&registered)
        {
            return Err("公开软件临时资料配额已满，请稍后重试；本机扫描资料优先保留".into());
        }
        selected.push(registered);
    }
    let mut state = manager().state.lock().unwrap_or_else(|p| p.into_inner());
    if selected.is_empty() {
        selected = state.profiles.keys().take(MAX_BATCH).cloned().collect();
    }
    selected.sort();
    selected.dedup();
    if selected.len() > MAX_BATCH {
        return Err("单次最多查询128个服务资料".into());
    }
    for id in &selected {
        manager().queue(&mut state, id, query.refresh);
    }
    let settings = manager().effective(&state);
    let result = selected
        .iter()
        .filter_map(|id| state.profiles.get(id).cloned())
        .collect();
    Ok(ServiceProfilesResult {
        profiles: result,
        pending_count: state.pending.len(),
        online_enabled: settings.online_enabled,
        ai_configured: manager().network.ai.is_some(),
        ai_enabled: settings.ai_enabled,
    })
}
pub fn host_context(address: Option<&str>) -> Result<HostContext, String> {
    let ip = address
        .filter(|v| !v.is_empty() && *v != "local")
        .map(|address| {
            if address.len() > 64 {
                return Err("主机地址过长".to_owned());
            }
            address
                .parse::<IpAddr>()
                .map_err(|_| "主机详情只接受数字 IP 地址".to_owned())
        })
        .transpose()?;
    let mut state = manager().state.lock().unwrap_or_else(|p| p.into_inner());
    let observed = state.observed.iter().cloned().collect::<Vec<_>>();
    let mut result = host::initial(ip, &observed);
    if result.is_local
        || matches!(
            result.kind.as_str(),
            "wildcard" | "multicast" | "link_local"
        )
    {
        return Ok(result);
    }
    if !manager().effective(&state).reverse_dns_enabled {
        result.dns_status = "disabled".into();
        return Ok(result);
    }
    let Some(ip) = ip else {
        return Ok(result);
    };
    let key = ip.to_string();
    let time = now();
    if let Some(record) = state.hosts.get(&key) {
        if record.expires > time || record.queued_at.is_some() {
            let mut result = record.context.clone();
            if record
                .queued_at
                .is_some_and(|start| time.saturating_sub(start) >= 3)
            {
                result.dns_status = "timeout".into();
            }
            return Ok(result);
        }
    }
    if state.hosts.len() >= 512 && !state.hosts.contains_key(&key) {
        if let Some(old) = state
            .hosts
            .iter()
            .find(|(_, r)| r.queued_at.is_none())
            .map(|(k, _)| k.clone())
        {
            state.hosts.remove(&old);
        } else {
            result.dns_status = "timeout".into();
            return Ok(result);
        }
    }
    result.dns_status = "queued".into();
    if manager().host_tx.try_send(ip).is_ok() {
        state.hosts.insert(
            key,
            HostRecord {
                context: result.clone(),
                expires: time + 3,
                queued_at: Some(time),
            },
        );
    } else {
        result.dns_status = "timeout".into();
    }
    Ok(result)
}
fn empty_profile(id: String, name: String, role: &str) -> ServiceProfile {
    ServiceProfile {
        id,
        component_role: role.into(),
        original_name: name,
        display_name_zh: None,
        summary: None,
        software_summary: None,
        identity_match: "confirmed".into(),
        public_ids: Vec::new(),
        sources: Vec::new(),
        candidates: Vec::new(),
        enrichment_status: "no_public_identifier".into(),
        updated_at: Some(timestamp()),
        stale: false,
        message: None,
    }
}
fn catalog_profile(entry: &CatalogEntry) -> ServiceProfile {
    let mut profile = empty_profile(
        format!("catalog:{}", entry.id),
        entry.original_name.clone(),
        &entry.component_role,
    );
    add_catalog(&mut profile, entry);
    profile.identity_match = "candidate".into();
    profile
}
fn add_catalog(profile: &mut ServiceProfile, entry: &CatalogEntry) {
    profile.display_name_zh = Some(entry.display_name_zh.clone());
    profile.software_summary = Some(entry.summary.clone());
    profile.public_ids = entry
        .public_ids
        .iter()
        .filter_map(|id| network::normalize_id(id).ok())
        .collect();
    profile.sources.push(KnowledgeSource {
        id: format!("catalog:{}", entry.id),
        kind: "catalog".into(),
        title: "内置中文服务对照表".into(),
        url: Some(entry.source_url.clone()),
        fetched_at: None,
    });
}
fn public_profile(id: &PublicServiceId) -> ServiceProfile {
    let mut profile = empty_profile(
        format!("public:{}", digest(&network::key(id))),
        id.name.clone(),
        "runtime",
    );
    profile.public_ids.push(id.clone());
    profile.identity_match = "unresolved".into();
    profile
}
/// Input is constructed from an actual server-side scan, never from an IPC/HTTP request body.
fn instance_identity(value: &Value) -> String {
    format!(
        "{}|{}",
        value.get("pid").unwrap_or(&Value::Null),
        value.get("process_created_at").unwrap_or(&Value::Null)
    )
}
fn stable_attribution_instance(kind: &str, facts: &[Value]) -> bool {
    facts.iter().any(|fact| {
        let label = fact.get("label").and_then(Value::as_str).unwrap_or("");
        let value = fact
            .get("value")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if value.is_empty() {
            return false;
        }
        match kind {
            "DockerContainer" => {
                label == "容器 ID"
                    && value.len() >= 12
                    && value.chars().all(|c| c.is_ascii_hexdigit())
            }
            "WindowsService" | "NssmService" | "SystemdUnit" | "SystemdService" => {
                matches!(label, "服务名" | "单元" | "systemd 单元")
            }
            "NodeApplication" | "PythonApplication" => {
                label == "项目路径"
                    && (value.starts_with('/')
                        || (value.as_bytes().get(1) == Some(&b':')
                            && matches!(value.as_bytes().get(2), Some(b'/') | Some(b'\\'))))
            }
            _ => false,
        }
    })
}

/// Replace scanner-owned observed addresses only after a complete successful scan.
pub fn observe_scan<'a>(addresses: impl IntoIterator<Item = &'a str>, complete: bool) {
    manager().observe_scan(addresses, complete);
}

pub fn register_port(value: &Value) -> Vec<String> {
    let mut ids = Vec::<(u8, String)>::new();
    for attribution in value
        .get("attributions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(32)
    {
        let kind = attribution
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("");
        let name = clean(
            attribution
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(""),
            256,
        );
        if name.is_empty() {
            continue;
        }
        let role = if kind == "SystemProcess" {
            "system"
        } else {
            "workload"
        };
        let facts = attribution
            .get("facts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let instance = if stable_attribution_instance(kind, &facts) {
            String::new()
        } else {
            instance_identity(value)
        };
        let identity = format!(
            "{}|{}|{}|{}",
            kind,
            name,
            attribution.get("facts").unwrap_or(&Value::Null),
            instance
        );
        let mut profile = empty_profile(format!("local:{}", digest(&identity)), name.clone(), role);
        let description = attribution
            .get("description")
            .and_then(Value::as_str)
            .map(|s| clean(s, 2048))
            .filter(|s| !s.is_empty());
        profile.summary = description.filter(|s| {
            !matches!(
                s.as_str(),
                "Windows 服务"
                    | "NSSM 托管的 Windows 服务"
                    | "Node.js/npm 临时运行工作负载"
                    | "Python 临时运行工作负载"
            )
        });
        profile.sources.push(KnowledgeSource {
            id: "local-attribution".into(),
            kind: "local".into(),
            title: clean(
                attribution
                    .get("source")
                    .and_then(Value::as_str)
                    .unwrap_or("本机归属信息"),
                512,
            ),
            url: None,
            fetched_at: Some(timestamp()),
        });
        profile.identity_match =
            if attribution.get("confidence").and_then(Value::as_str) == Some("Exact") {
                "confirmed"
            } else {
                "candidate"
            }
            .into();
        for fact in facts.iter().take(128) {
            let label = fact.get("label").and_then(Value::as_str).unwrap_or("");
            let fact_value = fact.get("value").and_then(Value::as_str).unwrap_or("");
            if matches!(label, "服务名" | "服务" | "单元" | "systemd 单元") {
                if let Some(entry) = catalog::service(fact_value) {
                    add_catalog(&mut profile, entry);
                }
            }
            if matches!(label, "公开软件" | "模块" | "Python module" | "启动工具") {
                if let Some(entry) = catalog::launcher(fact_value) {
                    ids.push((1, manager().register(catalog_profile(entry))));
                }
            }
            if label == "镜像" {
                let image = fact_value
                    .strip_prefix("docker.io/library/")
                    .or_else(|| fact_value.strip_prefix("library/"))
                    .unwrap_or(fact_value);
                let image = image.split([':', '@']).next().unwrap_or("");
                if !image.contains('/') {
                    let catalog_id = match image {
                        "postgres" => "postgres",
                        "mysql" => "mysql",
                        "mariadb" => "mariadb",
                        "redis" => "redis",
                        "mongo" => "mongodb",
                        "nginx" => "nginx",
                        "caddy" => "caddy",
                        "traefik" => "traefik",
                        _ => "",
                    };
                    if let Some(entry) = catalog::by_id(catalog_id) {
                        add_catalog(&mut profile, entry);
                    }
                }
            }
        }
        if matches!(
            kind,
            "WindowsService" | "NssmService" | "SystemdService" | "SystemdUnit"
        ) {
            if let Some(entry) = catalog::service(&name) {
                add_catalog(&mut profile, entry);
            }
        }
        ids.push((
            if role == "workload" { 0 } else { 4 },
            manager().register(profile),
        ));
    }
    if let Some(name) = value.get("process_name").and_then(Value::as_str) {
        if let Some(entry) = catalog::process(name) {
            ids.push((
                rank(&entry.component_role),
                manager().register(catalog_profile(entry)),
            ));
        } else if !name.is_empty() {
            let mut profile = empty_profile(
                format!(
                    "local:{}",
                    digest(&format!(
                        "process|{}|{}|{}",
                        name,
                        value.get("process_path").unwrap_or(&Value::Null),
                        instance_identity(value)
                    ))
                ),
                clean(name, 256),
                "runtime",
            );
            profile.sources.push(KnowledgeSource {
                id: "process-image".into(),
                kind: "local".into(),
                title: "本机进程映像名".into(),
                url: None,
                fetched_at: Some(timestamp()),
            });
            if let Some(description) = value
                .get("process_path")
                .and_then(Value::as_str)
                .and_then(local::executable_description)
            {
                if description
                    .chars()
                    .any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
                {
                    profile.display_name_zh = Some(clean(&description, 256));
                }
                profile.summary = Some(description);
                profile.sources.push(KnowledgeSource {
                    id: "windows-file-description".into(),
                    kind: "local".into(),
                    title: "程序版本资源 FileDescription（本机声明）".into(),
                    url: None,
                    fetched_at: Some(timestamp()),
                });
            }
            profile.identity_match =
                if value.get("process_status").and_then(Value::as_str) == Some("Available") {
                    "confirmed"
                } else {
                    "unresolved"
                }
                .into();
            ids.push((2, manager().register(profile)));
        }
    }
    ids.sort_by_key(|(rank, _)| *rank);
    let mut seen = BTreeSet::new();
    ids.into_iter()
        .map(|(_, id)| id)
        .filter(|id| seen.insert(id.clone()))
        .collect()
}
fn rank(role: &str) -> u8 {
    match role {
        "workload" => 0,
        "launcher" => 1,
        "runtime" => 2,
        "manager" => 3,
        _ => 4,
    }
}

#[cfg(test)]
mod tests;
