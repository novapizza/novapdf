//! Tauri commands.
//!
//! Security model for file access: the web UI never supplies a path to read or write.
//! Paths come from native dialogs opened here, or from OS drag-and-drop events and
//! launch command lines (a double-clicked PDF), which Rust records as one-time grants
//! before the UI hears about them. Recently opened files (`recent.rs`) are kept here
//! too, and the UI names one only by an id. A file that needs a password is held the
//! same way: the UI gets an id for it and sends the password with that id.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use tauri::ipc::Response;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::recent::{Recent, RecentView, now_ms};
use crate::host::{EXTRACT_TIMEOUT, Lane, Pool, RENDER_TIMEOUT, SAVE_TIMEOUT, SCAN_TIMEOUT};
use crate::protocol::{
    DocId, Encrypt, ImageFormat, NEEDS_PASSWORD, validate_password, LayoutArgs, LayoutResult, MAX_ANNOT_PAGES, Outline, OutputPage, PageAnnots,
    PageEdits, PageInfo, PageText, Request, TextChars, Watermark, WatermarkScan,
};

const MAX_FILE_BYTES: u64 = crate::protocol::MAX_DOC_BYTES;

pub struct AppState {
    pub pool: Pool,
    grants: Mutex<HashSet<PathBuf>>,
    open_files: Mutex<OpenFiles>,
    /// Files named on a launch's command line, granted and waiting for the UI to take.
    launch: Mutex<Vec<PathBuf>>,
    recent: Mutex<Recent>,
    /// Files waiting for a password, by the id the UI was given.
    locked: Mutex<Locked>,
}

/// How many files may wait for a password at once (the oldest is dropped).
const MAX_LOCKED: usize = 64;

/// Files the user picked that turned out to need a password. Kept so the password can
/// be sent with an id: the UI still never names a path.
#[derive(Default)]
pub(crate) struct Locked {
    next: u32,
    files: Vec<(u32, PathBuf)>,
}

impl Locked {
    pub(crate) fn add(&mut self, path: PathBuf) -> u32 {
        self.next += 1;
        if self.files.len() == MAX_LOCKED {
            self.files.remove(0);
        }
        self.files.push((self.next, path));
        self.next
    }

    pub(crate) fn get(&self, id: u32) -> Option<PathBuf> {
        self.files.iter().find(|(i, _)| *i == id).map(|(_, p)| p.clone())
    }

    pub(crate) fn remove(&mut self, id: u32) {
        self.files.retain(|(i, _)| *i != id);
    }
}

/// The most files one launch (or one drop) may hand the app.
const MAX_OPEN_BATCH: usize = 500;

/// The files a launch names on its command line. Windows starts `novapdf.exe "<file>"`
/// when the user opens a PDF that the app is the default for, and a second launch
/// forwards its arguments to the running app. `args[0]` is the program; flags are
/// skipped; relative paths resolve against the launch's working directory.
pub(crate) fn launch_paths<S: AsRef<std::ffi::OsStr>>(args: &[S], cwd: &Path) -> Vec<PathBuf> {
    args.iter()
        .skip(1)
        .map(|a| Path::new(a.as_ref()))
        .filter(|p| !p.as_os_str().is_empty() && !p.to_string_lossy().starts_with('-'))
        .take(MAX_OPEN_BATCH)
        .map(|p| if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) })
        .collect()
}

/// Size and modification time: a file whose stamp changed is opened afresh.
pub(crate) type FileStamp = (u64, Option<SystemTime>);

struct OpenFile {
    stamp: FileStamp,
    doc_id: DocId,
    pages: Vec<PageInfo>,
}

/// Files that are open right now, by canonical path. Opening one again hands back
/// the same document (the UI switches to its tab) instead of a second copy in RAM.
#[derive(Default)]
pub(crate) struct OpenFiles(HashMap<PathBuf, OpenFile>);

impl OpenFiles {
    pub(crate) fn lookup(&self, path: &Path, stamp: FileStamp) -> Option<(DocId, Vec<PageInfo>)> {
        self.0
            .get(path)
            .filter(|f| f.stamp == stamp)
            .map(|f| (f.doc_id, f.pages.clone()))
    }

    pub(crate) fn remember(&mut self, path: PathBuf, stamp: FileStamp, doc_id: DocId, pages: Vec<PageInfo>) {
        self.0.insert(path, OpenFile { stamp, doc_id, pages });
    }

    pub(crate) fn forget(&mut self, doc_id: DocId) {
        self.0.retain(|_, f| f.doc_id != doc_id);
    }
}

/// The key and stamp a path is remembered by. `None` when it cannot be read, in
/// which case it is simply opened (and reports its own error).
fn identify(path: &Path) -> Option<(PathBuf, FileStamp)> {
    let key = std::fs::canonicalize(path).ok()?;
    let meta = std::fs::metadata(&key).ok()?;
    Some((key, (meta.len(), meta.modified().ok())))
}

impl AppState {
    /// `recent_file` is where the recent files list is stored; `None` keeps it in memory.
    pub fn new(pool: Pool, recent_file: Option<PathBuf>) -> Self {
        Self {
            pool,
            grants: Mutex::new(HashSet::new()),
            open_files: Mutex::new(OpenFiles::default()),
            launch: Mutex::new(Vec::new()),
            recent: Mutex::new(Recent::load(recent_file)),
            locked: Mutex::new(Locked::default()),
        }
    }

    // ---------- recent files ----------

    fn recent_view(&self) -> RecentView {
        self.recent.lock().unwrap().view()
    }

    /// Applies a change to the list and stores it. A failed write is not an error for
    /// the caller: the list in memory is still right for this session.
    fn change_recent(&self, f: impl FnOnce(&mut Recent) -> bool) {
        let mut r = self.recent.lock().unwrap();
        if f(&mut r) {
            if let Err(e) = r.save() {
                eprintln!("{e}");
            }
        }
    }

    /// A file that opened: it goes to the top of the list.
    fn record_open(&self, key: PathBuf) {
        self.change_recent(|r| r.record(key, now_ms()));
    }

    /// The file behind a list entry, if it is still there. A file that was moved or
    /// deleted is taken off the list, and the outcome says so.
    fn recent_target(&self, id: u32) -> Result<PathBuf, OpenOutcome> {
        let found = self.recent.lock().unwrap().path_of(id);
        let Some(path) = found else {
            return Err(OpenOutcome::failed("?".into(), "This file is no longer in the recent list."));
        };
        if std::fs::metadata(&path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
            self.change_recent(|r| r.remove(id));
            return Err(OpenOutcome::failed(
                file_name_of(&path),
                "This file was moved or deleted, so it was taken off the recent list.",
            ));
        }
        Ok(path)
    }

    /// Grants files named on a launch's command line and queues them for the UI.
    /// The queue, not an event, carries them: at startup the UI is not listening yet.
    /// Returns whether anything was queued.
    pub fn queue_launch(&self, paths: Vec<PathBuf>) -> bool {
        if paths.is_empty() {
            return false;
        }
        self.grant(&paths);
        self.launch.lock().unwrap().extend(paths);
        true
    }

    /// Hands the queued launch files to the UI, once.
    fn take_launch(&self) -> Vec<String> {
        std::mem::take(&mut *self.launch.lock().unwrap())
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect()
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
    /// Opened with a password: a save keeps it.
    protected: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenOutcome {
    file_name: String,
    document: Option<OpenedDocument>,
    error: Option<String>,
    /// The file needs a password: send it with this id (`unlock_file`). With `error`
    /// set as well, the password just tried was wrong.
    #[serde(skip_serializing_if = "Option::is_none")]
    locked: Option<u32>,
}

impl OpenOutcome {
    fn failed(file_name: String, error: impl Into<String>) -> Self {
        OpenOutcome { file_name, document: None, error: Some(error.into()), locked: None }
    }
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
    open_file(state, path, None).await
}

/// Opens a file, with the password for it when `unlock` names the waiting entry.
async fn open_file(state: &AppState, path: PathBuf, unlock: Option<(u32, String)>) -> OpenOutcome {
    let file_name = file_name_of(&path);
    let opened = |doc_id: DocId, pages: Vec<PageInfo>| OpenOutcome {
        document: Some(OpenedDocument {
            doc_id,
            file_name: file_name.clone(),
            pages,
            protected: state.pool.password_of(doc_id).is_some(),
        }),
        file_name: file_name.clone(),
        error: None,
        locked: None,
    };
    let id_path = path.clone();
    let identity = tokio::task::spawn_blocking(move || identify(&id_path)).await.ok().flatten();
    if let Some((key, stamp)) = &identity {
        let open = state.open_files.lock().unwrap().lookup(key, *stamp);
        if let Some((doc_id, pages)) = open {
            // Already open this session (unlocked then, if it needed a password).
            state.record_open(key.clone());
            if let Some((id, _)) = &unlock {
                state.locked.lock().unwrap().remove(*id);
            }
            return opened(doc_id, pages);
        }
    }
    let read_path = path.clone();
    let read = tokio::task::spawn_blocking(move || read_pdf(&read_path))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
    let password = unlock.as_ref().map(|(_, p)| p.clone());
    let result = match read {
        Ok(bytes) => state.pool.open(bytes, password).await,
        Err(e) => Err(e),
    };
    match result {
        Ok((doc_id, pages)) => {
            if let Some((key, stamp)) = identity {
                state.open_files.lock().unwrap().remember(key.clone(), stamp, doc_id, pages.clone());
                state.record_open(key);
            }
            if let Some((id, _)) = &unlock {
                state.locked.lock().unwrap().remove(*id);
            }
            opened(doc_id, pages)
        }
        // Needs a password: hold the file and hand the UI an id to send it with. A
        // wrong password keeps the same id, so the user can try again.
        Err(e) if e == NEEDS_PASSWORD => match unlock {
            Some((id, _)) => OpenOutcome {
                file_name,
                document: None,
                error: Some("Wrong password. Try again.".into()),
                locked: Some(id),
            },
            None => {
                let id = state.locked.lock().unwrap().add(path);
                OpenOutcome { file_name, document: None, error: None, locked: Some(id) }
            }
        },
        Err(e) => {
            if let Some((id, _)) = &unlock {
                state.locked.lock().unwrap().remove(*id);
            }
            OpenOutcome::failed(file_name, e)
        }
    }
}

/// Opens a file that needs a password, named by the id `open_*` gave for it.
#[tauri::command]
pub async fn unlock_file(state: State<'_, AppState>, locked_id: u32, password: String) -> Result<OpenOutcome, String> {
    let Some(path) = state.locked.lock().unwrap().get(locked_id) else {
        return Ok(OpenOutcome::failed("?".into(), "This file is no longer waiting for a password. Open it again."));
    };
    if let Err(e) = validate_password(&password) {
        return Ok(OpenOutcome { file_name: file_name_of(&path), document: None, error: Some(e), locked: Some(locked_id) });
    }
    Ok(open_file(&state, path, Some((locked_id, password))).await)
}

/// The user chose not to enter a password: forget the waiting file.
#[tauri::command]
pub fn discard_locked(state: State<'_, AppState>, locked_id: u32) {
    state.locked.lock().unwrap().remove(locked_id);
}

#[tauri::command]
pub async fn open_with_dialog(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<OpenOutcome>, String> {
    // Debug builds only: NOVAPDF_DEV_PICK names a text file listing the paths to
    // "pick" (one per line), read at each call, instead of showing the native
    // dialog, for the scripted E2E tests (e2e/). Compiled out of release builds.
    #[cfg(debug_assertions)]
    if let Some(list) = std::env::var_os("NOVAPDF_DEV_PICK").filter(|v| !v.is_empty()) {
        let text = std::fs::read_to_string(list).unwrap_or_default();
        let mut out = Vec::new();
        for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
            out.push(open_path(&state, PathBuf::from(line)).await);
        }
        return Ok(out);
    }

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
            Err(e) => out.push(OpenOutcome::failed("?".into(), e.to_string())),
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
    for p in paths.into_iter().take(MAX_OPEN_BATCH) {
        let path = PathBuf::from(&p);
        if !state.take_grant(&path) {
            out.push(OpenOutcome::failed(file_name_of(&path), "This file was not dropped onto the window."));
            continue;
        }
        let is_pdf = path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("pdf"));
        if !is_pdf {
            out.push(OpenOutcome::failed(file_name_of(&path), "Only PDF files can be opened."));
            continue;
        }
        out.push(open_path(&state, path).await);
    }
    Ok(out)
}

/// Files the app was launched with (by the OS, e.g. a double-clicked PDF), already
/// granted. The UI then opens them through `open_dropped`, like a drop.
#[tauri::command]
pub fn take_launch_files(state: State<'_, AppState>) -> Vec<String> {
    state.take_launch()
}

/// The recent files list: names to show and ids to open them by.
#[tauri::command]
pub fn list_recent(state: State<'_, AppState>) -> RecentView {
    state.recent_view()
}

/// Opens a file from the recent list. The UI names it only by its id.
#[tauri::command]
pub async fn open_recent(state: State<'_, AppState>, id: u32) -> Result<OpenOutcome, String> {
    Ok(match state.recent_target(id) {
        Ok(path) => open_path(&state, path).await,
        Err(outcome) => outcome,
    })
}

#[tauri::command]
pub fn remove_recent(state: State<'_, AppState>, id: u32) -> RecentView {
    state.change_recent(|r| r.remove(id));
    state.recent_view()
}

#[tauri::command]
pub fn clear_recent(state: State<'_, AppState>) -> RecentView {
    state.change_recent(|r| {
        r.clear();
        true
    });
    state.recent_view()
}

/// Off also forgets the list.
#[tauri::command]
pub fn set_recent_enabled(state: State<'_, AppState>, enabled: bool) -> RecentView {
    state.change_recent(|r| {
        r.set_enabled(enabled);
        true
    });
    state.recent_view()
}

#[tauri::command]
pub async fn close_document(state: State<'_, AppState>, doc_id: DocId) -> Result<(), String> {
    state.open_files.lock().unwrap().forget(doc_id);
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

/// Checks a page range for `list_annotations`.
pub fn annotation_range(first: i32, count: i32) -> Result<(), String> {
    if first < 0 || !(1..=MAX_ANNOT_PAGES).contains(&count) {
        return Err("Page range is invalid.".into());
    }
    Ok(())
}

/// Comments already in the file, for a range of pages. `background` sends the request
/// to a thumbnail worker, so a whole-document scan never blocks viewing or editing.
#[tauri::command]
pub async fn list_annotations(
    state: State<'_, AppState>,
    doc_id: DocId,
    first: i32,
    count: i32,
    background: bool,
) -> Result<Vec<PageAnnots>, String> {
    annotation_range(first, count)?;
    let lane = if background { Lane::Background } else { Lane::Interactive };
    let (v, _) = state
        .pool
        .call(lane, Request::Annotations { doc_id, first, count }, EXTRACT_TIMEOUT)
        .await?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

/// Characters of a page with their boxes, for text selection and highlights.
#[tauri::command]
pub async fn text_chars(state: State<'_, AppState>, doc_id: DocId, page_index: i32) -> Result<TextChars, String> {
    let (v, _) = state
        .pool
        .call(Lane::Interactive, Request::TextChars { doc_id, page_index }, EXTRACT_TIMEOUT)
        .await?;
    check_text_chars(serde_json::from_value(v).map_err(|e| e.to_string())?)
}

/// Worker output is untrusted: one box of four numbers per character, all finite.
pub fn check_text_chars(chars: TextChars) -> Result<TextChars, String> {
    if chars.boxes.len() != chars.codes.len() * 4 || chars.boxes.iter().any(|v| !v.is_finite()) {
        return Err("The PDF engine returned invalid text.".into());
    }
    Ok(chars)
}

/// The document's outline (bookmarks). Read on a thumbnail worker, so a long outline
/// never queues in front of viewing or editing.
#[tauri::command]
pub async fn get_outline(state: State<'_, AppState>, doc_id: DocId) -> Result<Outline, String> {
    let (v, _) = state
        .pool
        .call(Lane::Background, Request::Outline { doc_id }, EXTRACT_TIMEOUT)
        .await?;
    check_outline(v)
}

/// Worker output is untrusted: decode it, then check its bounds.
pub fn check_outline(v: serde_json::Value) -> Result<Outline, String> {
    let outline: Outline = serde_json::from_value(v).map_err(|e| e.to_string())?;
    outline.validate()?;
    Ok(outline)
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
    /// The saved file needs a password to open.
    protected: bool,
}

/// How a save is encrypted: with the password of the first page (in page order) that
/// comes from a password-protected file, if any. Pages from files with different
/// passwords get a warning, since the saved file can have only one.
pub(crate) fn save_encryption(
    pages: &[OutputPage],
    password_of: impl Fn(DocId) -> Option<String>,
    key: impl FnOnce() -> Result<Vec<u8>, String>,
) -> Result<(Option<Encrypt>, Option<String>), String> {
    let mut seen: Vec<DocId> = Vec::new();
    let mut passwords: Vec<String> = Vec::new();
    for p in pages {
        if seen.contains(&p.doc_id) {
            continue;
        }
        seen.push(p.doc_id);
        if let Some(pw) = password_of(p.doc_id)
            && !passwords.contains(&pw)
        {
            passwords.push(pw);
        }
    }
    let Some(first) = passwords.first().cloned() else {
        return Ok((None, None));
    };
    let warning = (passwords.len() > 1).then(|| {
        "These pages come from files with different passwords. The saved file opens with the password of the first of them in the page order.".to_string()
    });
    Ok((Some(Encrypt { password: first, key: key()? }), warning))
}

/// 32 random bytes from the OS.
fn random_key() -> Result<Vec<u8>, String> {
    let mut key = vec![0u8; 32];
    getrandom::fill(&mut key).map_err(|e| format!("Could not make an encryption key: {e}"))?;
    Ok(key)
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

    let (encrypt, mixed) = save_encryption(&args.pages, |id| state.pool.password_of(id), random_key)?;
    let protected = encrypt.is_some();
    let req = Request::Save { pages: args.pages, watermark: args.watermark, sanitize: args.sanitize, encrypt };
    let (meta, bytes) = state.pool.call(Lane::Interactive, req, SAVE_TIMEOUT).await?;
    // Worker output is untrusted: keep only short plain strings.
    let mut warnings: Vec<String> = meta
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
    warnings.extend(mixed);
    Ok(Some(SaveOutcome { path: target.to_string_lossy().into_owned(), warnings, protected }))
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
