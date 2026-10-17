//! Static project declarations adjacent to a real process entrypoint. No scripts, imports or build hooks execute.
use super::clean;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
const FILE_LIMIT: u64 = 256 * 1024;
#[derive(Clone, Debug)]
pub struct ProjectMetadata {
    pub name: Option<String>,
    pub description: Option<String>,
    pub metadata: PathBuf,
    pub root: PathBuf,
    pub private: bool,
}
pub fn project(tokens: &[String], python: bool) -> Option<ProjectMetadata> {
    let token = entrypoint(tokens, python)?;
    let path = Path::new(token);
    if !safe_absolute(path) {
        return None;
    }
    let normalized = token.replace('\\', "/");
    if !python {
        if let Some(index) = normalized.to_ascii_lowercase().find("/node_modules/") {
            // Dependency metadata describes a launcher, never the hosting app.
            let root = Path::new(&token[..index]);
            return read_metadata(&root.join("package.json"), false);
        }
    }
    let mut parent = path.parent();
    for _ in 0..6 {
        let Some(directory) = parent else {
            break;
        };
        if directory.parent().is_none() {
            break;
        }
        if !directory.components().any(|part| {
            let value = part.as_os_str().to_string_lossy();
            value.eq_ignore_ascii_case("node_modules")
                || value.eq_ignore_ascii_case("site-packages")
                || value.eq_ignore_ascii_case("dist-packages")
        }) {
            let metadata = directory.join(if python {
                "pyproject.toml"
            } else {
                "package.json"
            });
            if let Some(value) = read_metadata(&metadata, python) {
                return Some(value);
            }
        }
        parent = directory.parent();
    }
    None
}
pub fn entrypoint(tokens: &[String], python: bool) -> Option<&str> {
    let mut index = 1;
    while let Some(token) = tokens.get(index) {
        if token == "--" {
            return tokens.get(index + 1).map(String::as_str);
        }
        if (python && matches!(token.as_str(), "-m" | "-c"))
            || (!python && matches!(token.as_str(), "-e" | "--eval" | "-p" | "--print"))
        {
            return None;
        }
        let value_option = if python {
            matches!(token.as_str(), "-W" | "-X")
        } else {
            matches!(
                token.as_str(),
                "-r" | "--require"
                    | "--import"
                    | "--loader"
                    | "--experimental-loader"
                    | "--conditions"
                    | "-C"
                    | "--env-file"
                    | "--input-type"
                    | "--title"
                    | "--run"
            )
        };
        if value_option {
            index += 2;
            continue;
        }
        if token.starts_with('-') {
            index += 1;
            continue;
        }
        return Some(token);
    }
    None
}
pub fn python_module(tokens: &[String]) -> Option<String> {
    let mut index = 1;
    while let Some(token) = tokens.get(index) {
        if token == "-m" {
            return tokens
                .get(index + 1)
                .filter(|value| {
                    !value.is_empty()
                        && value.len() <= 128
                        && value
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
                })
                .cloned();
        }
        if token == "-c" || !token.starts_with('-') {
            return None;
        }
        if token == "-W" || token == "-X" {
            index += 2;
        } else {
            index += 1;
        }
    }
    None
}
pub fn launcher(tokens: &[String], python: bool) -> Option<String> {
    if python {
        return python_module(tokens).and_then(|module| {
            super::catalog::launcher(module.split('.').next().unwrap_or(""))
                .map(|entry| entry.id.clone())
        });
    }
    tokens.iter().find_map(|token| {
        let normalized = token.replace('\\', "/");
        let remainder = normalized.split_once("/node_modules/")?.1;
        let remainder = remainder.strip_prefix(".bin/").unwrap_or(remainder);
        let mut parts = remainder.split('/');
        let first = parts.next()?;
        let name = if first.starts_with('@') {
            format!("{}/{}", first, parts.next()?)
        } else {
            first.to_owned()
        };
        super::catalog::launcher(&name).map(|entry| entry.id.clone())
    })
}
fn safe_absolute(path: &Path) -> bool {
    let text = path.to_string_lossy();
    if !path.is_absolute() || text.len() > 32768 || text.chars().any(char::is_control) {
        return false;
    }
    #[cfg(windows)]
    {
        let value = text.replace('/', "\\");
        if value.starts_with("\\\\")
            && !(value.starts_with("\\\\?\\") && value.as_bytes().get(5) == Some(&b':'))
        {
            return false;
        }
    }
    true
}
fn ordinary(path: &Path) -> bool {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component);
        if let Ok(metadata) = fs::symlink_metadata(&current) {
            if metadata.file_type().is_symlink() {
                return false;
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    return false;
                }
            }
        }
    }
    true
}
fn read_metadata(path: &Path, python: bool) -> Option<ProjectMetadata> {
    if !safe_absolute(path) || !ordinary(path) {
        return None;
    }
    if !fs::symlink_metadata(path).ok()?.is_file() {
        return None;
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let file = options.open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(FILE_LIMIT + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > FILE_LIMIT {
        return None;
    }
    let (name, description, private) = if python {
        let value: toml::Value = toml::from_str(std::str::from_utf8(&bytes).ok()?).ok()?;
        let metadata = value
            .get("project")
            .or_else(|| value.get("tool")?.get("poetry"))?;
        (
            metadata
                .get("name")
                .and_then(toml::Value::as_str)
                .map(|v| clean(v, 256)),
            metadata
                .get("description")
                .and_then(toml::Value::as_str)
                .map(|v| clean(v, 2048)),
            true,
        )
    } else {
        let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
        (
            value
                .get("name")
                .and_then(serde_json::Value::as_str)
                .map(|v| clean(v, 256)),
            value
                .get("description")
                .and_then(serde_json::Value::as_str)
                .map(|v| clean(v, 2048)),
            value
                .get("private")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
        )
    };
    // Root project names/repositories are always local-only, even without private:true.
    Some(ProjectMetadata {
        name,
        description,
        metadata: path.to_owned(),
        root: path.parent()?.to_owned(),
        private,
    })
}

#[cfg(windows)]
pub fn executable_description(path: &str) -> Option<String> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    type Descriptions = HashMap<String, (u64, Option<String>)>;
    static CACHE: OnceLock<Mutex<Descriptions>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let time = super::now();
    if let Some((at, value)) = cache.lock().unwrap_or_else(|p| p.into_inner()).get(path) {
        if time.saturating_sub(*at) < 3600 {
            return value.clone();
        }
    }
    let value = native_file_description(Path::new(path));
    let mut cache = cache.lock().unwrap_or_else(|p| p.into_inner());
    if cache.len() >= 512 {
        if let Some(old) = cache.keys().next().cloned() {
            cache.remove(&old);
        }
    }
    cache.insert(path.to_owned(), (time, value.clone()));
    value
}
#[cfg(not(windows))]
pub fn executable_description(_path: &str) -> Option<String> {
    None
}
#[cfg(windows)]
fn native_file_description(path: &Path) -> Option<String> {
    use std::ffi::c_void;
    #[link(name = "Version")]
    extern "system" {
        fn GetFileVersionInfoSizeW(file: *const u16, handle: *mut u32) -> u32;
        fn GetFileVersionInfoW(file: *const u16, handle: u32, size: u32, block: *mut c_void)
            -> i32;
        fn VerQueryValueW(
            block: *const c_void,
            key: *const u16,
            value: *mut *mut c_void,
            length: *mut u32,
        ) -> i32;
    }
    if !safe_absolute(path) || !ordinary(path) {
        return None;
    }
    let wide = path
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut ignored = 0;
    let size = unsafe { GetFileVersionInfoSizeW(wide.as_ptr(), &mut ignored) };
    if size == 0 || size > 1024 * 1024 {
        return None;
    }
    let mut block = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
    if unsafe { GetFileVersionInfoW(wide.as_ptr(), 0, size, block.as_mut_ptr().cast()) } == 0 {
        return None;
    }
    let block_start = block.as_ptr() as usize;
    let block_end = block_start + block.len() * std::mem::size_of::<usize>();
    let query = |key: &str| {
        let wide = key
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let mut pointer = std::ptr::null_mut();
        let mut length = 0;
        let ok = unsafe {
            VerQueryValueW(
                block.as_ptr().cast(),
                wide.as_ptr(),
                &mut pointer,
                &mut length,
            )
        };
        (ok != 0
            && !pointer.is_null()
            && pointer as usize >= block_start
            && (pointer as usize) < block_end)
            .then_some((pointer, length))
    };
    let mut translations = Vec::new();
    if let Some((pointer, length)) = query("\\VarFileInfo\\Translation") {
        let count = (length as usize / 4).min(16);
        if (pointer as usize).is_multiple_of(2)
            && (pointer as usize).saturating_add(count * 4) <= block_end
        {
            let pairs = unsafe { std::slice::from_raw_parts(pointer.cast::<u16>(), count * 2) };
            translations.extend(pairs.chunks_exact(2).map(|pair| (pair[0], pair[1])));
        }
    }
    translations.extend([(0x0804, 0x04b0), (0x0409, 0x04b0)]);
    for (language, codepage) in translations {
        let key = format!("\\StringFileInfo\\{language:04x}{codepage:04x}\\FileDescription");
        if let Some((pointer, length)) = query(&key) {
            let count = (length as usize).min(4096);
            if !(pointer as usize).is_multiple_of(2)
                || (pointer as usize).saturating_add(count * 2) > block_end
            {
                continue;
            }
            let chars = unsafe { std::slice::from_raw_parts(pointer.cast::<u16>(), count) };
            let end = chars
                .iter()
                .position(|value| *value == 0)
                .unwrap_or(chars.len());
            let value = clean(&String::from_utf16_lossy(&chars[..end]), 2048);
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}
