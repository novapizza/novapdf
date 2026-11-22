mod commands;
pub mod geometry;
mod host;
pub mod protocol;
pub mod sandbox;
pub mod shared;
pub mod worker;

use std::time::Duration;

use tauri::webview::{PageLoadEvent, Url};
use tauri::{DragDropEvent, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::commands::AppState;
use crate::host::Pool;

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
        // Its arguments are ignored: the app takes no file paths on the command line.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main(app);
        }));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // The PDFium library is bundled as a resource under `pdfium/`.
            let lib_dir = app.path().resource_dir().ok().map(|dir| dir.join("pdfium"));
            app.manage(AppState::new(Pool::new(lib_dir)?));

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
                .title("NovaPDF")
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
            if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                window.state::<AppState>().grant(paths);
                let list: Vec<String> =
                    paths.iter().map(|p| p.to_string_lossy().into_owned()).collect();
                let _ = window.emit("files-dropped", list);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_with_dialog,
            commands::open_dropped,
            commands::close_document,
            commands::render_page,
            commands::extract_page,
            commands::find_watermarks,
            commands::layout_text,
            commands::save_with_dialog,
            commands::list_fonts,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests;
