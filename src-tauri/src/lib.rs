mod commands;
pub mod geometry;
mod host;
pub mod protocol;
mod sandbox;
pub mod worker;

use tauri::webview::Url;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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

            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("NovaPDF")
                .inner_size(1280.0, 840.0)
                .min_inner_size(720.0, 480.0)
                .on_navigation(is_app_url)
                .build()?;
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
