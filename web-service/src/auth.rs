use axum::http::{header, HeaderMap};
use subtle::ConstantTimeEq;
use zeroize::Zeroize;

const MIN_TOKEN_LENGTH: usize = 32;
const MAX_TOKEN_LENGTH: usize = 256;

pub struct ApiToken(Box<[u8]>);

impl ApiToken {
    pub fn parse(value: Option<String>) -> Result<Option<Self>, String> {
        let Some(value) = value else {
            return Ok(None);
        };
        let bytes = value.as_bytes();
        if !(MIN_TOKEN_LENGTH..=MAX_TOKEN_LENGTH).contains(&bytes.len()) {
            return Err(format!(
                "PORTVIEWER_API_TOKEN 长度必须为 {MIN_TOKEN_LENGTH}..{MAX_TOKEN_LENGTH} 字节"
            ));
        }
        if !bytes
            .iter()
            .all(|byte| byte.is_ascii_graphic() && !byte.is_ascii_whitespace())
        {
            return Err("PORTVIEWER_API_TOKEN 只能包含无空白的可打印 ASCII 字符".to_string());
        }
        Ok(Some(Self(bytes.to_vec().into_boxed_slice())))
    }

    pub fn validate_headers(&self, headers: &HeaderMap) -> AuthResult {
        let Some(value) = headers.get(header::AUTHORIZATION) else {
            return AuthResult::Missing;
        };
        let Ok(value) = value.to_str() else {
            return AuthResult::Invalid;
        };
        let Some(candidate) = value.strip_prefix("Bearer ") else {
            return AuthResult::Invalid;
        };
        if candidate.len() != self.0.len() {
            return AuthResult::Invalid;
        }
        if bool::from(candidate.as_bytes().ct_eq(self.0.as_ref())) {
            AuthResult::Valid
        } else {
            AuthResult::Invalid
        }
    }
}

impl Drop for ApiToken {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthResult {
    Missing,
    Invalid,
    Valid,
}

pub fn authorization_status(token: Option<&ApiToken>, headers: &HeaderMap) -> AuthResult {
    match token {
        Some(token) => token.validate_headers(headers),
        None if headers.contains_key(header::AUTHORIZATION) => AuthResult::Invalid,
        None => AuthResult::Missing,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn enforces_strong_printable_tokens() {
        assert!(ApiToken::parse(Some("short".to_string())).is_err());
        assert!(ApiToken::parse(Some(format!("{} ", TOKEN))).is_err());
        assert!(ApiToken::parse(Some(TOKEN.to_string())).unwrap().is_some());
    }

    #[test]
    fn validates_exact_bearer_scheme_and_value() {
        let token = ApiToken::parse(Some(TOKEN.to_string())).unwrap().unwrap();
        let mut headers = HeaderMap::new();
        assert_eq!(token.validate_headers(&headers), AuthResult::Missing);

        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {TOKEN}").parse().unwrap(),
        );
        assert_eq!(token.validate_headers(&headers), AuthResult::Valid);

        headers.insert(
            header::AUTHORIZATION,
            format!("bearer {TOKEN}").parse().unwrap(),
        );
        assert_eq!(token.validate_headers(&headers), AuthResult::Invalid);
    }
}
