use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicServiceId {
    pub provider: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct KnowledgeSource {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub url: Option<String>,
    pub fetched_at: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ServiceCandidate {
    pub name: String,
    pub description: Option<String>,
    pub url: String,
    pub source_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ServiceProfile {
    pub id: String,
    pub component_role: String,
    pub original_name: String,
    pub display_name_zh: Option<String>,
    pub summary: Option<String>,
    pub software_summary: Option<String>,
    pub identity_match: String,
    pub public_ids: Vec<PublicServiceId>,
    pub sources: Vec<KnowledgeSource>,
    pub candidates: Vec<ServiceCandidate>,
    pub enrichment_status: String,
    pub updated_at: Option<String>,
    pub stale: bool,
    pub message: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
pub struct ServiceProfilesResult {
    pub profiles: Vec<ServiceProfile>,
    pub pending_count: usize,
    pub online_enabled: bool,
    pub ai_configured: bool,
    pub ai_enabled: bool,
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceProfilesQuery {
    #[serde(default)]
    pub profile_ids: Option<Vec<String>>,
    #[serde(default)]
    pub public_ids: Option<Vec<PublicServiceId>>,
    #[serde(default)]
    pub refresh: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HostContext {
    pub address: String,
    pub kind: String,
    pub is_local: bool,
    pub machine_name: Option<String>,
    pub hostname: Option<String>,
    pub hostname_source: Option<String>,
    pub dns_status: String,
    pub os: Option<String>,
    pub observed_addresses: Vec<String>,
    pub resolved_at: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KnowledgeSettings {
    pub online_enabled: bool,
    pub ai_enabled: bool,
    pub reverse_dns_enabled: bool,
}
impl Default for KnowledgeSettings {
    fn default() -> Self {
        Self {
            online_enabled: true,
            ai_enabled: false,
            reverse_dns_enabled: true,
        }
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct KnowledgeConfiguration {
    #[serde(flatten)]
    pub settings: KnowledgeSettings,
    pub ai_configured: bool,
    pub ai_provider: Option<String>,
    pub ai_model: Option<String>,
    pub can_configure: bool,
}
#[derive(Clone, Debug, Deserialize)]
pub struct CatalogEntry {
    pub id: String,
    pub display_name_zh: String,
    pub original_name: String,
    pub summary: String,
    pub component_role: String,
    pub process_names: Vec<String>,
    pub service_names: Vec<String>,
    pub public_ids: Vec<PublicServiceId>,
    pub source_url: String,
}
#[derive(Deserialize)]
pub struct Catalog {
    pub schema_version: u8,
    pub entries: Vec<CatalogEntry>,
}
