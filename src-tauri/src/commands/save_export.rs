use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, AppResult};

const MAX_EXPORT_BYTES: usize = 32 * 1024 * 1024;
const MAX_FILE_NAME_CHARS: usize = 180;
const TEMP_FILE_ATTEMPTS: usize = 128;
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExportFormat {
    Csv,
    Json,
}

impl ExportFormat {
    fn parse(value: &str) -> AppResult<Self> {
        match value {
            "csv" => Ok(Self::Csv),
            "json" => Ok(Self::Json),
            _ => Err(AppError::InvalidExport(
                "format 只允许 `csv` 或 `json`".to_string(),
            )),
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Json => "json",
        }
    }

    fn filter_name(self) -> &'static str {
        match self {
            Self::Csv => "CSV 文件",
            Self::Json => "JSON 文件",
        }
    }
}

/// 通过后端受控的原生对话框导出文本，不向 WebView 授予 dialog/fs plugin capability。
#[tauri::command]
pub async fn save_export(
    suggested_name: String,
    contents: String,
    format: String,
    app: AppHandle,
) -> AppResult<Option<String>> {
    let format = validate_export(&suggested_name, &contents, &format)?;
    let extension = format.extension();

    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    app.dialog()
        .file()
        .set_title("导出当前视图")
        .set_file_name(suggested_name)
        .add_filter(format.filter_name(), &[extension])
        .save_file(move |selection| {
            let _ = sender.try_send(selection);
        });

    let selection = receiver
        .recv()
        .await
        .ok_or_else(|| AppError::ExportFailed("保存对话框未能返回选择结果".to_string()))?;
    let Some(file_path) = selection else {
        return Ok(None);
    };

    let path = file_path.into_path().map_err(|error| {
        AppError::ExportFailed(format!("所选目标不是可写的本地文件路径：{error}"))
    })?;
    validate_selected_extension(&path, extension)?;

    let path_for_write = path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        atomic_write(&path_for_write, contents.as_bytes())
    })
    .await
    .map_err(|error| AppError::ExportFailed(format!("后台写入任务异常结束：{error}")))?
    .map_err(|error| {
        AppError::ExportFailed(format!("无法写入导出文件 `{}`：{error}", path.display()))
    })?;

    Ok(Some(path.to_string_lossy().into_owned()))
}

/// 先在目标目录完整持久化临时文件，再通过同卷 Win32 rename 原子提交。
/// 目标路径在提交成功前不会被创建、截断或覆盖。
fn atomic_write(target: &Path, contents: &[u8]) -> io::Result<()> {
    atomic_write_with(target, contents, |file, bytes| file.write_all(bytes))
}

fn atomic_write_with<F>(target: &Path, contents: &[u8], writer: F) -> io::Result<()>
where
    F: FnOnce(&mut File, &[u8]) -> io::Result<()>,
{
    let mut temporary = TemporaryExportFile::create_next_to(target)?;
    let operation = (|| {
        writer(temporary.file_mut()?, contents)?;
        temporary.file_mut()?.flush()?;
        temporary.file_mut()?.sync_all()?;
        temporary.close();

        atomic_replace(temporary.path(), target)?;
        temporary.mark_committed();
        Ok(())
    })();

    match operation {
        Ok(()) => Ok(()),
        Err(operation_error) => match temporary.cleanup() {
            Ok(()) => Err(operation_error),
            Err(cleanup_error) => Err(io::Error::other(format!(
                "{operation_error}；清理导出临时文件失败：{cleanup_error}"
            ))),
        },
    }
}

struct TemporaryExportFile {
    path: PathBuf,
    file: Option<File>,
    committed: bool,
}

impl TemporaryExportFile {
    fn create_next_to(target: &Path) -> io::Result<Self> {
        let parent = target
            .parent()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "导出目标缺少父目录"))?;

        for _ in 0..TEMP_FILE_ATTEMPTS {
            let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let temporary_name =
                format!(".portviewer-export-{}-{sequence}.tmp", std::process::id());
            let path = parent.join(temporary_name);
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => {
                    return Ok(Self {
                        path,
                        file: Some(file),
                        committed: false,
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }

        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "无法创建唯一导出临时文件",
        ))
    }

    fn file_mut(&mut self) -> io::Result<&mut File> {
        self.file
            .as_mut()
            .ok_or_else(|| io::Error::other("导出临时文件已关闭"))
    }

    fn close(&mut self) {
        self.file.take();
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn mark_committed(&mut self) {
        self.committed = true;
    }

    fn cleanup(&mut self) -> io::Result<()> {
        self.close();
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }
}

impl Drop for TemporaryExportFile {
    fn drop(&mut self) {
        self.close();
        if !self.committed {
            let _ = self.cleanup();
        }
    }
}

#[cfg(windows)]
fn atomic_replace(source: &Path, target: &Path) -> io::Result<()> {
    use std::iter;
    use std::os::windows::ffi::OsStrExt;

    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect();
    let target_wide: Vec<u16> = target
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect();
    unsafe {
        MoveFileExW(
            PCWSTR(source_wide.as_ptr()),
            PCWSTR(target_wide.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|error| io::Error::other(format!("无法原子提交导出文件：{error}")))
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, target: &Path) -> io::Result<()> {
    std::fs::rename(source, target)
}

fn validate_export(suggested_name: &str, contents: &str, format: &str) -> AppResult<ExportFormat> {
    let format = ExportFormat::parse(format)?;
    validate_suggested_name(suggested_name, format.extension())?;
    validate_contents(contents.len(), contents.is_empty(), contents.contains('\0'))?;
    Ok(format)
}

fn validate_suggested_name(name: &str, expected_extension: &str) -> AppResult<()> {
    let character_count = name.chars().count();
    if character_count == 0 || character_count > MAX_FILE_NAME_CHARS {
        return Err(AppError::InvalidExport(format!(
            "建议文件名长度必须为 1～{MAX_FILE_NAME_CHARS} 个字符"
        )));
    }
    if name == "." || name == ".." || name.ends_with([' ', '.']) {
        return Err(AppError::InvalidExport(
            "建议文件名不能是相对路径标记，也不能以空格或句点结尾".to_string(),
        ));
    }
    if name
        .chars()
        .any(|character| character.is_control() || "<>:\"/\\|?*".contains(character))
    {
        return Err(AppError::InvalidExport(
            "建议文件名包含路径分隔符、控制字符或 Windows 保留字符".to_string(),
        ));
    }

    let Some((stem, extension)) = name.rsplit_once('.') else {
        return Err(AppError::InvalidExport(format!(
            "建议文件名必须以 .{expected_extension} 结尾"
        )));
    };
    if stem.is_empty() || !extension.eq_ignore_ascii_case(expected_extension) {
        return Err(AppError::InvalidExport(format!(
            "建议文件名必须以 .{expected_extension} 结尾"
        )));
    }

    let device_stem = stem.split('.').next().unwrap_or(stem).to_ascii_uppercase();
    let reserved = matches!(device_stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || device_stem
            .strip_prefix("COM")
            .is_some_and(|suffix| !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit()))
        || device_stem
            .strip_prefix("LPT")
            .is_some_and(|suffix| !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit()));
    if reserved {
        return Err(AppError::InvalidExport(
            "建议文件名使用了 Windows 保留设备名".to_string(),
        ));
    }

    Ok(())
}

fn validate_contents(byte_len: usize, is_empty: bool, contains_nul: bool) -> AppResult<()> {
    if is_empty {
        return Err(AppError::InvalidExport("导出内容不能为空".to_string()));
    }
    if byte_len > MAX_EXPORT_BYTES {
        return Err(AppError::InvalidExport(format!(
            "导出内容超过 {} MiB 上限",
            MAX_EXPORT_BYTES / 1024 / 1024
        )));
    }
    if contains_nul {
        return Err(AppError::InvalidExport(
            "导出文本不能包含 NUL 字符".to_string(),
        ));
    }
    Ok(())
}

fn validate_selected_extension(path: &Path, expected_extension: &str) -> AppResult<()> {
    let matches = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(expected_extension));
    if matches {
        Ok(())
    } else {
        Err(AppError::InvalidExport(format!(
            "所选文件必须以 .{expected_extension} 结尾"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn create() -> Self {
            let root = std::env::temp_dir();
            for _ in 0..TEMP_FILE_ATTEMPTS {
                let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
                let path = root.join(format!(
                    "portviewer-export-test-{}-{sequence}",
                    std::process::id()
                ));
                match std::fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("无法创建测试目录：{error}"),
                }
            }
            panic!("无法创建唯一测试目录")
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn temporary_artifacts(&self) -> Vec<PathBuf> {
            std::fs::read_dir(&self.0)
                .unwrap()
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with(".portviewer-export-"))
                })
                .collect()
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn accepts_safe_unicode_names_and_supported_formats() {
        assert_eq!(
            validate_export("端口快照_20260823.csv", "header\r\n", "csv").unwrap(),
            ExportFormat::Csv
        );
        assert_eq!(
            validate_export("PortViewer.JSON", "{}", "json").unwrap(),
            ExportFormat::Json
        );
    }

    #[test]
    fn rejects_unknown_formats_and_extension_mismatches() {
        assert!(validate_export("export.xml", "data", "xml").is_err());
        assert!(validate_export("export.json", "data", "csv").is_err());
        assert!(validate_export("export", "data", "json").is_err());
    }

    #[test]
    fn rejects_paths_reserved_names_and_unsafe_characters() {
        for name in [
            "../export.csv",
            r"folder\export.csv",
            "C:export.csv",
            "CON.csv",
            "com1.json",
            "bad?.csv",
            "trailing.csv.",
        ] {
            assert!(validate_suggested_name(name, "csv").is_err(), "{name}");
        }
    }

    #[test]
    fn rejects_empty_oversized_and_nul_contents_without_large_allocations() {
        assert!(validate_contents(0, true, false).is_err());
        assert!(validate_contents(MAX_EXPORT_BYTES + 1, false, false).is_err());
        assert!(validate_contents(10, false, true).is_err());
        assert!(validate_contents(MAX_EXPORT_BYTES, false, false).is_ok());
    }

    #[test]
    fn validates_the_user_selected_extension() {
        assert!(validate_selected_extension(Path::new("snapshot.CSV"), "csv").is_ok());
        assert!(validate_selected_extension(Path::new("snapshot.json"), "csv").is_err());
    }

    #[test]
    fn atomically_creates_and_replaces_export_files() {
        let directory = TestDirectory::create();
        let target = directory.path().join("snapshot.csv");

        atomic_write(&target, b"first").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"first");

        atomic_write(&target, b"second").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"second");
        assert!(directory.temporary_artifacts().is_empty());
    }

    #[test]
    fn write_failure_preserves_existing_target_and_cleans_partial_temp() {
        let directory = TestDirectory::create();
        let target = directory.path().join("snapshot.json");
        std::fs::write(&target, b"original").unwrap();

        let result = atomic_write_with(&target, b"replacement", |file, bytes| {
            file.write_all(&bytes[..3])?;
            Err(io::Error::other("injected write failure"))
        });

        assert!(result.is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
        assert!(directory.temporary_artifacts().is_empty());
    }

    #[test]
    fn real_commit_failure_preserves_target_and_cleans_temp() {
        let directory = TestDirectory::create();
        let target = directory.path().join("existing-directory.csv");
        std::fs::create_dir(&target).unwrap();

        let result = atomic_write(&target, b"complete replacement");

        assert!(result.is_err());
        assert!(target.is_dir());
        assert!(directory.temporary_artifacts().is_empty());
    }
}
