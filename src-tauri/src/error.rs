use serde::Serialize;
use thiserror::Error;

/// 应用统一错误类型。
/// 前端通过 serde 标签自动反序列化为 discriminated union。
#[derive(Error, Debug, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum AppError {
    #[error("网络扫描失败: {0}")]
    ScanError(String),

    #[error("进程不存在: {0}")]
    ProcessNotFound(String),

    #[error("权限不足: {0}")]
    AccessDenied(String),

    #[error("终止进程失败: {0}")]
    KillFailed(String),

    #[error("导出参数无效: {0}")]
    InvalidExport(String),

    #[error("导出失败: {0}")]
    ExportFailed(String),

    #[error("扫描正在进行: {0}")]
    ScanBusy(String),

    #[error("内部错误: {0}")]
    Internal(String),
}

pub type AppResult<T> = Result<T, AppError>;
