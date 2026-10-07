use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildIdentity {
    product_id: &'static str,
    product_version: &'static str,
    frontend_contract_version: u32,
    frontend_source_hash: &'static str,
    frontend_dist_hash: &'static str,
}

#[tauri::command]
pub fn get_build_identity() -> BuildIdentity {
    BuildIdentity {
        product_id: env!("PORTVIEWER_PRODUCT_ID"),
        product_version: env!("CARGO_PKG_VERSION"),
        frontend_contract_version: env!("PORTVIEWER_FRONTEND_CONTRACT_VERSION")
            .parse()
            .expect("frontend contract version must be an integer"),
        frontend_source_hash: env!("PORTVIEWER_FRONTEND_SOURCE_HASH"),
        frontend_dist_hash: env!("PORTVIEWER_FRONTEND_DIST_HASH"),
    }
}
