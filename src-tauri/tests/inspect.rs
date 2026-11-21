//! Developer tool: renders and extracts a PDF given in NOVAPDF_INSPECT.
//!   NOVAPDF_INSPECT=path/to/file.pdf cargo test --test inspect -- --ignored --nocapture
//! Writes target/inspect-<n>.png and prints the paragraphs found on each page.

use std::path::PathBuf;

use novapdf_lib::protocol::ImageFormat;
use novapdf_lib::worker::edit;
use novapdf_lib::worker::extract;
use novapdf_lib::worker::fonts::Fonts;
use novapdf_lib::worker::pdf::{Doc, Lib};

#[test]
#[ignore]
fn inspect() {
    let Some(path) = std::env::var_os("NOVAPDF_INSPECT") else {
        eprintln!("set NOVAPDF_INSPECT");
        return;
    };
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let lib = Lib::load(Some(&root.join("pdfium"))).unwrap();
    let mut fonts = Fonts::new();
    let doc = Doc::load(&lib, std::fs::read(&path).unwrap()).unwrap();
    for i in 0..doc.page_count() {
        let (w, h) = doc.page_size(i).unwrap();
        println!("--- page {} ({w:.0} x {h:.0} pt)", i + 1);
        let text = extract::extract_page(&doc, i, &mut fonts).unwrap();
        for p in &text.paragraphs {
            println!("  [{} {:.1}pt] {}", p.font.family, p.size, p.text);
        }
        for l in &text.loose {
            println!("  (loose{}) {}", if l.watermark_mark { ", watermark" } else { "" }, l.text);
        }
        let png = edit::render(&lib, &doc, i, 800, ImageFormat::Png, 0, None, None, &mut fonts).unwrap();
        std::fs::write(root.join(format!("target/inspect-{}.png", i + 1)), png).unwrap();
    }
}
