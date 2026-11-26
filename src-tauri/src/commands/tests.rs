//! Unit tests for `commands.rs`. Kept in their own file so coverage reports can exclude test code.

use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicU32, Ordering};

/// A fresh, empty directory under the system temp dir, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let dir = std::env::temp_dir().join(format!(
            "novapdf-test-{}-{nanos}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
    fn entries(&self) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(&self.0)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// ---------- safe_file_name ----------

#[test]
fn safe_file_name_strips_path_and_reserved_characters() {
    assert_eq!(safe_file_name("report.pdf"), "report.pdf");
    assert_eq!(safe_file_name(r#"a/b\c:d*e?f"g<h>i|j.pdf"#), "abcdefghij.pdf");
    assert_eq!(safe_file_name("..\\..\\Windows\\evil.pdf"), "Windowsevil.pdf");
    assert_eq!(safe_file_name("tab\there\u{0}nul\u{7}bell\n.pdf"), "tabherenulbell.pdf");
    assert_eq!(safe_file_name("Tài liệu.pdf"), "Tài liệu.pdf");
}

#[test]
fn safe_file_name_trims_and_drops_leading_dots() {
    assert_eq!(safe_file_name("  spaced.pdf  "), "spaced.pdf");
    assert_eq!(safe_file_name(".hidden.pdf"), "hidden.pdf");
    assert_eq!(safe_file_name("...pdf"), "pdf");
    assert_eq!(safe_file_name(" ./x.pdf"), "x.pdf");
}

#[test]
fn safe_file_name_falls_back_when_empty() {
    for name in ["", "   ", "...", "///", "\u{1}\u{2}", " . "] {
        assert_eq!(safe_file_name(name), "document.pdf", "{name:?}");
    }
}

#[test]
fn safe_file_name_limits_length_in_characters() {
    let out = safe_file_name(&"é".repeat(400));
    assert_eq!(out.chars().count(), 150);
    // Removed characters do not count towards the limit.
    let out = safe_file_name(&format!("{}{}", "/".repeat(200), "a".repeat(10)));
    assert_eq!(out, "a".repeat(10));
}

// ---------- file_name_of ----------

#[test]
fn file_name_of_returns_last_component() {
    // Backslash is a separator only on Windows; elsewhere it is part of a file name.
    #[cfg(windows)]
    assert_eq!(file_name_of(Path::new("C:\\docs\\Report 2024.pdf")), "Report 2024.pdf");
    #[cfg(not(windows))]
    assert_eq!(file_name_of(Path::new("/docs/a\\b.pdf")), "a\\b.pdf");
    assert_eq!(file_name_of(Path::new("/tmp/a/b.PDF")), "b.PDF");
    assert_eq!(file_name_of(Path::new("plain")), "plain");
}

#[test]
fn file_name_of_falls_back_without_a_name() {
    assert_eq!(file_name_of(Path::new("")), "document.pdf");
    assert_eq!(file_name_of(Path::new("/")), "document.pdf");
    assert_eq!(file_name_of(Path::new("some/dir/..")), "document.pdf");
}

// ---------- read_pdf ----------

#[test]
fn read_pdf_accepts_a_pdf_header() {
    let dir = TempDir::new();
    let p = dir.path("ok.pdf");
    std::fs::write(&p, b"%PDF-1.7\nrest").unwrap();
    assert_eq!(read_pdf(&p).unwrap(), b"%PDF-1.7\nrest");
}

#[test]
fn read_pdf_finds_header_within_first_1024_bytes() {
    let dir = TempDir::new();
    // Junk before the header is allowed as long as the header ends by byte 1024.
    let mut bytes = vec![b' '; 1019];
    bytes.extend_from_slice(b"%PDF-1.4 tail");
    let p = dir.path("late.pdf");
    std::fs::write(&p, &bytes).unwrap();
    assert!(read_pdf(&p).is_ok());

    let mut bytes = vec![b' '; 1020];
    bytes.extend_from_slice(b"%PDF-1.4 tail");
    let p = dir.path("too-late.pdf");
    std::fs::write(&p, &bytes).unwrap();
    assert_eq!(read_pdf(&p).unwrap_err(), "This file is not a PDF.");
}

#[test]
fn read_pdf_rejects_non_pdfs() {
    let dir = TempDir::new();
    for (name, bytes) in [
        ("empty.pdf", &b""[..]),
        ("png.pdf", &b"\x89PNG\r\n\x1a\n"[..]),
        ("short.pdf", &b"%PDF"[..]),
        ("lower.pdf", &b"%pdf-1.7"[..]),
    ] {
        let p = dir.path(name);
        std::fs::write(&p, bytes).unwrap();
        assert_eq!(read_pdf(&p).unwrap_err(), "This file is not a PDF.", "{name}");
    }
}

#[test]
fn read_pdf_rejects_directories_and_missing_files() {
    let dir = TempDir::new();
    let sub = dir.path("folder.pdf");
    std::fs::create_dir(&sub).unwrap();
    assert_eq!(read_pdf(&sub).unwrap_err(), "Not a regular file.");
    let err = read_pdf(&dir.path("missing.pdf")).unwrap_err();
    assert!(err.starts_with("Could not read the file:"), "{err}");
}

#[test]
fn read_pdf_rejects_files_over_the_size_limit_before_reading() {
    let dir = TempDir::new();
    let p = dir.path("huge.pdf");
    let f = std::fs::File::create(&p).unwrap();
    // Extending the length does not write data, so this is fast.
    f.set_len(MAX_FILE_BYTES + 1).unwrap();
    drop(f);
    assert_eq!(read_pdf(&p).unwrap_err(), "Files larger than 512 MB are not supported.");
}

// ---------- write_atomically ----------

#[test]
fn write_atomically_writes_and_overwrites_without_leftovers() {
    let dir = TempDir::new();
    let target = dir.path("out.pdf");
    write_atomically(&target, b"%PDF-first").unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"%PDF-first");
    write_atomically(&target, b"%PDF-second, longer").unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"%PDF-second, longer");
    assert_eq!(dir.entries(), ["out.pdf"]);
}

#[test]
fn write_atomically_cleans_up_on_failure() {
    let dir = TempDir::new();
    // The target is a non-empty directory: the final rename fails.
    let target = dir.path("taken.pdf");
    std::fs::create_dir(&target).unwrap();
    std::fs::write(target.join("keep"), b"x").unwrap();
    let err = write_atomically(&target, b"%PDF-data").unwrap_err();
    assert!(err.starts_with("Could not save "), "{err}");
    assert_eq!(dir.entries(), ["taken.pdf"], "temporary file left behind");

    // The folder does not exist: creating the temporary file fails.
    let err = write_atomically(&dir.path("missing").join("x.pdf"), b"%PDF-").unwrap_err();
    assert!(err.starts_with("Could not save "), "{err}");
}

#[test]
fn write_atomically_rejects_a_path_without_parent() {
    assert_eq!(write_atomically(Path::new(""), b"x").unwrap_err(), "Invalid save location");
}

// ---------- AppState grants ----------

#[test]
fn grants_are_one_time() {
    let state = AppState::new(Pool::new(None).unwrap());
    let a = PathBuf::from("C:\\drop\\a.pdf");
    let b = PathBuf::from("C:\\drop\\b.pdf");
    assert!(!state.take_grant(&a), "nothing granted yet");
    state.grant(&[a.clone(), b.clone(), a.clone()]);
    assert!(state.take_grant(&a));
    assert!(!state.take_grant(&a), "a grant can be used once");
    assert!(!state.take_grant(Path::new("C:\\drop\\c.pdf")));
    assert!(state.take_grant(&b));
    // Granting again (a second drop) re-enables it.
    state.grant(std::slice::from_ref(&a));
    assert!(state.take_grant(&a));
}

// ---------- launch command line ----------

#[test]
fn launch_paths_skip_the_program_and_flags_and_resolve_relative_paths() {
    let cwd = std::env::temp_dir();
    let abs = cwd.join("abs.pdf");
    let args = [
        "C:\\Program Files\\NovaPDF\\novapdf.exe".to_string(),
        abs.to_string_lossy().into_owned(),
        "--flag".into(),
        String::new(),
        "rel.pdf".into(),
    ];
    assert_eq!(launch_paths(&args, &cwd), vec![abs, cwd.join("rel.pdf")]);
    assert!(launch_paths(&args[..1], &cwd).is_empty(), "a plain launch names no files");
    assert!(launch_paths::<String>(&[], &cwd).is_empty());
}

#[test]
fn launch_paths_are_capped() {
    let cwd = std::env::temp_dir();
    let args: Vec<String> = std::iter::once("app.exe".to_string())
        .chain((0..MAX_OPEN_BATCH + 10).map(|i| format!("{i}.pdf")))
        .collect();
    assert_eq!(launch_paths(&args, &cwd).len(), MAX_OPEN_BATCH);
}

#[test]
fn launch_files_are_granted_and_taken_once() {
    let state = AppState::new(Pool::new(None).unwrap());
    assert!(!state.queue_launch(Vec::new()), "nothing to queue");
    assert!(state.take_launch().is_empty());

    let a = PathBuf::from("C:\\docs\\a.pdf");
    let b = PathBuf::from("C:\\docs\\b.pdf");
    assert!(state.queue_launch(vec![a.clone()]));
    assert!(state.queue_launch(vec![b.clone()]), "a second launch adds to the queue");
    let taken = state.take_launch();
    assert_eq!(taken, vec![a.to_string_lossy(), b.to_string_lossy()]);
    assert!(state.take_launch().is_empty(), "taken once");
    // The UI opens them through open_dropped, which needs the grant.
    assert!(state.take_grant(&a));
    assert!(state.take_grant(&b));
}

// ---------- argument / result JSON (must match src/lib/api.ts) ----------

#[test]
fn render_args_parse_as_the_ui_sends_them() {
    let args: RenderArgs = serde_json::from_value(json!({
        "docId": 3, "pageIndex": 1, "width": 900, "format": "jpeg", "rotation": 90,
        "edits": null, "watermark": null, "priority": "thumb"
    }))
    .unwrap();
    assert_eq!((args.doc_id, args.page_index, args.width, args.rotation), (3, 1, 900, 90));
    assert!(matches!(args.format, ImageFormat::Jpeg));
    assert!(matches!(args.priority, Priority::Thumb));
    assert!(args.edits.is_none() && args.watermark.is_none());

    let args: RenderArgs = serde_json::from_value(json!({
        "docId": 1, "pageIndex": 0, "width": 100, "format": "png", "priority": "view"
    }))
    .unwrap();
    assert_eq!(args.rotation, 0);
    assert!(matches!(args.priority, Priority::View));
    assert!(serde_json::from_value::<RenderArgs>(json!({
        "docId": 1, "pageIndex": 0, "width": 100, "format": "png", "priority": "urgent"
    }))
    .is_err());
}

#[test]
fn save_args_defaults() {
    let args: SaveArgs = serde_json::from_value(json!({
        "pages": [{"docId": 1, "pageIndex": 0, "rotation": 0, "edits": null}],
        "watermark": null, "sanitize": false, "suggestedName": "Report.pdf"
    }))
    .unwrap();
    assert!(!args.sanitize);
    assert_eq!(args.suggested_name, "Report.pdf");
    assert_eq!(args.pages.len(), 1);
    // Sanitizing is on unless the UI explicitly turns it off.
    let args: SaveArgs = serde_json::from_value(json!({"pages": []})).unwrap();
    assert!(args.sanitize);
    assert_eq!(args.suggested_name, "");
    assert!(args.watermark.is_none());
}

#[test]
fn outcomes_serialize_as_the_ui_expects() {
    let ok = OpenOutcome {
        file_name: "a.pdf".into(),
        document: Some(OpenedDocument {
            doc_id: 4,
            file_name: "a.pdf".into(),
            pages: vec![PageInfo { width: 612.0, height: 792.0 }],
        }),
        error: None,
    };
    assert_eq!(
        serde_json::to_value(&ok).unwrap(),
        json!({"fileName": "a.pdf", "error": null,
               "document": {"docId": 4, "fileName": "a.pdf", "pages": [{"width": 612.0, "height": 792.0}]}})
    );
    let err = OpenOutcome { file_name: "b.pdf".into(), document: None, error: Some("nope".into()) };
    assert_eq!(
        serde_json::to_value(&err).unwrap(),
        json!({"fileName": "b.pdf", "document": null, "error": "nope"})
    );
    let saved = SaveOutcome { path: "C:\\x.pdf".into(), warnings: vec!["w".into()] };
    assert_eq!(serde_json::to_value(&saved).unwrap(), json!({"path": "C:\\x.pdf", "warnings": ["w"]}));
}

// ---------- open-file de-duplication ----------

fn letter() -> Vec<PageInfo> {
    serde_json::from_value(json!([{ "width": 612.0, "height": 792.0 }])).unwrap()
}

#[test]
fn open_files_hand_back_the_same_document_while_unchanged() {
    let mut files = OpenFiles::default();
    let path = PathBuf::from("C:/docs/a.pdf");
    let stamp: FileStamp = (100, None);
    assert!(files.lookup(&path, stamp).is_none());
    files.remember(path.clone(), stamp, 7, letter());
    let (doc_id, pages) = files.lookup(&path, stamp).unwrap();
    assert_eq!(doc_id, 7);
    assert_eq!(pages.len(), 1);
    // Changed on disk (another size or time): opened afresh.
    assert!(files.lookup(&path, (101, None)).is_none());
    assert!(files.lookup(&PathBuf::from("C:/docs/b.pdf"), stamp).is_none());
}

#[test]
fn open_files_forget_a_closed_document() {
    let mut files = OpenFiles::default();
    files.remember(PathBuf::from("a.pdf"), (1, None), 1, letter());
    files.remember(PathBuf::from("b.pdf"), (1, None), 2, letter());
    files.forget(1);
    assert!(files.lookup(&PathBuf::from("a.pdf"), (1, None)).is_none());
    assert!(files.lookup(&PathBuf::from("b.pdf"), (1, None)).is_some());
}

#[test]
fn identify_uses_the_canonical_path_and_tracks_changes() {
    let dir = TempDir::new();
    let path = dir.path("x.pdf");
    std::fs::write(&path, b"%PDF-1.7").unwrap();
    let (key, stamp) = identify(&path).unwrap();
    // The same file through a different spelling of its path has the same key.
    let (again, _) = identify(&dir.0.join(".").join("x.pdf")).unwrap();
    assert_eq!(key, again);
    std::fs::write(&path, b"%PDF-1.7 longer").unwrap();
    assert_ne!(identify(&path).unwrap().1, stamp);
    assert!(identify(&dir.path("missing.pdf")).is_none());
}

#[test]
fn annotation_range_is_bounded() {
    assert!(annotation_range(0, 1).is_ok());
    assert!(annotation_range(10, crate::protocol::MAX_ANNOT_PAGES).is_ok());
    assert!(annotation_range(-1, 1).is_err());
    assert!(annotation_range(0, 0).is_err());
    assert!(annotation_range(0, crate::protocol::MAX_ANNOT_PAGES + 1).is_err());
}

#[test]
fn text_chars_from_the_worker_are_checked() {
    use crate::protocol::TextChars;
    let ok = TextChars { codes: vec![65], boxes: vec![1.0, 2.0, 3.0, 4.0] };
    assert!(check_text_chars(ok).is_ok());
    assert!(check_text_chars(TextChars { codes: vec![65], boxes: vec![1.0] }).is_err());
    assert!(check_text_chars(TextChars { codes: vec![65], boxes: vec![f32::NAN, 0.0, 0.0, 0.0] }).is_err());
}
