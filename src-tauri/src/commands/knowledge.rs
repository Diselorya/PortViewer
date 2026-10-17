use crate::knowledge::{
    self, HostContext, KnowledgeConfiguration, KnowledgeSettings, PublicServiceId,
    ServiceProfilesQuery, ServiceProfilesResult,
};

#[tauri::command]
pub fn get_service_profiles(
    profile_ids: Option<Vec<String>>,
    public_ids: Option<Vec<PublicServiceId>>,
    refresh: Option<bool>,
) -> Result<ServiceProfilesResult, String> {
    knowledge::profiles(ServiceProfilesQuery {
        profile_ids,
        public_ids,
        refresh: refresh.unwrap_or(false),
    })
}
#[tauri::command]
pub fn get_host_context(address: Option<String>) -> Result<HostContext, String> {
    knowledge::host_context(address.as_deref())
}
#[tauri::command]
pub fn get_knowledge_settings() -> KnowledgeConfiguration {
    knowledge::configuration(true)
}
#[tauri::command]
pub fn set_knowledge_settings(
    settings: KnowledgeSettings,
) -> Result<KnowledgeConfiguration, String> {
    knowledge::set_settings(settings, true)
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    validate_external_url(&url)?;
    let url = reqwest::Url::parse(&url)
        .map_err(|_| "链接格式无效")?
        .to_string();
    #[cfg(windows)]
    {
        use std::ffi::c_void;
        #[link(name = "Shell32")]
        extern "system" {
            fn ShellExecuteW(
                window: *mut c_void,
                operation: *const u16,
                file: *const u16,
                parameters: *const u16,
                directory: *const u16,
                show: i32,
            ) -> *mut c_void;
        }
        let operation = "open\0".encode_utf16().collect::<Vec<_>>();
        let value = url
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let code = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                operation.as_ptr(),
                value.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
            )
        };
        if code as usize <= 32 {
            return Err("无法通过默认浏览器打开链接".into());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("当前桌面平台不支持打开外部链接".into())
    }
}
pub(crate) fn validate_external_url(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 2048 || value.chars().any(char::is_control) {
        return Err("链接长度或内容无效".into());
    }
    let url = reqwest::Url::parse(value).map_err(|_| "链接格式无效")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("只允许不含凭据的 HTTP/HTTPS 链接".into());
    }
    Ok(())
}
