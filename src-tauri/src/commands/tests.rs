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
    assert_eq!(file_name_of(Path::new("C:\\docs\\Report 2024.pdf")), "Report 2024.pdf");
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
