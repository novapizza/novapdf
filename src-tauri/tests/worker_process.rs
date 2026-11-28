//! Drives the real sandboxed worker process (`novapdf --pdf-worker`) over its
//! stdin/stdout frame protocol, as the host does. Each test binary is its own
//! process and PDFium loads only in the child, so this does not clash with the
//! single in-process PDFium test in `pipeline.rs`.

use std::io::{BufReader, BufWriter, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use novapdf_lib::protocol::{read_frame, write_frame};
use serde_json::{Value, json};

struct Worker {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    stdout: BufReader<ChildStdout>,
}

impl Worker {
    fn start() -> Self {
        let pdfium = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
        let mut child = Command::new(env!("CARGO_BIN_EXE_novapdf"))
            .arg(novapdf_lib::worker::WORKER_FLAG)
            .arg("--pdfium")
            .arg(&pdfium)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("start worker");
        let stdin = BufWriter::new(child.stdin.take().unwrap());
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Worker { child, stdin, stdout }
    }

    fn raw(&mut self, header: &[u8], payload: &[u8]) -> (Value, Vec<u8>) {
        write_frame(&mut self.stdin, header, payload).unwrap();
        self.stdin.flush().unwrap();
        let (h, p) = read_frame(&mut self.stdout).expect("worker replied");
        (serde_json::from_slice(&h).expect("response header is JSON"), p)
    }

    fn call(&mut self, req: Value, payload: &[u8]) -> (Value, Vec<u8>) {
        self.raw(&serde_json::to_vec(&req).unwrap(), payload)
    }

    fn ok(&mut self, req: Value, payload: &[u8]) -> (Value, Vec<u8>) {
        let (resp, bytes) = self.call(req.clone(), payload);
        assert_eq!(resp["status"], "ok", "{req} -> {resp}");
        (resp["result"].clone(), bytes)
    }

    fn err(&mut self, req: Value, payload: &[u8]) -> String {
        let (resp, bytes) = self.call(req.clone(), payload);
        assert_eq!(resp["status"], "err", "{req} -> {resp}");
        assert!(bytes.is_empty());
        resp["message"].as_str().unwrap().to_string()
    }
}

/// A one-page Letter PDF with two lines of Helvetica text.
fn sample_pdf() -> Vec<u8> {
    let content = "BT /F1 12 Tf 1 0 0 1 72 700 Tm (Hello worker) Tj 0 -40 Td (Second line) Tj ET";
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".to_string(),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
        format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len() + 1),
    ];
    let mut pdf = b"%PDF-1.7\n".to_vec();
    let mut offsets = Vec::new();
    for (i, o) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend(format!("{} 0 obj\n{o}\nendobj\n", i + 1).into_bytes());
    }
    let xref = pdf.len();
    pdf.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).into_bytes());
    for off in offsets {
        pdf.extend(format!("{off:010} 00000 n \n").into_bytes());
    }
    pdf.extend(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).into_bytes());
    pdf
}

/// A PDF whose pages each hold the given annotation dictionaries (inline in `/Annots`).
fn pdf_with_annots(pages: &[Vec<String>]) -> Vec<u8> {
    let kids: Vec<String> = (0..pages.len()).map(|i| format!("{} 0 R", i + 3)).collect();
    let mut objects = vec![
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        format!("<< /Type /Pages /Kids [{}] /Count {} >>", kids.join(" "), pages.len()),
    ];
    for annots in pages {
        objects.push(format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [{}] >>", annots.join(" ")));
    }
    let mut pdf = b"%PDF-1.7\n".to_vec();
    let mut offsets = Vec::new();
    for (i, o) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend(format!("{} 0 obj\n{o}\nendobj\n", i + 1).into_bytes());
    }
    let xref = pdf.len();
    pdf.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).into_bytes());
    for off in offsets {
        pdf.extend(format!("{off:010} 00000 n \n").into_bytes());
    }
    pdf.extend(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).into_bytes());
    pdf
}

/// A hostile file cannot make the comment list huge: comments per page, text per
/// comment, text per page and text per request are all capped.
#[test]
fn comment_listing_is_capped_on_a_hostile_file() {
    let note = |text: &str| format!("<< /Type /Annot /Subtype /Text /Rect [10 10 30 30] /Contents ({text}) >>");
    let big = "x".repeat(20_000);
    // Page 1: 600 notes, the first with 30 000 characters of text.
    let mut many = vec![note(&"y".repeat(30_000))];
    many.extend((1..600).map(|_| note("")));
    // Pages 2–4: 300 notes of 20 000 characters each (6 MB of text per page).
    let heavy: Vec<String> = (0..300).map(|_| note(&big)).collect();
    let pdf = pdf_with_annots(&[many, heavy.clone(), heavy.clone(), heavy]);

    let mut w = Worker::start();
    w.ok(json!({"op": "open", "docId": 1}), &pdf);
    let (list, _) = w.ok(json!({"op": "annotations", "docId": 1, "first": 0, "count": 4}), &[]);
    let pages = list.as_array().unwrap();

    let first = &pages[0];
    assert_eq!(first["annots"].as_array().unwrap().len(), 500, "at most 500 listed per page");
    assert_eq!(first["more"], 100, "the rest are counted, not listed");
    let long = &first["annots"][0];
    assert_eq!(long["contents"].as_str().unwrap().chars().count(), 20_000);
    assert_eq!(long["truncated"], true);

    // 4 MB of text per page: 210 of the 300 heavy notes fit, the other 90 are counted.
    let second = &pages[1];
    assert_eq!(second["annots"].as_array().unwrap().len(), 210);
    assert_eq!(second["more"], 90);
    // 8 MB per request: the list stops after page 3; the caller asks again for page 4.
    assert_eq!(pages.len(), 3, "stops early at the request budget");
    let (rest, _) = w.ok(json!({"op": "annotations", "docId": 1, "first": 3, "count": 1}), &[]);
    assert_eq!(rest[0]["pageIndex"], 3);
}

/// A one-page PDF whose outline root is object 4 and whose bookmark dictionaries
/// follow as objects 5, 6, …
fn pdf_with_outline(bookmarks: &[String]) -> Vec<u8> {
    let mut objects = vec![
        "<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>".to_string(),
        "<< /Type /Outlines /First 5 0 R >>".to_string(),
    ];
    objects.extend(bookmarks.iter().cloned());
    let mut pdf = b"%PDF-1.7\n".to_vec();
    let mut offsets = Vec::new();
    for (i, o) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend(format!("{} 0 obj\n{o}\nendobj\n", i + 1).into_bytes());
    }
    let xref = pdf.len();
    pdf.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).into_bytes());
    for off in offsets {
        pdf.extend(format!("{off:010} 00000 n \n").into_bytes());
    }
    pdf.extend(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).into_bytes());
    pdf
}

/// A hostile outline cannot make the walk run away: depth, entry count and loops are
/// all bounded, and the reply says entries were left out.
#[test]
fn outline_is_bounded_on_a_hostile_file() {
    let mut w = Worker::start();
    let depth = |items: &Value| -> Vec<u64> {
        items.as_array().unwrap().iter().map(|i| i["depth"].as_u64().unwrap()).collect()
    };

    // A chain of 40 nested entries: levels past 32 are left out.
    let nested: Vec<String> = (0..40)
        .map(|i| format!("<< /Title (L{i}) /Dest [3 0 R /Fit] /First {} 0 R /Count 1 >>", i + 6))
        .collect();
    w.ok(json!({"op": "open", "docId": 1}), &pdf_with_outline(&nested));
    let (o, _) = w.ok(json!({"op": "outline", "docId": 1}), &[]);
    assert_eq!(depth(&o["items"]), (0..=32).collect::<Vec<u64>>());
    assert_eq!(o["truncated"], true);
    assert_eq!(o["items"][0], json!({"title": "L0", "depth": 0, "pageIndex": 0, "y": null, "open": true}));

    // 10 050 siblings: at most 10 000 are listed.
    let wide: Vec<String> = (0..10_050).map(|i| format!("<< /Title (S{i}) /Next {} 0 R >>", i + 6)).collect();
    w.ok(json!({"op": "open", "docId": 2}), &pdf_with_outline(&wide));
    let (o, _) = w.ok(json!({"op": "outline", "docId": 2}), &[]);
    assert_eq!(o["items"].as_array().unwrap().len(), 10_000);
    assert_eq!(o["items"][9_999]["title"], "S9999");
    assert_eq!(o["truncated"], true);

    // An entry that is its own child and its own next sibling.
    let looped = vec!["<< /Title (Me) /First 5 0 R /Next 5 0 R /Count 1 >>".to_string()];
    w.ok(json!({"op": "open", "docId": 3}), &pdf_with_outline(&looped));
    let (o, _) = w.ok(json!({"op": "outline", "docId": 3}), &[]);
    assert_eq!(o["items"].as_array().unwrap().len(), 1);

    // No outline at all, and a document that is not open.
    w.ok(json!({"op": "open", "docId": 4}), &sample_pdf());
    let (o, _) = w.ok(json!({"op": "outline", "docId": 4}), &[]);
    assert_eq!(o, json!({"items": [], "truncated": false}));
    assert_eq!(w.err(json!({"op": "outline", "docId": 99}), &[]), "Document is not open");
    let _ = w.child.kill();
}

fn helvetica() -> Value {
    json!({"family": "Helvetica", "bold": false, "italic": false})
}

#[test]
fn worker_speaks_the_frame_protocol() {
    let mut w = Worker::start();

    // Layout needs no document.
    let (r, _) = w.ok(
        json!({"op": "layout", "text": "one two three four five six", "font": helvetica(),
               "size": 12, "width": 60, "indent": 0, "hScale": 1}),
        &[],
    );
    let starts: Vec<u64> = r["lineStarts"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap()).collect();
    assert!(starts.len() >= 2 && starts[0] == 0, "{r}");
    assert!(starts.windows(2).all(|s| s[0] < s[1]));
    // Validation happens in the worker too, not only in the Tauri command.
    assert!(w.err(json!({"op": "layout", "text": "a\rb", "font": helvetica(), "size": 12, "width": null}), &[])
        .contains("not normalised"));

    // Open, then use the document.
    let (pages, _) = w.ok(json!({"op": "open", "docId": 1}), &sample_pdf());
    assert_eq!(pages, json!([{"width": 612.0, "height": 792.0}]));

    let (text, _) = w.ok(json!({"op": "extract", "docId": 1, "pageIndex": 0}), &[]);
    let paras: Vec<&str> = text["paragraphs"].as_array().unwrap().iter().map(|p| p["text"].as_str().unwrap()).collect();
    assert!(paras.contains(&"Hello worker"), "{paras:?}");
    assert!(paras.contains(&"Second line"), "{paras:?}");
    assert_eq!(text["width"], 612.0);

    let (r, png) = w.ok(
        json!({"op": "render", "docId": 1, "pageIndex": 0, "width": 200, "format": "png",
               "edits": null, "watermark": null}),
        &[],
    );
    assert!(r.is_null());
    assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));

    let (scan, _) = w.ok(json!({"op": "findWatermarks", "docId": 1, "text": null}), &[]);
    assert_eq!(scan, json!({"pages": [], "markedObjects": 0, "annotations": 0, "matchingText": 0}));

    // Comments: none in the file; a render with a new note draws it; text characters.
    let (list, _) = w.ok(json!({"op": "annotations", "docId": 1, "first": 0, "count": 5}), &[]);
    assert_eq!(list, json!([{"pageIndex": 0, "annots": [], "more": 0}]));
    assert!(!w.err(json!({"op": "annotations", "docId": 1, "first": 3, "count": 1}), &[]).is_empty());
    let note = json!({"id": "n1", "kind": "note", "x": 300, "y": 300, "color": [255, 200, 0],
                      "opacity": 1, "contents": "Hi", "author": "", "date": "D:20261126000000Z"});
    let edits = json!({"annotations": [note]});
    let (_, png) = w.ok(
        json!({"op": "render", "docId": 1, "pageIndex": 0, "width": 200, "format": "png",
               "edits": edits, "watermark": null}),
        &[],
    );
    assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
    let bad = json!({"annotations": [{"id": "n2", "kind": "note", "x": 0, "y": 0, "color": [0, 0, 0],
                                      "date": "yesterday"}]});
    assert!(w
        .err(json!({"op": "render", "docId": 1, "pageIndex": 0, "width": 200, "format": "png",
                    "edits": bad, "watermark": null}), &[])
        .contains("PDF date"));
    let (chars, _) = w.ok(json!({"op": "textChars", "docId": 1, "pageIndex": 0}), &[]);
    let codes: Vec<u16> = chars["codes"].as_array().unwrap().iter().map(|c| c.as_u64().unwrap() as u16).collect();
    assert!(String::from_utf16_lossy(&codes).starts_with("Hello worker"), "{chars}");
    assert_eq!(chars["boxes"].as_array().unwrap().len(), codes.len() * 4);

    let (r, saved) = w.ok(
        json!({"op": "save", "pages": [{"docId": 1, "pageIndex": 0, "rotation": 90}],
               "watermark": null, "sanitize": true}),
        &[],
    );
    assert!(saved.starts_with(b"%PDF-"));
    assert_eq!(r["warnings"], json!([]));

    // Errors are reported, and the worker keeps serving afterwards.
    assert_eq!(w.err(json!({"op": "extract", "docId": 99, "pageIndex": 0}), &[]), "Document is not open");
    assert!(!w.err(json!({"op": "extract", "docId": 1, "pageIndex": 7}), &[]).is_empty());
    assert!(!w.err(json!({"op": "open", "docId": 2}), b"not a pdf").is_empty());
    let (resp, _) = w.raw(b"{not json", &[]);
    assert_eq!(resp["status"], "err");
    assert!(resp["message"].as_str().unwrap().starts_with("Bad request"), "{resp}");
    assert!(w.err(json!({"op": "save", "pages": [], "watermark": null, "sanitize": false}), &[])
        .contains("no pages"));

    // Close drops the document.
    let (r, _) = w.ok(json!({"op": "close", "docId": 1}), &[]);
    assert!(r.is_null());
    assert_eq!(w.err(json!({"op": "extract", "docId": 1, "pageIndex": 0}), &[]), "Document is not open");

    // Closing stdin ends the worker cleanly.
    drop(w.stdin);
    let status = w.child.wait().unwrap();
    assert!(status.success(), "worker exit status {status:?}");
}

/// The worker reads installed fonts after it has sandboxed itself: text outside
/// WinAnsi needs a TrueType font from the system, embedded in the saved file. If the
/// sandbox blocked the font folders, the worker would fall back to a standard font
/// and there would be no embedded font program.
#[test]
fn sandboxed_worker_embeds_an_installed_font() {
    let mut w = Worker::start();
    w.ok(json!({"op": "open", "docId": 1}), &sample_pdf());
    let block = json!({
        "id": "b1", "x": 72, "baseline": 600, "width": null, "text": "Ωμέγα αβγ",
        "font": {"family": "Arial", "bold": false, "italic": false},
        "size": 14, "color": [0, 0, 0], "lineHeight": 1.2,
    });
    let (_, saved) = w.ok(
        json!({"op": "save", "pages": [{"docId": 1, "pageIndex": 0,
               "edits": {"blocks": [block]}}], "watermark": null, "sanitize": false}),
        &[],
    );
    assert!(saved.starts_with(b"%PDF-"));
    assert!(
        saved.windows(b"/FontFile2".len()).any(|win| win == b"/FontFile2"),
        "no embedded TrueType font: system fonts were not readable"
    );
    let _ = w.child.kill();
}

/// Windows: the host shares document bytes through a read-only section instead of
/// sending them, so the worker (already at Low integrity) maps them itself.
#[cfg(windows)]
#[test]
fn worker_opens_documents_from_shared_memory() {
    use std::os::windows::io::AsRawHandle;

    use novapdf_lib::shared::win::Section;

    let mut w = Worker::start();
    let pdf = sample_pdf();
    let section = Section::new(&pdf).unwrap();
    let process = w.child.as_raw_handle();

    let handle = section.share_with(process as _).unwrap();
    let (pages, _) = w.ok(
        json!({"op": "openShared", "docId": 7, "handle": handle, "len": pdf.len()}),
        &[],
    );
    assert_eq!(pages, json!([{"width": 612.0, "height": 792.0}]));

    // The host may drop its handle at once: the worker's view keeps the bytes alive.
    drop(section);
    let (_, png) = w.ok(
        json!({"op": "render", "docId": 7, "pageIndex": 0, "width": 120, "format": "jpeg",
               "edits": null, "watermark": null}),
        &[],
    );
    assert!(png.starts_with(&[0xFF, 0xD8, 0xFF]));
    let (text, _) = w.ok(json!({"op": "extract", "docId": 7, "pageIndex": 0}), &[]);
    assert!(text["paragraphs"].to_string().contains("Hello worker"));

    // Sizes are checked before mapping, and the handle is still closed.
    let section = Section::new(&pdf).unwrap();
    let handle = section.share_with(process as _).unwrap();
    assert_eq!(
        w.err(json!({"op": "openShared", "docId": 8, "handle": handle, "len": 0}), &[]),
        "Invalid document size"
    );

    let _ = w.child.kill();
}

/// `sample_pdf()` protected with an open password, using the older RC4 128-bit
/// encryption (security handler revision 3) that most protected files in the wild use.
fn protected_sample(password: &str) -> Vec<u8> {
    use lopdf::{Document, EncryptionState, EncryptionVersion, Object, Permissions};
    let mut doc = Document::load_mem(&sample_pdf()).unwrap();
    let id = Object::string_literal(b"0123456789abcdef".to_vec());
    doc.trailer.set("ID", vec![id.clone(), id]);
    let state = EncryptionState::try_from(EncryptionVersion::V2 {
        document: &doc,
        owner_password: "owner-only",
        user_password: password,
        key_length: 128,
        permissions: Permissions::all(),
    })
    .unwrap();
    doc.encrypt(&state).unwrap();
    let mut out = Vec::new();
    doc.save_to(&mut out).unwrap();
    out
}

#[test]
fn worker_opens_password_protected_files_and_saves_them_protected() {
    let mut w = Worker::start();
    let locked = protected_sample("open sesame");
    let needs = novapdf_lib::protocol::NEEDS_PASSWORD;

    // No password, or the wrong one: the host is told a password is needed.
    assert_eq!(w.err(json!({"op": "open", "docId": 1}), &locked), needs);
    assert_eq!(w.err(json!({"op": "open", "docId": 1, "password": "nope"}), &locked), needs);
    // A password with a NUL is refused before PDFium sees it.
    assert_eq!(w.err(json!({"op": "open", "docId": 1, "password": "open\u{0}sesame"}), &locked), "That password is not valid.");

    let (pages, _) = w.ok(json!({"op": "open", "docId": 1, "password": "open sesame"}), &locked);
    assert_eq!(pages, json!([{"width": 612.0, "height": 792.0}]));
    let (text, _) = w.ok(json!({"op": "extract", "docId": 1, "pageIndex": 0}), &[]);
    assert!(text["paragraphs"].to_string().contains("Hello worker"));

    // Saved with AES-256 and the same password.
    let key: Vec<u8> = (0..32).collect();
    let (_, saved) = w.ok(
        json!({"op": "save", "pages": [{"docId": 1, "pageIndex": 0}], "watermark": null, "sanitize": true,
               "encrypt": {"password": "open sesame", "key": key}}),
        &[],
    );
    assert!(saved.starts_with(b"%PDF-"));
    assert!(!saved.windows(12).any(|w| w == b"Hello worker"), "the saved text is encrypted");
    assert_eq!(w.err(json!({"op": "open", "docId": 2}), &saved), needs);
    let (pages, _) = w.ok(json!({"op": "open", "docId": 2, "password": "open sesame"}), &saved);
    assert_eq!(pages.as_array().unwrap().len(), 1);
    let (text, _) = w.ok(json!({"op": "extract", "docId": 2, "pageIndex": 0}), &[]);
    assert!(text["paragraphs"].to_string().contains("Hello worker"));

    // Without `encrypt`, a save is plain, as before.
    let (_, plain) = w.ok(json!({"op": "save", "pages": [{"docId": 1, "pageIndex": 0}], "watermark": null, "sanitize": true}), &[]);
    w.ok(json!({"op": "open", "docId": 3}), &plain);

    // Bad encryption settings are refused in the worker too.
    assert_eq!(
        w.err(json!({"op": "save", "pages": [{"docId": 1, "pageIndex": 0}], "watermark": null, "sanitize": true,
                     "encrypt": {"password": "x", "key": [1, 2, 3]}}), &[]),
        "The encryption key is invalid."
    );

    let _ = w.child.kill();
}

/// macOS: what the worker's sandbox blocks. The checks must run inside a sandboxed
/// process, and entering the sandbox cannot be undone, so this test re-runs itself as
/// a child (`PROBE`) that enters it and reports back through its exit status.
#[cfg(target_os = "macos")]
#[test]
fn sandbox_blocks_writes_reads_network_and_programs() {
    const PROBE: &str = "NOVAPDF_SANDBOX_PROBE";
    if let Ok(dir) = std::env::var(PROBE) {
        let port: u16 = std::env::var("NOVAPDF_SANDBOX_PORT").unwrap().parse().unwrap();
        let home = std::env::var("HOME").unwrap();
        novapdf_lib::sandbox::harden_worker();
        let checks = [
            ("write a file", std::fs::write(PathBuf::from(&dir).join("escaped.txt"), b"x").is_err()),
            ("read a system file", std::fs::read("/etc/hosts").is_err()),
            ("list the home folder", std::fs::read_dir(&home).is_err()),
            ("connect to the network", std::net::TcpStream::connect(("127.0.0.1", port)).is_err()),
            ("start a program", Command::new("/bin/echo").stdout(Stdio::null()).status().is_err()),
            ("list the font folder", std::fs::read_dir("/System/Library/Fonts").is_ok_and(|mut d| d.next().is_some())),
        ];
        let failed: Vec<&str> = checks.iter().filter(|(_, ok)| !ok).map(|(name, _)| *name).collect();
        if !failed.is_empty() {
            eprintln!("sandbox check failed: {failed:?}");
            std::process::exit(1);
        }
        std::process::exit(0);
    }

    let dir = std::env::temp_dir().join(format!("novapdf-sandbox-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let status = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "sandbox_blocks_writes_reads_network_and_programs", "--nocapture", "--test-threads=1"])
        .env(PROBE, &dir)
        .env("NOVAPDF_SANDBOX_PORT", listener.local_addr().unwrap().port().to_string())
        .status()
        .unwrap();
    let escaped = dir.join("escaped.txt").exists();
    let _ = std::fs::remove_dir_all(&dir);
    assert!(status.success(), "sandboxed probe reported a failure: {status:?}");
    assert!(!escaped);
}
