//! Self-update: check the signed manifest, then download and install.
//!
//! Two ways to install. "Install now" (`install_update`) installs and restarts
//! into the new version. Automatic updates download in the background
//! (`download_update`) and install when the app quits (`install_on_exit`), so
//! the next launch is the new version and nothing interrupts the user.
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
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Whether this build carries `plugins.updater`. The plugin refuses to start
/// without it, so it is only registered, and only asked, when this is true.
pub fn configured(plugins: &PluginConfig) -> bool {
    plugins.0.get("updater").is_some_and(|v| !v.is_null())
}

/// A download is kept across checks only while it is still the version on offer.
fn keep_download(downloaded: Option<&str>, found: Option<&str>) -> bool {
    downloaded.is_some() && downloaded == found
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    current_version: String,
    configured: bool,
    available: bool,
    version: Option<String>,
    notes: Option<String>,
    /// The update is downloaded and will be installed when the app quits.
    downloaded: bool,
}

#[derive(Default)]
struct Pending {
    /// Found by the last check, so installing does not fetch the manifest again.
    update: Option<Update>,
    /// The verified package for `update`, once downloaded.
    bytes: Option<Vec<u8>>,
}

impl Pending {
    fn downloaded_version(&self) -> Option<&str> {
        self.bytes.as_ref().and(self.update.as_ref()).map(|u| u.version.as_str())
    }
}

#[derive(Default)]
pub struct PendingUpdate(Mutex<Pending>);

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
    let mut p = pending.0.lock().unwrap();
    let found = update.as_ref().map(|u| u.version.as_str());
    if !keep_download(p.downloaded_version(), found) {
        *p = Pending { update, bytes: None };
    }
    if let Some(u) = &p.update {
        status.available = true;
        status.version = Some(u.version.clone());
        status.notes = u.body.clone();
        status.downloaded = p.bytes.is_some();
    }
    Ok(status)
}

/// Downloads and verifies the update the last check found, to be installed when
/// the app quits.
#[tauri::command]
pub async fn download_update(pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let update = {
        let p = pending.0.lock().unwrap();
        if p.bytes.is_some() {
            return Ok(());
        }
        p.update.clone().ok_or("No update is pending. Check for updates first.")?
    };
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    let mut p = pending.0.lock().unwrap();
    // A check during the download may have found a newer version.
    if p.update.as_ref().is_some_and(|u| u.version == update.version) {
        p.bytes = Some(bytes);
    }
    Ok(())
}

/// Drops a downloaded update so it is not installed on quit. The update stays
/// available for "Install now".
#[tauri::command]
pub fn discard_update(pending: State<'_, PendingUpdate>) {
    pending.0.lock().unwrap().bytes = None;
}

/// Installs the update the last check found, downloading it first if needed.
/// Does not return on success: the app restarts into the new version.
#[tauri::command]
pub async fn install_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let Pending { update, bytes } = std::mem::take(&mut *pending.0.lock().unwrap());
    let update = update.ok_or("No update is pending. Check for updates first.")?;
    // On Windows both calls start the installer and exit the process; the
    // installer then relaunches the app.
    match bytes {
        Some(bytes) => update.install(bytes),
        None => update.download_and_install(|_, _| {}, || {}).await,
    }
    .map_err(|e| e.to_string())?;

    // macOS: the bundle was replaced in place, so restart into it.
    #[cfg(target_os = "windows")]
    {
        app.exit(0);
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    app.restart();
}

/// Installs a downloaded update as the app quits. The new version starts on the
/// next launch: the Windows installer is told not to relaunch, and on macOS the
/// bundle is replaced in place.
pub fn install_on_exit(app: &AppHandle) {
    let Some(pending) = app.try_state::<PendingUpdate>() else {
        return;
    };
    let Pending { update, bytes } = std::mem::take(&mut *pending.0.lock().unwrap());
    if let (Some(update), Some(bytes)) = (update, bytes) {
        if let Err(e) = update.restart_after_install(false).install(bytes) {
            eprintln!("could not install the downloaded update: {e}");
        }
    }
}

#[cfg(test)]
mod tests;
