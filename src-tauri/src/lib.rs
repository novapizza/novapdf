mod commands;
pub mod geometry;
mod host;
mod recent;
pub mod protocol;
pub mod sandbox;
pub mod shared;
mod update;
pub mod worker;

use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::webview::{PageLoadEvent, Url};
use tauri::{DragDropEvent, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::commands::{launch_paths, AppState};
use crate::host::Pool;

/// Where the recent files list is stored: the app's data folder. Debug builds only:
/// NOVAPDF_DEV_DATA_DIR puts it elsewhere, so E2E tests never touch the developer's own list.
fn recent_file(app: &tauri::App) -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("NOVAPDF_DEV_DATA_DIR").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(dir).join("recent.json"));
    }
    app.path().app_data_dir().ok().map(|d| d.join("recent.json"))
}

/// Only the app's own pages may load in the webview; links can never navigate it.
fn is_app_url(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => {
            url.host_str() == Some("tauri.localhost")
                || (cfg!(debug_assertions) && url.host_str() == Some("localhost"))
        }
        _ => false,
    }
}

/// Only one NovaPDF may run at a time. Debug builds can opt out with
/// NOVAPDF_DEV_MULTI_INSTANCE, because E2E tests open a second app to check saves.
fn single_instance() -> bool {
    !(cfg!(debug_assertions)
        && std::env::var_os("NOVAPDF_DEV_MULTI_INSTANCE").is_some_and(|v| !v.is_empty()))
}

/// Brings the running app's window to the front when a second launch is refused.
fn focus_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    if single_instance() {
        // Registered first, so a second launch exits before it starts any workers.
        // Files it was started with (a PDF double-clicked while the app runs) open here.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            queue_launch_and_notify(app, launch_paths(&argv, Path::new(&cwd)));
            focus_main(app);
        }));
    }
    let context = tauri::generate_context!();
    if update::configured(&context.config().plugins) {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(update::PendingUpdate::default())
        .setup(|app| {
            // The PDFium library is bundled as a resource under `pdfium/`.
            let lib_dir = app.path().resource_dir().ok().map(|dir| dir.join("pdfium"));
            app.manage(AppState::new(Pool::new(lib_dir)?, recent_file(app)));

            // Files the OS launched us with (a double-clicked PDF). The UI takes them
            // with `take_launch_files` once it has loaded.
            let args: Vec<_> = std::env::args_os().collect();
            let cwd = std::env::current_dir().unwrap_or_default();
            app.state::<AppState>().queue_launch(launch_paths(&args, &cwd));

            // Debug builds only: pre-grant files listed in NOVAPDF_DEV_OPEN (separated by
            // ';') as if they had been dropped on the window, for scripted UI testing.
            #[cfg(debug_assertions)]
            if let Some(list) = std::env::var_os("NOVAPDF_DEV_OPEN") {
                let paths: Vec<std::path::PathBuf> = list
                    .to_string_lossy()
                    .split(';')
                    .filter(|s| !s.is_empty())
                    .map(std::path::PathBuf::from)
                    .collect();
                app.state::<AppState>().grant(&paths);
            }

            // Hidden until the UI has loaded, so the user never sees a blank white
            // window. The fallback makes sure it appears even if loading stalls.
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                // productName: the one place the window name comes from.
                .title(&app.package_info().name)
                .inner_size(1280.0, 840.0)
                .min_inner_size(720.0, 480.0)
                // Opens maximized; the size above is what "Restore down" returns to.
                .maximized(true)
                .visible(false)
                .on_navigation(is_app_url)
                .on_page_load(|w, payload| {
                    if payload.event() == PageLoadEvent::Finished {
                        let _ = w.show();
                    }
                })
                .build()?;
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(3)).await;
                let _ = window.show();
            });

            // Start the PDF engine while the UI loads, then stop idle workers so
            // their PDFium caches go back to the OS.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                handle.state::<AppState>().pool.warm().await;
                let mut tick = tokio::time::interval(Duration::from_secs(10));
                loop {
                    tick.tick().await;
                    handle.state::<AppState>().pool.trim_idle();
                }
            });

            // macOS has no Job Object: the host enforces the worker memory cap itself.
            #[cfg(target_os = "macos")]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let mut tick = tokio::time::interval(crate::sandbox::MEMORY_POLL);
                    loop {
                        tick.tick().await;
                        handle.state::<AppState>().pool.enforce_memory_limit();
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let WindowEvent::DragDrop(drag) = event else { return };
            if let Some(over) = drag_hover(drag) {
                let _ = window.emit("drag-hover", over);
            }
            if let DragDropEvent::Drop { paths, .. } = drag {
                window.state::<AppState>().grant(paths);
                let list: Vec<String> =
                    paths.iter().map(|p| p.to_string_lossy().into_owned()).collect();
                let _ = window.emit("files-dropped", list);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_with_dialog,
            commands::open_dropped,
            commands::take_launch_files,
            commands::close_document,
            commands::list_recent,
            commands::open_recent,
            commands::remove_recent,
            commands::clear_recent,
            commands::set_recent_enabled,
            commands::unlock_file,
            commands::discard_locked,
            commands::render_page,
            commands::extract_page,
            commands::find_watermarks,
            commands::list_annotations,
            commands::text_chars,
            commands::get_outline,
            commands::layout_text,
            commands::save_with_dialog,
            commands::list_fonts,
            update::check_update,
            update::download_update,
            update::discard_update,
            update::install_update,
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            // An automatic update downloaded during the session installs as the
            // app quits, after the unsaved-changes prompt has had its say.
            if matches!(event, tauri::RunEvent::Exit) {
                update::install_on_exit(app);
            }
            // macOS passes no file on the command line. Finder sends an "open
            // documents" event instead, at startup and while the app runs.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                queue_launch_and_notify(app, file_paths(urls));
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}

/// What a native drag event means for the drop overlay ("drag-hover"): `Some(true)`
/// to show it, `Some(false)` to hide it, `None` to leave it. Only file drags show it,
/// not dragged text or links, which carry no paths.
fn drag_hover(event: &DragDropEvent) -> Option<bool> {
    match event {
        DragDropEvent::Enter { paths, .. } => Some(!paths.is_empty()),
        DragDropEvent::Drop { .. } | DragDropEvent::Leave => Some(false),
        _ => None,
    }
}

/// The local files among the URLs macOS asks us to open. Other schemes are ignored.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn file_paths(urls: Vec<Url>) -> Vec<PathBuf> {
    urls.into_iter().filter_map(|u| u.to_file_path().ok()).collect()
}

/// Grants and queues files the OS asked us to open, then nudges the UI to take them.
/// The UI also takes the queue once when it loads, so a nudge sent too early is harmless.
fn queue_launch_and_notify(app: &tauri::AppHandle, paths: Vec<PathBuf>) {
    if app.try_state::<AppState>().is_some_and(|state| state.queue_launch(paths)) {
        let _ = app.emit("launch-files", ());
    }
}

#[cfg(test)]
mod tests;
