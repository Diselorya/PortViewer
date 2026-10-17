use super::{network::Fetched, KnowledgeSettings};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const FILE_LIMIT: u64 = 10 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
pub struct CachedFailure {
    pub status: String,
    pub message: String,
    pub retry_at: u64,
}
#[derive(Default, Serialize, Deserialize)]
pub struct Disk {
    pub settings: KnowledgeSettings,
    pub records: BTreeMap<String, Fetched>,
    #[serde(default)]
    pub failures: BTreeMap<String, CachedFailure>,
}
pub fn directory() -> Option<PathBuf> {
    if cfg!(test) && std::env::var_os("PORTVIEWER_KNOWLEDGE_DIR").is_none() {
        return None;
    }
    if let Some(path) = std::env::var_os("PORTVIEWER_KNOWLEDGE_DIR") {
        return Some(PathBuf::from(path));
    }
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("PortViewer/knowledge"))
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".cache")))
            .map(|p| p.join("portviewer/knowledge"))
    }
}
fn ordinary_path(path: &Path) -> bool {
    let mut current = PathBuf::new();
    for part in path.components() {
        current.push(part);
        if let Ok(meta) = fs::symlink_metadata(&current) {
            if meta.file_type().is_symlink() {
                return false;
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    return false;
                }
            }
        }
    }
    true
}
pub fn load(path: Option<&Path>) -> Disk {
    let Some(path) = path.filter(|p| p.is_absolute() && ordinary_path(p)) else {
        return Disk::default();
    };
    let file = path.join("knowledge-v1.json");
    if !ordinary_path(&file) {
        return Disk::default();
    }
    if !fs::symlink_metadata(&file).is_ok_and(|metadata| metadata.is_file()) {
        return Disk::default();
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let Ok(file) = options.open(file) else {
        return Disk::default();
    };
    if !file
        .metadata()
        .is_ok_and(|m| m.is_file() && m.len() <= FILE_LIMIT)
    {
        return Disk::default();
    }
    let mut bytes = Vec::new();
    if file.take(FILE_LIMIT + 1).read_to_end(&mut bytes).is_err() || bytes.len() as u64 > FILE_LIMIT
    {
        return Disk::default();
    }
    let Ok(mut disk) = serde_json::from_slice::<Disk>(&bytes) else {
        return Disk::default();
    };
    disk.records.retain(|key, value| {
        key.len() <= 400
            && value.public_ids.len() <= 8
            && value.sources.len() <= 8
            && value.candidates.len() <= 5
            && value
                .software_summary
                .as_ref()
                .is_none_or(|s| s.len() <= 8192)
            && value.ai_summary.as_ref().is_none_or(|s| s.len() <= 1280)
            && value
                .public_ids
                .iter()
                .all(|id| super::network::normalize_id(id).is_ok())
            && value.sources.iter().all(|s| {
                s.kind != "local"
                    && s.title.len() <= 1024
                    && s.url.as_ref().is_none_or(|u| valid_page(u))
            })
            && value
                .candidates
                .iter()
                .all(|c| c.name.len() <= 214 && valid_page(&c.url))
    });
    disk.failures.retain(|key, value| {
        key.len() <= 400
            && value.retry_at > super::now()
            && value.message.len() <= 1024
            && matches!(
                value.status.as_str(),
                "offline" | "rate_limited" | "no_public_identifier" | "disabled" | "error"
            )
    });
    while disk.failures.len() > 1000 {
        if let Some(key) = disk.failures.keys().next().cloned() {
            disk.failures.remove(&key);
        }
    }
    while disk.records.len() > 1000 {
        if let Some(key) = disk.records.keys().next().cloned() {
            disk.records.remove(&key);
        }
    }
    disk
}
fn valid_page(value: &str) -> bool {
    value.len() <= 2048
        && reqwest::Url::parse(value).is_ok_and(|u| {
            u.scheme() == "https"
                && u.username().is_empty()
                && u.password().is_none()
                && u.port().is_none()
                && u.query().is_none()
                && u.fragment().is_none()
                && matches!(
                    u.host_str(),
                    Some("github.com" | "www.npmjs.com" | "pypi.org")
                )
        })
}
pub fn save(path: Option<&Path>, disk: &Disk) -> Result<(), String> {
    let Some(path) = path else {
        return Ok(());
    };
    if !path.is_absolute() || !ordinary_path(path) {
        return Err("缓存目录未通过路径校验".into());
    }
    fs::create_dir_all(path).map_err(|_| "无法创建资料缓存目录")?;
    if !ordinary_path(path) {
        return Err("缓存目录不是普通目录".into());
    }
    let destination = path.join("knowledge-v1.json");
    if !ordinary_path(&destination) {
        return Err("缓存文件未通过路径校验".into());
    }
    let bytes = serde_json::to_vec(disk).map_err(|_| "无法序列化资料缓存")?;
    if bytes.len() as u64 > FILE_LIMIT {
        return Err("资料缓存达到大小上限".into());
    }
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let sequence = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let temporary = path.join(format!(
        "knowledge-{}-{}-{sequence}.tmp",
        std::process::id(),
        super::now()
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|_| "无法创建资料缓存临时文件")?;
    let result = (|| {
        file.write_all(&bytes).map_err(|_| "无法写入资料缓存")?;
        file.sync_all().map_err(|_| "无法同步资料缓存")?;
        drop(file);
        fs::rename(&temporary, &destination).map_err(|_| "无法替换资料缓存")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
