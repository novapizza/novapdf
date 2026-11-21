//! Tauri commands.
//!
//! Security model for file access: the web UI never supplies a path to read or write.
//! Paths come from native dialogs opened here, or from OS drag-and-drop events that
//! Rust records as one-time grants before the UI hears about them.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::ipc::Response;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::host::{EXTRACT_TIMEOUT, Lane, Pool, RENDER_TIMEOUT, SAVE_TIMEOUT, SCAN_TIMEOUT};
use crate::protocol::{
    DocId, ImageFormat, LayoutArgs, LayoutResult, OutputPage, PageEdits, PageInfo, PageText,
    Request, Watermark, WatermarkScan,
};

const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;

pub struct AppState {
    pub pool: Pool,
    grants: Mutex<HashSet<PathBuf>>,
}

impl AppState {
    pub fn new(pool: Pool) -> Self {
        Self { pool, grants: Mutex::new(HashSet::new()) }
    }

    /// Called from the native drag-and-drop handler.
    pub fn grant(&self, paths: &[PathBuf]) {
        let mut g = self.grants.lock().unwrap();
        for p in paths {
            g.insert(p.clone());
        }
    }

    fn take_grant(&self, path: &Path) -> bool {
        self.grants.lock().unwrap().remove(path)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDocument {
    doc_id: DocId,
    file_name: String,
    pages: Vec<PageInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenOutcome {
    file_name: String,
    document: Option<OpenedDocument>,
    error: Option<String>,
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "document.pdf".into())
}

fn read_pdf(path: &Path) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("Could not read the file: {e}"))?;
    if !meta.is_file() {
        return Err("Not a regular file.".into());
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err("Files larger than 512 MB are not supported.".into());
    }
    let bytes = std::fs::read(path).map_err(|e| format!("Could not read the file: {e}"))?;
    let head = &bytes[..bytes.len().min(1024)];
    if !head.windows(5).any(|w| w == b"%PDF-") {
        return Err("This file is not a PDF.".into());
    }
    Ok(bytes)
}

async fn open_path(state: &AppState, path: PathBuf) -> OpenOutcome {
    let file_name = file_name_of(&path);
    let read = tokio::task::spawn_blocking(move || read_pdf(&path))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
    let result = match read {
        Ok(bytes) => state.pool.open(bytes).await,
        Err(e) => Err(e),
    };
    match result {
        Ok((doc_id, pages)) => OpenOutcome {
            document: Some(OpenedDocument { doc_id, file_name: file_name.clone(), pages }),
            file_name,
            error: None,
        },
        Err(e) => OpenOutcome { file_name, document: None, error: Some(e) },
    }
}

#[tauri::command]
pub async fn open_with_dialog(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<OpenOutcome>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("PDF documents", &["pdf"])
        .pick_files(move |files| {
            let _ = tx.send(files);
        });
    let files = rx.await.ok().flatten().unwrap_or_default();
    let mut out = Vec::new();
    for f in files {
        match f.into_path() {
            Ok(p) => out.push(open_path(&state, p).await),
            Err(e) => out.push(OpenOutcome {
                file_name: "?".into(),
                document: None,
                error: Some(e.to_string()),
            }),
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn open_dropped(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<Vec<OpenOutcome>, String> {
    let mut out = Vec::new();
    for p in paths.into_iter().take(500) {
        let path = PathBuf::from(&p);
        if !state.take_grant(&path) {
            out.push(OpenOutcome {
                file_name: file_name_of(&path),
                document: None,
                error: Some("This file was not dropped onto the window.".into()),
            });
            continue;
        }
        let is_pdf = path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("pdf"));
        if !is_pdf {
            out.push(OpenOutcome {
                file_name: file_name_of(&path),
                document: None,
                error: Some("Only PDF files can be opened.".into()),
            });
            continue;
        }
        out.push(open_path(&state, path).await);
    }
    Ok(out)
}

#[tauri::command]
pub async fn close_document(state: State<'_, AppState>, doc_id: DocId) -> Result<(), String> {
    state.pool.close(doc_id).await;
    Ok(())
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    View,
    Thumb,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderArgs {
    doc_id: DocId,
    page_index: i32,
    width: i32,
    format: ImageFormat,
    #[serde(default)]
    rotation: i32,
    #[serde(default)]
    edits: Option<PageEdits>,
    #[serde(default)]
    watermark: Option<Watermark>,
    priority: Priority,
}

/// Renders a page and returns the encoded image as raw bytes.
#[tauri::command]
pub async fn render_page(state: State<'_, AppState>, args: RenderArgs) -> Result<Response, String> {
    if let Some(e) = &args.edits {
        e.validate()?;
    }
    if let Some(w) = &args.watermark {
        w.validate()?;
    }
    let lane = match args.priority {
        Priority::View => Lane::Interactive,
        Priority::Thumb => Lane::Background,
    };
    let req = Request::Render {
        doc_id: args.doc_id,
        page_index: args.page_index,
        width: args.width,
        format: args.format,
        rotation: args.rotation,
        edits: args.edits,
        watermark: args.watermark,
    };
    let (_, bytes) = state.pool.call(lane, req, RENDER_TIMEOUT).await?;
    // Treat worker output as untrusted: only pass on what is plainly a JPEG or PNG.
    let is_jpeg = bytes.starts_with(&[0xFF, 0xD8, 0xFF]);
    let is_png = bytes.starts_with(b"\x89PNG\r\n\x1a\n");
    if !(is_jpeg || is_png) {
        return Err("The PDF engine returned an invalid image.".into());
    }
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn extract_page(
    state: State<'_, AppState>,
    doc_id: DocId,
    page_index: i32,
) -> Result<PageText, String> {
    let (v, _) = state
        .pool
        .call(Lane::Interactive, Request::Extract { doc_id, page_index }, EXTRACT_TIMEOUT)
        .await?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

/// Line breaks for a text block, measured with the fonts used to draw it.
#[tauri::command]
pub async fn layout_text(state: State<'_, AppState>, args: LayoutArgs) -> Result<LayoutResult, String> {
    args.validate()?;
    let (v, _) = state
        .pool
        .call(Lane::Interactive, Request::Layout(args), EXTRACT_TIMEOUT)
        .await?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn find_watermarks(
    state: State<'_, AppState>,
    doc_id: DocId,
    text: Option<String>,
) -> Result<WatermarkScan, String> {
    if text.as_ref().is_some_and(|t| t.chars().count() > 500) {
        return Err("Search text is too long.".into());
    }
    let (v, _) = state
        .pool
        .call(Lane::Background, Request::FindWatermarks { doc_id, text }, SCAN_TIMEOUT)
        .await?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveArgs {
    pages: Vec<OutputPage>,
    #[serde(default)]
    watermark: Option<Watermark>,
    #[serde(default = "default_true")]
    sanitize: bool,
    #[serde(default)]
    suggested_name: String,
}

fn default_true() -> bool {
    true
}

fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control())
        .take(150)
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').to_string();
    if cleaned.is_empty() { "document.pdf".into() } else { cleaned }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOutcome {
    path: String,
    warnings: Vec<String>,
}

/// Builds the output PDF, asks where to save it and writes it atomically.
/// Returns the saved path and any warnings, or `None` when the user cancels.
#[tauri::command]
pub async fn save_with_dialog(
    app: AppHandle,
    state: State<'_, AppState>,
    args: SaveArgs,
) -> Result<Option<SaveOutcome>, String> {
    if args.pages.is_empty() {
        return Err("There are no pages to save.".into());
    }
    for p in &args.pages {
        if let Some(e) = &p.edits {
            e.validate()?;
        }
    }
    if let Some(w) = &args.watermark {
        w.validate()?;
    }

    // Debug builds only: NOVAPDF_DEV_SAVE_TO skips the native dialog and saves to that
    // path, for the scripted E2E tests (e2e/). Compiled out of release builds.
    #[cfg(debug_assertions)]
    let dev_target = std::env::var_os("NOVAPDF_DEV_SAVE_TO")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    #[cfg(not(debug_assertions))]
    let dev_target: Option<PathBuf> = None;

    let mut target = match dev_target {
        Some(t) => t,
        None => {
            let (tx, rx) = tokio::sync::oneshot::channel();
            app.dialog()
                .file()
                .add_filter("PDF document", &["pdf"])
                .set_file_name(safe_file_name(&args.suggested_name))
                .save_file(move |p| {
                    let _ = tx.send(p);
                });
            let Some(target) = rx.await.ok().flatten() else {
                return Ok(None);
            };
            target.into_path().map_err(|e| e.to_string())?
        }
    };
    if !target
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
    {
        target.set_extension("pdf");
    }

    let req = Request::Save { pages: args.pages, watermark: args.watermark, sanitize: args.sanitize };
    let (meta, bytes) = state.pool.call(Lane::Interactive, req, SAVE_TIMEOUT).await?;
    // Worker output is untrusted: keep only short plain strings.
    let warnings: Vec<String> = meta
        .get("warnings")
        .and_then(|w| w.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str()).take(10).map(|s| s.chars().take(300).collect()).collect())
        .unwrap_or_default();
    if !bytes.starts_with(b"%PDF-") {
        return Err("The PDF engine produced an invalid file.".into());
    }

    let path_for_write = target.clone();
    tokio::task::spawn_blocking(move || write_atomically(&path_for_write, &bytes))
        .await
        .map_err(|e| e.to_string())??;
    Ok(Some(SaveOutcome { path: target.to_string_lossy().into_owned(), warnings }))
}

/// Writes to a temporary file in the same folder, then renames over the target, so a
/// failure never leaves a half-written PDF behind.
fn write_atomically(target: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let dir = target.parent().ok_or("Invalid save location")?;
    let tmp = dir.join(format!(".{}.novapdf-tmp", file_name_of(target)));
    let result = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, target)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Could not save {}: {e}", target.display()));
    }
    Ok(())
}

#[tauri::command]
pub async fn list_fonts() -> Result<Vec<String>, String> {
    static FONTS: OnceLock<Vec<String>> = OnceLock::new();
    if let Some(f) = FONTS.get() {
        return Ok(f.clone());
    }
    let list = tokio::task::spawn_blocking(crate::worker::fonts::list_families)
        .await
        .map_err(|e| e.to_string())?;
    Ok(FONTS.get_or_init(|| list).clone())
}

#[cfg(test)]
mod tests;
