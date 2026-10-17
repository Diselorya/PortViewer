use super::model::{Catalog, CatalogEntry};
use std::sync::OnceLock;
pub fn entries() -> &'static [CatalogEntry] {
    static CATALOG: OnceLock<Vec<CatalogEntry>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str::<Catalog>(include_str!("../../../src/data/serviceCatalog.json"))
            .ok()
            .filter(|value| value.schema_version == 1)
            .map(|value| value.entries)
            .unwrap_or_default()
    })
}
pub fn by_id(id: &str) -> Option<&'static CatalogEntry> {
    entries()
        .iter()
        .find(|entry| entry.id.eq_ignore_ascii_case(id))
}
pub fn process(name: &str) -> Option<&'static CatalogEntry> {
    let name = name.rsplit(['/', '\\']).next().unwrap_or(name);
    entries()
        .iter()
        .find(|entry| {
            entry
                .process_names
                .iter()
                .any(|value| value.eq_ignore_ascii_case(name))
        })
        .or_else(|| {
            (name.starts_with("python3.") && name[8..].chars().all(|c| c.is_ascii_digit()))
                .then(|| by_id("python"))
                .flatten()
        })
}
pub fn service(name: &str) -> Option<&'static CatalogEntry> {
    entries().iter().find(|entry| {
        entry
            .service_names
            .iter()
            .any(|value| value.eq_ignore_ascii_case(name))
    })
}
pub fn launcher(name: &str) -> Option<&'static CatalogEntry> {
    entries()
        .iter()
        .filter(|entry| entry.component_role == "launcher")
        .find(|entry| {
            entry.id.eq_ignore_ascii_case(name)
                || entry.original_name.eq_ignore_ascii_case(name)
                || entry
                    .public_ids
                    .iter()
                    .any(|id| id.name.eq_ignore_ascii_case(name))
        })
}
