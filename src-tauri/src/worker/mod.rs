//! The PDF worker process.
//!
//! Untrusted PDF bytes are only ever parsed here, never in the app process. The worker:
//!   * loads PDFium, then drops privileges (Windows: Low integrity level, process
//!     mitigation policies; the host also places it in a Job Object with a memory cap),
//!   * has no file-system or network duties: documents arrive as bytes over stdin and
//!     results leave as bytes over stdout,
//!   * is killed and restarted by the host if it crashes, hangs or exceeds its limits.

pub mod annots;
pub mod content;
pub mod edit;
pub mod extract;
pub mod fonts;
pub mod outline;
pub mod pdf;

use std::collections::HashMap;
use std::io::{self, BufReader, BufWriter};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;

use crate::protocol::{
    DocId, LayoutResult, PageInfo, Request, Response, read_frame, write_frame,
};
use crate::shared::Backing;
use fonts::Fonts;
use pdf::{Doc, Lib};

pub const WORKER_FLAG: &str = "--pdf-worker";
const MAX_OPEN_DOCS: usize = 256;

pub fn main() -> ! {
    let mut lib_dir: Option<PathBuf> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == "--pdfium" {
            lib_dir = args.next().map(PathBuf::from);
        }
    }

    let lib = match Lib::load(lib_dir.as_deref()) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[pdf-worker] {e}");
            std::process::exit(2);
        }
    };

    // Everything after this point may handle hostile input.
    crate::sandbox::harden_worker();

    let code = serve(&lib);
    std::process::exit(code);
}

fn serve(lib: &Lib) -> i32 {
    let mut input = BufReader::with_capacity(1 << 16, io::stdin().lock());
    let mut output = BufWriter::with_capacity(1 << 16, io::stdout().lock());
    let mut docs: HashMap<DocId, Doc> = HashMap::new();
    let mut fonts = Fonts::new();

    loop {
        let (header, payload) = match read_frame(&mut input) {
            Ok(f) => f,
            Err(_) => return 0, // host closed the pipe
        };
        let (response, out) = match serde_json::from_slice::<Request>(&header) {
            Ok(req) => {
                let result = catch_unwind(AssertUnwindSafe(|| {
                    handle(lib, &mut docs, &mut fonts, req, payload)
                }));
                match result {
                    Ok(Ok((value, bytes))) => (Response::Ok { result: value }, bytes),
                    Ok(Err(message)) => (Response::Err { message }, Vec::new()),
                    Err(_) => (
                        Response::Err { message: "Internal error while processing the PDF".into() },
                        Vec::new(),
                    ),
                }
            }
            Err(e) => (Response::Err { message: format!("Bad request: {e}") }, Vec::new()),
        };
        let header = serde_json::to_vec(&response).unwrap_or_else(|_| b"{\"status\":\"err\",\"message\":\"encode\"}".to_vec());
        if write_frame(&mut output, &header, &out).is_err() {
            return 1;
        }
    }
}

type Reply = Result<(serde_json::Value, Vec<u8>), String>;

fn open<'l>(lib: &'l Lib, docs: &mut HashMap<DocId, Doc<'l>>, doc_id: DocId, bytes: Backing) -> Reply {
    if docs.len() >= MAX_OPEN_DOCS && !docs.contains_key(&doc_id) {
        return Err("Too many open documents".into());
    }
    let doc = Doc::load_from(lib, bytes)?;
    let count = doc.page_count();
    if count <= 0 {
        return Err("This PDF has no pages.".into());
    }
    let pages: Vec<PageInfo> = (0..count)
        .map(|i| {
            let (width, height) = doc.page_size(i).unwrap_or((612.0, 792.0));
            PageInfo { width, height }
        })
        .collect();
    docs.insert(doc_id, doc);
    json(pages)
}

fn json<T: serde::Serialize>(v: T) -> Reply {
    serde_json::to_value(v)
        .map(|v| (v, Vec::new()))
        .map_err(|e| e.to_string())
}

fn handle<'l>(
    lib: &'l Lib,
    docs: &mut HashMap<DocId, Doc<'l>>,
    fonts: &mut Fonts,
    req: Request,
    payload: Vec<u8>,
) -> Reply {
    match req {
        Request::Open { doc_id } => open(lib, docs, doc_id, Backing::Owned(payload)),
        Request::OpenShared { doc_id, handle, len } => {
            #[cfg(windows)]
            {
                // SAFETY: the host duplicated this section handle into our process for
                // this request; `View::open` closes it.
                let view = unsafe { crate::shared::win::View::open(handle, len) }?;
                open(lib, docs, doc_id, Backing::Mapped(view))
            }
            #[cfg(not(windows))]
            {
                let _ = (doc_id, handle, len);
                Err("Shared documents are not supported on this platform".into())
            }
        }
        Request::Close { doc_id } => {
            docs.remove(&doc_id);
            json(())
        }
        Request::Render { doc_id, page_index, width, format, rotation, edits, watermark } => {
            let doc = docs.get(&doc_id).ok_or("Document is not open")?;
            let bytes = edit::render(
                lib,
                doc,
                page_index,
                width,
                format,
                rotation,
                edits.as_ref(),
                watermark.as_ref(),
                fonts,
            )?;
            Ok((serde_json::Value::Null, bytes))
        }
        Request::Extract { doc_id, page_index } => {
            let doc = docs.get(&doc_id).ok_or("Document is not open")?;
            json(extract::extract_page(doc, page_index, fonts)?)
        }
        Request::FindWatermarks { doc_id, text } => {
            let doc = docs.get(&doc_id).ok_or("Document is not open")?;
            json(extract::find_watermarks(doc, text.as_deref())?)
        }
        Request::Annotations { doc_id, first, count } => {
            let doc = docs.get(&doc_id).ok_or("Document is not open")?;
            json(annots::list(doc, first, count)?)
        }
        Request::TextChars { doc_id, page_index } => {
            let doc = docs.get(&doc_id).ok_or("Document is not open")?;
            json(annots::text_chars(doc, page_index)?)
        }
        Request::Outline { doc_id } => {
            let doc = docs.get(&doc_id).ok_or("Document is not open")?;
            json(outline::list(doc))
        }
        Request::Save { pages, watermark, sanitize } => {
            let saved = edit::save(lib, docs, &pages, watermark.as_ref(), sanitize, fonts)?;
            Ok((serde_json::json!({ "warnings": saved.warnings }), saved.bytes))
        }
        Request::Layout(args) => {
            args.validate()?;
            // A scratch document holds the fonts, so source documents stay untouched.
            let scratch = Doc::new_empty(lib)?;
            let lines = edit::Writer::new(&scratch, fonts).measure_lines(
                &args.text,
                &args.font,
                args.size,
                args.width,
                args.indent,
                args.h_scale,
            )?;
            json(LayoutResult { line_starts: edit::line_starts_in_chars(&args.text, &lines) })
        }
    }
}
