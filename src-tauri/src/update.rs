//! Self-update: check the signed manifest, then download, install and restart.
//!
//! Driven from Rust so the UI keeps one door onto the backend (`api.ts`) and the
//! webview never gets the updater plugin's permissions.
//!
//! The endpoint and public key are not in `tauri.conf.json`; the release workflow
//! injects them. A development build therefore has no updater configuration,
//! which is reported as `configured: false`, not as an error.

use std::sync::Mutex;

use serde::Serialize;
use tauri::utils::config::PluginConfig;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Whether this build carries `plugins.updater`. The plugin refuses to start
/// without it, so it is only registered, and only asked, when this is true.
pub fn configured(plugins: &PluginConfig) -> bool {
    plugins.0.get("updater").is_some_and(|v| !v.is_null())
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    current_version: String,
    configured: bool,
    available: bool,
    version: Option<String>,
    notes: Option<String>,
}

/// The update found by the last check, so installing does not fetch and verify
/// the manifest again. A new check replaces it.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<UpdateStatus, String> {
    let mut status = UpdateStatus {
        current_version: app.package_info().version.to_string(),
        ..Default::default()
    };
    if !configured(&app.config().plugins) {
        return Ok(status);
    }
    // Fails when the injected config has no endpoint or public key.
    let Ok(updater) = app.updater() else {
        return Ok(status);
    };
    status.configured = true;

    let update = updater.check().await.map_err(|e| e.to_string())?;
    if let Some(update) = &update {
        status.available = true;
        status.version = Some(update.version.clone());
        status.notes = update.body.clone();
    }
    *pending.0.lock().unwrap() = update;
    Ok(status)
}

/// Downloads and installs the update the last check found. Does not return on
/// success: the app restarts into the new version.
#[tauri::command]
pub async fn install_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let update = pending
        .0
        .lock()
        .unwrap()
        .take()
        .ok_or("No update is pending. Check for updates first.")?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;

    // Windows: the NSIS installer is waiting to replace this running executable,
    // so exit and let it finish and relaunch. macOS: the bundle was replaced in
    // place, so restart into it.
    #[cfg(target_os = "windows")]
    {
        app.exit(0);
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    app.restart();
}

#[cfg(test)]
mod tests;
