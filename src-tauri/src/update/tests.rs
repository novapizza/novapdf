use std::collections::HashMap;

use serde_json::json;
use tauri::utils::config::PluginConfig;

use super::{configured, keep_download};

fn plugins(entries: &[(&str, serde_json::Value)]) -> PluginConfig {
    PluginConfig(entries.iter().map(|(k, v)| (k.to_string(), v.clone())).collect::<HashMap<_, _>>())
}

#[test]
fn configured_only_with_an_updater_section() {
    assert!(!configured(&plugins(&[])));
    assert!(!configured(&plugins(&[("updater", json!(null))])));
    assert!(!configured(&plugins(&[("dialog", json!({}))])));
    assert!(configured(&plugins(&[(
        "updater",
        json!({ "endpoints": ["https://example.r2.dev/latest.json"], "pubkey": "key" })
    )])));
}

#[test]
fn a_download_is_kept_only_while_its_version_is_on_offer() {
    assert!(keep_download(Some("0.2.0"), Some("0.2.0")));
    assert!(!keep_download(Some("0.2.0"), Some("0.3.0")));
    assert!(!keep_download(Some("0.2.0"), None));
    assert!(!keep_download(None, Some("0.2.0")));
    assert!(!keep_download(None, None));
}
