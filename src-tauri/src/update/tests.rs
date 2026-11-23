use std::collections::HashMap;

use serde_json::json;
use tauri::utils::config::PluginConfig;

use super::configured;

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
