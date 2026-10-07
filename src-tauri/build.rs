use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const PRODUCT_ID: &str = "com.portviewer.desktop";
const PRODUCT_NAME: &str = "PortViewer";
const FRONTEND_DIST: &str = "../dist";
const CONTRACT_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrontendBuildIdentity {
    schema_version: u32,
    product_id: String,
    product_version: String,
    frontend_contract_version: u32,
    source_hash: String,
    dist_hash: String,
}

fn main() {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is missing"));
    let project_root = manifest_dir
        .parent()
        .expect("src-tauri must be inside the project root")
        .to_path_buf();
    let profile = env::var("PROFILE").unwrap_or_default();
    let production_protocol = env::var_os("CARGO_FEATURE_CUSTOM_PROTOCOL").is_some();

    emit_source_change_tracking(&project_root);
    validate_tauri_config(&manifest_dir);
    validate_config_override();

    let source_hash = calculate_frontend_source_hash(&project_root);
    println!("cargo:rustc-env=PORTVIEWER_PRODUCT_ID={PRODUCT_ID}");
    println!("cargo:rustc-env=PORTVIEWER_FRONTEND_CONTRACT_VERSION={CONTRACT_VERSION}");
    println!("cargo:rustc-env=PORTVIEWER_FRONTEND_SOURCE_HASH={source_hash}");

    if profile != "debug" && !production_protocol {
        panic!(
            "Refusing to build PortViewer release without the `custom-protocol` feature. \
             A release without it loads the Vite dev URL and can display another project. \
             Run `npm run build:desktop`, or pass `--features custom-protocol`."
        );
    }

    let dist_hash = if production_protocol {
        validate_frontend_dist(&project_root, &source_hash)
    } else {
        "development".to_owned()
    };
    println!("cargo:rustc-env=PORTVIEWER_FRONTEND_DIST_HASH={dist_hash}");

    tauri_build::build();
}

fn emit_source_change_tracking(project_root: &Path) {
    for relative in [
        "index.html",
        "package.json",
        "package-lock.json",
        "vite.config.ts",
        "tsconfig.json",
        "tsconfig.app.json",
        "tsconfig.node.json",
        "scripts/generate-build-identity.mjs",
        "src",
        "public",
    ] {
        println!(
            "cargo:rerun-if-changed={}",
            project_root.join(relative).display()
        );
    }
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
}

fn validate_tauri_config(manifest_dir: &Path) {
    let config_path = manifest_dir.join("tauri.conf.json");
    let config: Value = read_json(&config_path);
    assert_json_string(&config, "/productName", PRODUCT_NAME, &config_path);
    assert_json_string(&config, "/identifier", PRODUCT_ID, &config_path);
    assert_json_string(&config, "/version", env!("CARGO_PKG_VERSION"), &config_path);
    assert_json_string(&config, "/build/frontendDist", FRONTEND_DIST, &config_path);
    validate_window_urls(&config, &config_path.display().to_string());

    for entry in fs::read_dir(manifest_dir)
        .unwrap_or_else(|error| panic!("Cannot read {}: {error}", manifest_dir.display()))
    {
        let path = entry.expect("Cannot read Tauri config entry").path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if name != "tauri.conf.json" && name.starts_with("tauri.") && name.ends_with(".conf.json") {
            validate_override_value(&read_json(&path), &path.display().to_string());
        }
    }
}

fn validate_config_override() {
    let Some(raw) = env::var_os("TAURI_CONFIG") else {
        return;
    };
    let raw = raw.to_string_lossy();
    let config: Value = serde_json::from_str(&raw)
        .unwrap_or_else(|error| panic!("TAURI_CONFIG must be valid JSON: {error}"));

    validate_override_value(&config, "TAURI_CONFIG");
}

fn validate_override_value(config: &Value, source: &str) {
    for (pointer, expected) in [
        ("/productName", PRODUCT_NAME),
        ("/identifier", PRODUCT_ID),
        ("/version", env!("CARGO_PKG_VERSION")),
        ("/build/frontendDist", FRONTEND_DIST),
    ] {
        if let Some(actual) = config.pointer(pointer) {
            assert_eq!(
                actual.as_str(),
                Some(expected),
                "{source} attempted to override {pointer}; PortViewer build identity is immutable"
            );
        }
    }
    validate_window_urls(config, source);
}

fn validate_window_urls(config: &Value, source: &str) {
    let Some(windows) = config.pointer("/app/windows").and_then(Value::as_array) else {
        return;
    };
    for (index, window) in windows.iter().enumerate() {
        if let Some(url) = window.get("url") {
            assert_eq!(
                url.as_str(),
                Some("index.html"),
                "{source} app.windows[{index}].url must be omitted or exactly `index.html`; external and dev URLs are forbidden"
            );
        }
    }
}

fn validate_frontend_dist(project_root: &Path, source_hash: &str) -> String {
    let dist_root = project_root.join("dist");
    let identity_path = dist_root.join("portviewer-build-identity.json");
    println!("cargo:rerun-if-changed={}", dist_root.display());

    let identity: FrontendBuildIdentity = serde_json::from_value(read_json(&identity_path))
        .unwrap_or_else(|error| {
            panic!(
                "Invalid frontend build identity at {}: {error}",
                identity_path.display()
            )
        });
    assert_eq!(
        identity.schema_version, 1,
        "Unsupported frontend identity schema"
    );
    assert_eq!(
        identity.product_id, PRODUCT_ID,
        "Frontend product ID does not belong to PortViewer"
    );
    assert_eq!(
        identity.product_version,
        env!("CARGO_PKG_VERSION"),
        "Frontend and backend versions differ"
    );
    assert_eq!(
        identity.frontend_contract_version, CONTRACT_VERSION,
        "Frontend/backend contract versions differ"
    );
    assert_eq!(
        identity.source_hash, source_hash,
        "Frontend dist is stale or belongs to another source tree; run `npm run build`"
    );
    let mut dist_files = Vec::new();
    collect_files(&dist_root, &mut dist_files);
    dist_files.retain(|path| {
        normalized_relative_path(path, &dist_root) != "portviewer-build-identity.json"
    });
    let actual_dist_hash = calculate_files_hash(dist_files, &dist_root);
    assert_eq!(
        identity.dist_hash, actual_dist_hash,
        "Frontend dist contents changed after identity finalization; run `npm run build`"
    );
    actual_dist_hash
}

fn calculate_frontend_source_hash(project_root: &Path) -> String {
    let mut files: Vec<_> = [
        "index.html",
        "package.json",
        "package-lock.json",
        "vite.config.ts",
        "tsconfig.json",
        "tsconfig.app.json",
        "tsconfig.node.json",
        "scripts/generate-build-identity.mjs",
    ]
    .into_iter()
    .map(|relative| project_root.join(relative))
    .collect();
    collect_files(&project_root.join("src"), &mut files);
    collect_files(&project_root.join("public"), &mut files);
    files.retain(|path| !is_generated_identity(path, project_root));
    calculate_files_hash(files, project_root)
}

fn calculate_files_hash(mut files: Vec<PathBuf>, base: &Path) -> String {
    files.sort_by_key(|path| normalized_relative_path(path, base));

    let mut hasher = Sha256::new();
    for path in files {
        let relative = normalized_relative_path(&path, base);
        hasher.update(relative.as_bytes());
        hasher.update([0]);
        hasher.update(
            fs::read(&path)
                .unwrap_or_else(|error| panic!("Cannot read {}: {error}", path.display())),
        );
        hasher.update([255]);
    }
    format!("{:x}", hasher.finalize())
}

fn collect_files(directory: &Path, files: &mut Vec<PathBuf>) {
    let mut entries: Vec<_> = fs::read_dir(directory)
        .unwrap_or_else(|error| panic!("Cannot read {}: {error}", directory.display()))
        .map(|entry| entry.expect("Cannot read frontend source entry").path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            collect_files(&path, files);
        } else if path.is_file() {
            files.push(path);
        }
    }
}

fn is_generated_identity(path: &Path, project_root: &Path) -> bool {
    matches!(
        normalized_relative_path(path, project_root).as_str(),
        "src/generated/buildIdentity.ts" | "public/portviewer-build-identity.json"
    )
}

fn normalized_relative_path(path: &Path, project_root: &Path) -> String {
    path.strip_prefix(project_root)
        .expect("frontend file escaped project root")
        .to_string_lossy()
        .replace('\\', "/")
}

fn read_json(path: &Path) -> Value {
    let raw = fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("Cannot read {}: {error}", path.display()));
    serde_json::from_str(&raw)
        .unwrap_or_else(|error| panic!("Invalid JSON at {}: {error}", path.display()))
}

fn assert_json_string(config: &Value, pointer: &str, expected: &str, path: &Path) {
    assert_eq!(
        config.pointer(pointer).and_then(Value::as_str),
        Some(expected),
        "{} has an invalid {pointer}; expected {expected}",
        path.display()
    );
}
