//! End-to-end checks against the real PDFium library (src-tauri/pdfium).
//! PDFium can be bound once per process and is not thread-safe, so everything
//! runs inside one test.

use std::collections::HashMap;
use std::path::PathBuf;

use novapdf_lib::protocol::{
    Align, AnnotChange, AnnotShape, FontSpec, ImageFormat, NewAnnot, OutputPage, PageEdits, Point,
    Rect, TextBlock, Watermark,
};
use novapdf_lib::worker::annots;
use novapdf_lib::worker::edit::{self, Writer};
use novapdf_lib::worker::extract;
use novapdf_lib::worker::fonts::Fonts;
use novapdf_lib::worker::pdf::{Doc, Lib};

fn helvetica() -> FontSpec {
    FontSpec { family: "Helvetica".into(), bold: false, italic: false }
}

fn block(id: &str, x: f32, baseline: f32, width: Option<f32>, text: &str) -> TextBlock {
    TextBlock {
        id: id.into(),
        x,
        baseline,
        width,
        text: text.into(),
        font: helvetica(),
        size: 12.0,
        color: [0, 0, 0],
        line_height: 1.25,
        align: Align::Left,
        indent: 0.0,
        h_scale: 1.0,
        continues: false,
    }
}

/// Bounding box of non-white pixels in a rendered image.
fn ink_box(png: &[u8]) -> (u32, u32, u32, u32, u32, u32) {
    let img = image::load_from_memory(png).unwrap().to_luma8();
    let (w, h) = img.dimensions();
    let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0, 0);
    for (x, y, p) in img.enumerate_pixels() {
        if p.0[0] < 128 {
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        }
    }
    (x0, y0, x1, y1, w, h)
}

#[test]
fn full_pipeline() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
    let lib = Lib::load(Some(&dir)).expect("PDFium must be installed: npm run setup:pdfium");
    let mut fonts = Fonts::new();

    // ---- 1. Build a source PDF: two paragraphs, a watermark, one rotated page.
    let source_bytes = {
        let doc = Doc::new_empty(&lib).unwrap();
        {
            let page = doc.new_page(612.0, 792.0).unwrap();
            let mut w = Writer::new(&doc, &mut fonts);
            let edits = PageEdits {
                blocks: vec![
                    block("a", 72.0, 100.0, Some(300.0),
                        "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. Sphinx of black quartz, judge my vow."),
                    block("b", 72.0, 300.0, None, "Second paragraph"),
                ],
                ..Default::default()
            };
            assert!(w.apply_edits(&page, &edits).unwrap());
            w.draw_watermark(&page, &Watermark {
                text: "CONFIDENTIAL".into(),
                font: helvetica(),
                size: 60.0,
                color: [200, 0, 0],
                opacity: 0.3,
                angle: 45.0,
            }).unwrap();
            page.generate_content().unwrap();
        }
        {
            let page = doc.new_page(612.0, 792.0).unwrap();
            page.set_rotation(1);
            let mut w = Writer::new(&doc, &mut fonts);
            // Display space of a 90°-rotated Letter page is 792 × 612.
            let edits = PageEdits {
                blocks: vec![block("r", 100.0, 200.0, None, "Rotated page text")],
                ..Default::default()
            };
            w.apply_edits(&page, &edits).unwrap();
            page.generate_content().unwrap();
        }
        doc.save().unwrap()
    };
    assert!(source_bytes.starts_with(b"%PDF-"));

    let src = Doc::load(&lib, source_bytes.clone()).unwrap();
    assert_eq!(src.page_count(), 2);

    // ---- 2. Extraction groups wrapped lines into one paragraph.
    let text = extract::extract_page(&src, 0, &mut fonts).unwrap();
    let p0 = text
        .paragraphs
        .iter()
        .find(|p| p.text.starts_with("The quick"))
        .expect("first paragraph");
    assert!(p0.wrap, "multi-line paragraph should wrap: {:?}", p0.text);
    assert!(p0.text.ends_with("judge my vow."), "{}", p0.text);
    assert!((p0.first_baseline - 100.0).abs() < 0.5, "baseline {}", p0.first_baseline);
    assert!((p0.bounds.x - 72.0).abs() < 1.0, "x {}", p0.bounds.x);
    assert!((p0.line_height - 1.25).abs() < 0.02, "line height {}", p0.line_height);
    assert_eq!(p0.font.family, "Helvetica");
    assert!(text.paragraphs.iter().any(|p| p.text == "Second paragraph"));
    let wm = text.loose.iter().find(|l| l.text == "CONFIDENTIAL").expect("watermark is loose text");
    assert!(wm.watermark_mark && wm.rotated && wm.transparent);

    // ---- 3. Coordinates agree with what PDFium renders (upright and rotated pages).
    let png = edit::render(&lib, &src, 0, 612, ImageFormat::Png, 0, None, None, &mut fonts).unwrap();
    let rotated_png = edit::render(&lib, &src, 1, 792, ImageFormat::Png, 0, None, None, &mut fonts).unwrap();
    let (_, _, _, _, w, h) = ink_box(&png);
    assert_eq!((w, h), (612, 792));
    let rot_text = extract::extract_page(&src, 1, &mut fonts).unwrap();
    let rp = &rot_text.paragraphs[0];
    assert_eq!(rp.text, "Rotated page text");
    assert!((rp.bounds.x - 100.0).abs() < 1.5 && (rp.first_baseline - 200.0).abs() < 0.5);
    let (x0, y0, _, y1, w, h) = ink_box(&rotated_png);
    assert_eq!((w, h), (792, 612));
    assert!((x0 as f32 - 100.0).abs() <= 3.0, "rendered x {x0}");
    assert!(y1 as f32 <= 203.0 && y0 as f32 >= 185.0, "rendered y {y0}..{y1}");

    // ---- 4. Watermark detection.
    let scan = extract::find_watermarks(&src, None).unwrap();
    assert_eq!(scan.marked_objects, 1);
    let scan_text = extract::find_watermarks(&src, Some("confidential")).unwrap();
    assert!(scan_text.marked_objects + scan_text.matching_text >= 1);

    // ---- 5. Edit: replace the paragraph with Vietnamese text (needs an embedded
    //         TrueType font), drop the watermark, reorder and rotate pages.
    let mut removed = p0.object_indices.clone();
    removed.extend(scan.pages[0].objects.iter().copied());
    let edits = PageEdits {
        removed_objects: removed,
        blocks: vec![TextBlock {
            text: "Xin chào Việt Nam — tiếng Việt có dấu".into(),
            ..block("v", p0.bounds.x, p0.first_baseline, Some(p0.bounds.width), "")
        }],
        ..Default::default()
    };
    let mut docs = HashMap::new();
    docs.insert(1, Doc::load(&lib, source_bytes.clone()).unwrap());
    let out_pages = vec![
        OutputPage { doc_id: 1, page_index: 1, rotation: 0, edits: None },
        OutputPage { doc_id: 1, page_index: 0, rotation: 90, edits: Some(edits) },
    ];
    let saved = edit::save(&lib, &docs, &out_pages, None, true, &mut fonts).unwrap().bytes;
    std::fs::create_dir_all(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target")).ok();
    std::fs::write(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/pipeline-output.pdf"),
        &saved,
    )
    .unwrap();

    let out = Doc::load(&lib, saved).unwrap();
    assert_eq!(out.page_count(), 2);
    // Page order swapped; second page now rotated, so its display size is landscape.
    let (pw, ph) = out.page_size(1).unwrap();
    assert!(pw > ph, "rotated page should be landscape: {pw}x{ph}");
    let edited = extract::extract_page(&out, 1, &mut fonts).unwrap();
    let all_text: String = edited
        .paragraphs
        .iter()
        .map(|p| p.text.clone())
        .chain(edited.loose.iter().map(|l| l.text.clone()))
        .collect::<Vec<_>>()
        .join(" | ");
    assert!(all_text.contains("Việt Nam"), "edited text missing: {all_text} {:?}", all_text.chars().filter(|c| !c.is_ascii()).map(|c| format!("U+{:04X}", c as u32)).collect::<Vec<_>>());
    assert!(!all_text.contains("quick brown"), "old text still present: {all_text}");
    assert!(!all_text.contains("CONFIDENTIAL"), "watermark still present: {all_text}");
    assert!(all_text.contains("Second paragraph"));
    let preview = edit::render(&lib, &out, 1, 900, ImageFormat::Png, 0, None, None, &mut fonts).unwrap();
    std::fs::write(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/pipeline-page2.png"), &preview).unwrap();

    // ---- 6. Rendering an edited page with a new watermark through the scratch path.
    let wm = Watermark {
        text: "DRAFT".into(),
        font: helvetica(),
        size: 48.0,
        color: [0, 0, 255],
        opacity: 0.5,
        angle: 30.0,
    };
    let jpeg = edit::render(&lib, &src, 0, 400, ImageFormat::Jpeg, 90, None, Some(&wm), &mut fonts).unwrap();
    assert!(jpeg.starts_with(&[0xFF, 0xD8, 0xFF]));
    let img = image::load_from_memory(&jpeg).unwrap();
    assert!(img.width() == 400 && img.height() < 400, "rotated render should be landscape");

    // ---- 7. Garbage input is rejected cleanly, not crashed on.
    assert!(Doc::load(&lib, b"%PDF-1.7\nnot really a pdf".to_vec()).is_err());
    assert!(Doc::load(&lib, vec![0u8; 10]).is_err());

    // ---- 8. Linked paragraphs: splitting at a measured line start, then drawing the
    // first part in a box of the same width, gives exactly that many lines on the page.
    let long = "Paragraphs that cross a page break are edited as one. The first box keeps its \
                lines and the rest flows into the box on the next page, measured with the same \
                font metrics that draw it, so the split always matches the rendered result.";
    let scratch = Doc::new_empty(&lib).unwrap();
    let lines = Writer::new(&scratch, &mut fonts).measure_lines(long, &helvetica(), 12.0, Some(220.0), 0.0, 1.0).unwrap();
    assert!(lines.len() >= 4, "expected several lines, got {}", lines.len());
    let starts = edit::line_starts_in_chars(long, &lines);
    assert_eq!(starts[0], 0);
    let cut = starts[2] as usize;
    let part_a: String = long.chars().take(cut).collect::<String>().trim_end().to_string();
    let linked = {
        let doc = Doc::new_empty(&lib).unwrap();
        {
            let page = doc.new_page(612.0, 792.0).unwrap();
            let edits = PageEdits {
                blocks: vec![block("la", 72.0, 600.0, Some(220.0), &part_a)],
                ..Default::default()
            };
            Writer::new(&doc, &mut fonts).apply_edits(&page, &edits).unwrap();
            page.generate_content().unwrap();
        }
        doc.save().unwrap()
    };
    let linked = Doc::load(&lib, linked).unwrap();
    let text = extract::extract_page(&linked, 0, &mut fonts).unwrap();
    assert_eq!(text.paragraphs.len(), 1);
    assert_eq!(text.paragraphs[0].line_count, 2, "{:?}", text.paragraphs[0].text);

    // ---- 9. Editing a justified, indented paragraph keeps its lines. The source is drawn
    // 6% narrower than the substitute font, as when a PDF embeds a slightly different
    // Times; extraction must detect the layout and calibrate, so unchanged text
    // re-typesets onto the same number of lines.
    let body = concat!(
        "Evaluation metrics likewise reflect different objectives. Execution Accuracy compares ",
        "the execution result of predicted SQL with that of the reference query. Test-Suite ",
        "Accuracy evaluates a query over multiple database states to reduce the likelihood ",
        "that an incorrect query coincidentally returns the correct result."
    );
    let original = TextBlock {
        align: Align::Justify,
        indent: 18.0,
        h_scale: 0.94,
        line_height: 1.15,
        size: 10.0,
        ..block("src", 72.0, 200.0, Some(300.0), body)
    };
    let justified = {
        let doc = Doc::new_empty(&lib).unwrap();
        {
            let page = doc.new_page(612.0, 792.0).unwrap();
            let edits = PageEdits { blocks: vec![original.clone()], ..Default::default() };
            Writer::new(&doc, &mut fonts).apply_edits(&page, &edits).unwrap();
            page.generate_content().unwrap();
        }
        doc.save().unwrap()
    };
    let justified = Doc::load(&lib, justified).unwrap();
    let pt = extract::extract_page(&justified, 0, &mut fonts).unwrap();
    assert_eq!(pt.paragraphs.len(), 1, "{:?}", pt.paragraphs.iter().map(|p| &p.text).collect::<Vec<_>>());
    let para = &pt.paragraphs[0];
    assert_eq!(para.align, Align::Justify);
    assert!((para.indent - 18.0).abs() < 1.0, "indent {}", para.indent);
    assert!(para.h_scale <= 0.945 && para.h_scale > 0.85, "h_scale {}", para.h_scale);
    // Re-typeset exactly as the editor does for an unchanged paragraph.
    let width = para.bounds.width + 0.5;
    let relaid = Writer::new(&scratch, &mut fonts)
        .measure_lines(&para.text, &para.font, para.size, Some(width), para.indent, para.h_scale)
        .unwrap();
    assert_eq!(relaid.len() as u32, para.line_count, "re-typeset text gained lines");

    // ---- 10. Saving a removal must not move other text. Word-style content: one text
    // block split across two content streams, the second positioning its lines
    // relative to the first, with TJ spacing. PDFium rewriting a stream breaks both.
    let split = split_stream_pdf();
    let src = Doc::load(&lib, split.clone()).unwrap();
    let before = extract::extract_page(&src, 0, &mut fonts).unwrap();
    let line_one = before.paragraphs.iter().find(|p| p.text.starts_with("Line one")).unwrap();
    let mut docs = HashMap::new();
    docs.insert(7, Doc::load(&lib, split).unwrap());
    let edits = PageEdits { removed_objects: line_one.object_indices.clone(), ..Default::default() };
    let saved = edit::save(
        &lib,
        &docs,
        &[OutputPage { doc_id: 7, page_index: 0, rotation: 0, edits: Some(edits) }],
        None,
        true,
        &mut fonts,
    )
    .unwrap();
    assert!(saved.warnings.is_empty(), "{:?}", saved.warnings);
    let out = Doc::load(&lib, saved.bytes).unwrap();
    let after = extract::extract_page(&out, 0, &mut fonts).unwrap();
    assert!(!after.paragraphs.iter().any(|p| p.text.starts_with("Line one")), "removed text is still there");
    for p in before.paragraphs.iter().filter(|p| !p.text.starts_with("Line one")) {
        let q = after.paragraphs.iter().find(|q| q.text == p.text).unwrap_or_else(|| panic!("lost {:?}", p.text));
        assert!(
            (q.bounds.x - p.bounds.x).abs() < 0.05 && (q.first_baseline - p.first_baseline).abs() < 0.05,
            "{:?} moved: {:?} -> {:?}",
            p.text,
            (p.bounds.x, p.first_baseline),
            (q.bounds.x, q.first_baseline)
        );
        assert!((q.bounds.width - p.bounds.width).abs() < 0.05, "{:?} lost its spacing", p.text);
    }

    // ---- 11. Text search for watermarks: exact body-text matches count, fragments of
    // upright opaque text do not, and a blank query is the same as no query.
    let wm_src = Doc::load(&lib, source_bytes.clone()).unwrap();
    let scan = extract::find_watermarks(&wm_src, Some("  Second Paragraph ")).unwrap();
    assert_eq!((scan.marked_objects, scan.matching_text), (1, 1), "{scan:?}");
    let scan = extract::find_watermarks(&wm_src, Some("Second paragraph and more")).unwrap();
    assert_eq!(scan.matching_text, 0, "upright body text is never a fragment match");
    let scan = extract::find_watermarks(&wm_src, Some("   ")).unwrap();
    assert_eq!((scan.marked_objects, scan.matching_text), (1, 0));

    // ---- 12. Sanitizing on save removes annotations that can run code or carry files,
    // keeps safe links, notes and watermark annotations; without sanitize all stay.
    let annotated = annotated_pdf();
    let adoc = Doc::load(&lib, annotated.clone()).unwrap();
    let scan = extract::find_watermarks(&adoc, None).unwrap();
    assert_eq!(scan.annotations, 1);
    assert_eq!(scan.pages[0].annots, [6]);
    let mut docs = HashMap::new();
    docs.insert(8, Doc::load(&lib, annotated).unwrap());
    let page0 = || OutputPage { doc_id: 8, page_index: 0, rotation: 0, edits: None };
    let all = annots_of(&edit::save(&lib, &docs, &[page0()], None, false, &mut fonts).unwrap().bytes);
    assert_eq!(all.len(), 8, "{all:?}");
    let safe = annots_of(&edit::save(&lib, &docs, &[page0()], None, true, &mut fonts).unwrap().bytes);
    assert_eq!(
        safe,
        ["Link/URI:https://example.com", "Link/GoTo", "Watermark", "Text"],
        "unsafe annotations must be removed"
    );
    // removedAnnots edits drop exactly the listed annotations.
    let edits = PageEdits { removed_annots: vec![7, 0, 99], ..Default::default() };
    let pruned = edit::save(&lib, &docs, &[OutputPage { edits: Some(edits), ..page0() }], None, false, &mut fonts)
        .unwrap()
        .bytes;
    let pruned = annots_of(&pruned);
    assert_eq!(pruned.len(), 6, "{pruned:?}");
    assert!(!pruned.iter().any(|a| a == "Text" || a == "Link/JavaScript"), "{pruned:?}");

    // ---- 13. Saving with a watermark stamps every page; saving nothing is an error.
    let stamped = edit::save(&lib, &docs, &[page0(), page0()], Some(&wm), false, &mut fonts).unwrap();
    let stamped = Doc::load(&lib, stamped.bytes).unwrap();
    assert_eq!(stamped.page_count(), 2);
    assert_eq!(extract::find_watermarks(&stamped, None).unwrap().marked_objects, 2);
    assert!(edit::save(&lib, &docs, &[], None, true, &mut fonts).is_err());
    let missing = OutputPage { doc_id: 404, ..page0() };
    assert!(edit::save(&lib, &docs, &[missing], None, true, &mut fonts).is_err());

    // ---- 14. Drawing centred / right-aligned blocks, blank lines and empty blocks, and
    // rendering with an extra rotation, on a blank page.
    let blank = {
        let doc = Doc::new_empty(&lib).unwrap();
        doc.new_page(612.0, 792.0).unwrap();
        Doc::load(&lib, doc.save().unwrap()).unwrap()
    };
    let only = |b: TextBlock| PageEdits { blocks: vec![b], ..Default::default() };
    let right = only(TextBlock { align: Align::Right, ..block("r", 72.0, 100.0, Some(300.0), "Right edge") });
    let png = edit::render(&lib, &blank, 0, 612, ImageFormat::Png, 0, Some(&right), None, &mut fonts).unwrap();
    let (x0, _, x1, _, _, _) = ink_box(&png);
    assert!((x1 as f32 - 372.0).abs() <= 3.0 && x0 > 250, "right-aligned ink {x0}..{x1}");
    let centred = only(TextBlock {
        align: Align::Center,
        ..block("c", 72.0, 100.0, Some(300.0), "Centred\n\nlines")
    });
    let png = edit::render(&lib, &blank, 0, 612, ImageFormat::Png, 0, Some(&centred), None, &mut fonts).unwrap();
    let (x0, y0, x1, y1, _, _) = ink_box(&png);
    assert!(((x0 + x1) as f32 / 2.0 - 222.0).abs() <= 3.0, "centred ink {x0}..{x1}");
    // Three lines (one blank) at 15 pt spacing: the last baseline is at 130.
    assert!(y0 >= 85 && (125..=134).contains(&y1), "centred ink rows {y0}..{y1}");
    let empty = only(block("e", 72.0, 100.0, Some(300.0), " \n "));
    let png = edit::render(&lib, &blank, 0, 612, ImageFormat::Png, 0, Some(&empty), None, &mut fonts).unwrap();
    assert_eq!(ink_box(&png).0, u32::MAX, "an empty block draws nothing");
    let turned = edit::render(&lib, &blank, 0, 300, ImageFormat::Png, 270, None, None, &mut fonts).unwrap();
    let (_, _, _, _, w, h) = ink_box(&turned);
    assert!(w == 300 && h < w, "a quarter turn renders landscape: {w}x{h}");

    // ---- 15. Layout through the worker's measuring path.
    let lines = Writer::new(&scratch, &mut fonts)
        .measure_lines("", &helvetica(), 12.0, Some(100.0), 0.0, 1.0)
        .unwrap();
    assert_eq!(lines.len(), 1);
    let narrow = Writer::new(&scratch, &mut fonts)
        .measure_lines("Hello world", &helvetica(), 12.0, Some(100.0), 0.0, 0.5)
        .unwrap();
    let wide = Writer::new(&scratch, &mut fonts)
        .measure_lines("Hello world", &helvetica(), 12.0, Some(100.0), 0.0, 1.0)
        .unwrap();
    assert!((narrow[0].width * 2.0 - wide[0].width).abs() < 0.01, "h_scale scales widths");

    // ---- 16. Comments. The page has a CropBox that does not start at (0, 0), so
    // display space is offset from page space by (100, 742).
    let commented = comment_pdf();
    let cdoc = Doc::load(&lib, commented.clone()).unwrap();
    let listed = annots::list(&cdoc, 0, 5).unwrap();
    assert_eq!(listed.len(), 1);
    let list0 = &listed[0].annots;
    let kinds: Vec<(u32, &str)> = list0.iter().map(|a| (a.index, a.subtype.as_str())).collect();
    assert_eq!(kinds, [(0, "Text"), (2, "Text"), (3, "Highlight")], "popup and hidden note are not listed");
    let note = &list0[0];
    assert_eq!((note.contents.as_str(), note.author.as_str()), ("old", "Ann"));
    assert_eq!(note.date, "D:20240101000000Z");
    assert_eq!((note.popup, note.in_reply_to), (Some(1), None));
    assert_eq!(list0[1].in_reply_to, Some(0));
    assert!((note.rect.x - 50.0).abs() < 0.01 && (note.rect.y - 72.0).abs() < 0.01, "{:?}", note.rect);
    assert_eq!(list0[2].color, Some([255, 255, 0]));
    assert!(annots::list(&cdoc, 1, 1).is_err() && annots::list(&cdoc, 0, 0).is_err());

    // Character boxes in display space: "Hello" starts at x 50, baseline 142.
    let chars = annots::text_chars(&cdoc, 0).unwrap();
    assert_eq!(String::from_utf16_lossy(&chars.codes), "Hello");
    assert_eq!(chars.boxes.len(), 20);
    let (hx, hy, hh) = (chars.boxes[0], chars.boxes[1], chars.boxes[3]);
    assert!((hx - 50.0).abs() < 1.5 && hy < 142.0 && hy + hh > 142.0, "H box {:?}", &chars.boxes[..4]);

    let date = "D:20261126093000+07'00'";
    let new_annots = vec![
        NewAnnot {
            id: "note-1".into(),
            shape: AnnotShape::Note { x: 60.0, y: 100.0 },
            color: [255, 200, 0],
            opacity: 1.0,
            contents: "A new note".into(),
            author: "Linh".into(),
            date: date.into(),
        },
        NewAnnot {
            id: "hl-1".into(),
            shape: AnnotShape::Highlight { rects: vec![Rect { x: 50.0, y: 118.0, width: 60.0, height: 30.0 }] },
            color: [255, 235, 59],
            opacity: 0.5,
            contents: String::new(),
            author: String::new(),
            date: date.into(),
        },
        NewAnnot {
            id: "ink-1".into(),
            shape: AnnotShape::Ink {
                strokes: vec![vec![Point { x: 200.0, y: 300.0 }, Point { x: 300.0, y: 300.0 }]],
                width: 6.0,
            },
            color: [0, 0, 255],
            opacity: 1.0,
            contents: String::new(),
            author: String::new(),
            date: date.into(),
        },
    ];
    let comment_edits = PageEdits {
        changed_annots: vec![AnnotChange { index: 0, contents: Some("new <text>".into()), at: None, date: date.into() }],
        annotations: new_annots.clone(),
        ..Default::default()
    };
    let mut cdocs = HashMap::new();
    cdocs.insert(9, Doc::load(&lib, commented.clone()).unwrap());
    let out = OutputPage { doc_id: 9, page_index: 0, rotation: 0, edits: Some(comment_edits.clone()) };
    let saved = edit::save(&lib, &cdocs, &[out], None, true, &mut fonts).unwrap().bytes;
    // Comment-only edits never rewrite the page content.
    assert_eq!(page_content(&saved), page_content(&commented), "content stream must be unchanged");
    let dicts = annot_dicts(&saved);
    assert_eq!(dicts.len(), 8, "5 original + 3 new");
    for (sub, nm, flags) in [("Text", "note-1", 28), ("Highlight", "hl-1", 4), ("Ink", "ink-1", 4)] {
        let d = dicts.iter().find(|d| d.contains(&format!("/NM ({nm})"))).unwrap_or_else(|| panic!("{nm}: {dicts:?}"));
        assert!(d.contains(&format!("/Subtype /{sub}")), "{d}");
        assert!(d.contains("/AP"), "{nm} needs an appearance stream: {d}");
        assert!(d.contains(&format!("/F {flags}")), "{nm} flags: {d}");
        assert!(d.contains(&format!("/M ({date})")) && d.contains("/CreationDate"), "{d}");
    }
    let old = dicts.iter().find(|d| d.contains("/NM (n1)")).unwrap();
    assert!(old.contains("new <text>") && old.contains("new &lt;text&gt;"), "contents and /RC updated: {old}");
    assert!(old.contains("/Popup"), "changed in place keeps its popup: {old}");
    assert!(dicts.iter().any(|d| d.contains("/IRT")), "the reply still points at the note");

    let reloaded = Doc::load(&lib, saved.clone()).unwrap();
    let relisted = &annots::list(&reloaded, 0, 1).unwrap()[0].annots;
    let new_note = relisted.iter().find(|a| a.contents == "A new note").expect("new note listed");
    assert_eq!((new_note.subtype.as_str(), new_note.author.as_str()), ("Text", "Linh"));
    assert!(
        (new_note.rect.x - 60.0).abs() < 0.01 && (new_note.rect.y - 100.0).abs() < 0.01,
        "note lands where it was placed: {:?}",
        new_note.rect
    );
    assert_eq!(relisted.iter().find(|a| a.index == 0).unwrap().contents, "new <text>");
    // The ink stroke is drawn: blue pixels along y = 300 (display), x 200..300.
    let png = edit::render(&lib, &reloaded, 0, 412, ImageFormat::Png, 0, None, None, &mut fonts).unwrap();
    let img = image::load_from_memory(&png).unwrap().to_rgb8();
    let px = img.get_pixel(250, 300).0;
    assert!(px[2] > 150 && px[0] < 100, "ink pixel {px:?}");
    // The same edits render through the scratch path (thumbnails).
    let thumb = edit::render(&lib, &cdoc, 0, 412, ImageFormat::Png, 0, Some(&comment_edits), None, &mut fonts).unwrap();
    let px = image::load_from_memory(&thumb).unwrap().to_rgb8().get_pixel(250, 300).0;
    assert!(px[2] > 150 && px[0] < 100, "ink in a rendered thumbnail {px:?}");

    // Deleting a note together with its popup and reply leaves the rest.
    let delete = PageEdits { removed_annots: vec![0, 1, 2], ..Default::default() };
    let out = OutputPage { doc_id: 9, page_index: 0, rotation: 0, edits: Some(delete) };
    let pruned = annot_dicts(&edit::save(&lib, &cdocs, &[out], None, true, &mut fonts).unwrap().bytes);
    assert_eq!(pruned.len(), 2, "{pruned:?}");
    assert!(pruned.iter().all(|d| !d.contains("/Popup") && !d.contains("/IRT")), "{pruned:?}");

    // Moving a note in the file: its rect moves (same size), its text and rich text stay.
    let mut save_with = |edits: PageEdits| {
        let out = OutputPage { doc_id: 9, page_index: 0, rotation: 0, edits: Some(edits) };
        edit::save(&lib, &cdocs, &[out], None, true, &mut fonts).map(|s| s.bytes)
    };
    let move_to = |index: u32, x: f32, y: f32| PageEdits {
        changed_annots: vec![AnnotChange { index, contents: None, at: Some(Point { x, y }), date: date.into() }],
        ..Default::default()
    };
    let moved = save_with(move_to(0, 300.0, 400.0)).unwrap();
    assert_eq!(page_content(&moved), page_content(&commented), "a move leaves the content alone");
    let moved_doc = Doc::load(&lib, moved.clone()).unwrap();
    let moved_list = annots::list(&moved_doc, 0, 1).unwrap().remove(0).annots;
    let m = moved_list.iter().find(|a| a.index == 0).unwrap();
    assert!((m.rect.x - 300.0).abs() < 0.01 && (m.rect.y - 400.0).abs() < 0.01, "{:?}", m.rect);
    assert!((m.rect.width - note.rect.width).abs() < 0.01 && (m.rect.height - note.rect.height).abs() < 0.01);
    assert_eq!(m.contents, "old", "a move keeps the text");
    let d = annot_dicts(&moved).into_iter().find(|d| d.contains("/NM (n1)")).unwrap();
    assert!(d.contains("/RC") && d.contains(&format!("/M ({date})")), "{d}");
    // Highlights stay with their text; nothing goes off the page (412 × 692 here).
    assert!(save_with(move_to(3, 10.0, 10.0)).unwrap_err().contains("Only notes"));
    assert!(save_with(move_to(0, 400.0, 10.0)).unwrap_err().contains("outside the page"));
    let off = PageEdits {
        annotations: vec![NewAnnot { shape: AnnotShape::Note { x: 10.0, y: 690.0 }, ..new_annots[0].clone() }],
        ..Default::default()
    };
    assert!(save_with(off).unwrap_err().contains("outside the page"));
    let off_ink = PageEdits {
        annotations: vec![NewAnnot {
            shape: AnnotShape::Ink { strokes: vec![vec![Point { x: 10.0, y: 10.0 }, Point { x: 500.0, y: 10.0 }]], width: 2.0 },
            ..new_annots[2].clone()
        }],
        ..Default::default()
    };
    assert!(save_with(off_ink).unwrap_err().contains("outside the page"));

    // On a page rotated in the app, comments are placed before the rotation, so they
    // turn with the page.
    let out = OutputPage { doc_id: 9, page_index: 0, rotation: 90, edits: Some(comment_edits) };
    let turned = Doc::load(&lib, edit::save(&lib, &cdocs, &[out], None, true, &mut fonts).unwrap().bytes).unwrap();
    let turned_note = annots::list(&turned, 0, 1).unwrap().remove(0).annots;
    let turned_note = turned_note.iter().find(|a| a.contents == "A new note").unwrap();
    // Display space of the turned page is 692 × 412: (60, 100) maps to (692 - 100 - 20, 60).
    assert!((turned_note.rect.x - 572.0).abs() < 0.5 && (turned_note.rect.y - 60.0).abs() < 0.5, "{:?}", turned_note.rect);
}

/// Decoded content of page 1.
fn page_content(pdf: &[u8]) -> Vec<u8> {
    let doc = lopdf::Document::load_mem(pdf).unwrap();
    doc.get_page_content(doc.get_pages()[&1])
}

/// Each annotation dictionary on page 1, printed as PDF-like text.
fn annot_dicts(pdf: &[u8]) -> Vec<String> {
    use lopdf::Object;
    let doc = lopdf::Document::load_mem(pdf).unwrap();
    let page = doc.get_dictionary(doc.get_pages()[&1]).unwrap();
    let Ok(annots) = page.get(b"Annots") else { return Vec::new() };
    fn show(o: &Object) -> String {
        match o {
            Object::Name(n) => format!("/{}", String::from_utf8_lossy(n)),
            Object::String(s, _) => {
                let text = if s.starts_with(&[0xFE, 0xFF]) {
                    let units: Vec<u16> = s[2..].chunks(2).map(|c| u16::from_be_bytes([c[0], *c.get(1).unwrap_or(&0)])).collect();
                    String::from_utf16_lossy(&units)
                } else {
                    String::from_utf8_lossy(s).into_owned()
                };
                format!("({text})")
            }
            Object::Integer(i) => i.to_string(),
            Object::Real(r) => r.to_string(),
            Object::Reference(r) => format!("{} 0 R", r.0),
            Object::Array(a) => format!("[{}]", a.iter().map(show).collect::<Vec<_>>().join(" ")),
            Object::Dictionary(d) => {
                let items: Vec<String> = d.iter().map(|(k, v)| format!("/{} {}", String::from_utf8_lossy(k), show(v))).collect();
                format!("<< {} >>", items.join(" "))
            }
            other => format!("{other:?}"),
        }
    }
    doc.dereference(annots)
        .unwrap()
        .1
        .as_array()
        .unwrap()
        .iter()
        .map(|a| show(doc.dereference(a).unwrap().1))
        .collect()
}

/// A one-page PDF with a CropBox offset from the MediaBox, one line of text and
/// comments: a note with rich text, its popup, a reply, a highlight and a hidden note.
fn comment_pdf() -> Vec<u8> {
    let content = "BT /F1 24 Tf 150 600 Td (Hello) Tj ET";
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [100 50 512 742] \
         /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R \
         /Annots [6 0 R 7 0 R 8 0 R 9 0 R 10 0 R] >>"
            .to_string(),
        format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
        "<< /Type /Annot /Subtype /Text /Rect [150 650 170 670] /Contents (old) /RC (<p>old</p>) \
         /T (Ann) /M (D:20240101000000Z) /NM (n1) /Popup 7 0 R >>"
            .to_string(),
        "<< /Type /Annot /Subtype /Popup /Rect [200 600 400 700] /Parent 6 0 R >>".to_string(),
        "<< /Type /Annot /Subtype /Text /Rect [150 650 170 670] /Contents (reply) /IRT 6 0 R >>".to_string(),
        "<< /Type /Annot /Subtype /Highlight /Rect [150 595 230 625] \
         /QuadPoints [150 625 230 625 150 595 230 595] /C [1 1 0] /Contents (hl) >>"
            .to_string(),
        "<< /Type /Annot /Subtype /Text /F 2 /Rect [300 300 320 320] /Contents (hidden) >>".to_string(),
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

/// Subtype (and action type, for links) of each annotation on page 1, in order.
fn annots_of(pdf: &[u8]) -> Vec<String> {
    use lopdf::Object;
    let doc = lopdf::Document::load_mem(pdf).unwrap();
    let page = doc.get_dictionary(doc.get_pages()[&1]).unwrap();
    let Ok(annots) = page.get(b"Annots") else { return Vec::new() };
    let name = |o: &Object| String::from_utf8_lossy(o.as_name().unwrap()).into_owned();
    doc.dereference(annots)
        .unwrap()
        .1
        .as_array()
        .unwrap()
        .iter()
        .map(|a| {
            let d = doc.dereference(a).unwrap().1.as_dict().unwrap();
            let sub = name(d.get(b"Subtype").unwrap());
            let Ok(action) = d.get(b"A") else { return sub };
            let action = doc.dereference(action).unwrap().1.as_dict().unwrap();
            let kind = name(action.get(b"S").unwrap());
            match action.get(b"URI") {
                Ok(uri) => format!("{sub}/{kind}:{}", String::from_utf8_lossy(uri.as_str().unwrap())),
                Err(_) => format!("{sub}/{kind}"),
            }
        })
        .collect()
}

/// A one-page PDF carrying one annotation of each kind the sanitizer cares about.
fn annotated_pdf() -> Vec<u8> {
    let annots = [
        "/Subtype /Link /A << /S /JavaScript /JS (app.alert) >>",
        "/Subtype /Link /A << /S /URI /URI (javascript:void0) >>",
        "/Subtype /Link /A << /S /URI /URI (https://example.com) >>",
        "/Subtype /Link /A << /S /GoTo /D [3 0 R /Fit] >>",
        "/Subtype /Link /A << /S /Launch /F (calc.exe) >>",
        "/Subtype /FileAttachment /FS << /Type /Filespec /F (a.txt) >>",
        "/Subtype /Watermark",
        "/Subtype /Text /Contents (note)",
    ];
    let refs: Vec<String> = (0..annots.len()).map(|i| format!("{} 0 R", 4 + i)).collect();
    let mut objects = vec![
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [{}] >>", refs.join(" ")),
    ];
    for (i, a) in annots.iter().enumerate() {
        let y = 700 - 40 * i;
        objects.push(format!("<< /Type /Annot {a} /Rect [72 {y} 172 {}] >>", y + 20));
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

/// A one-page PDF whose single text block spans two content streams.
fn split_stream_pdf() -> Vec<u8> {
    let s1 = "BT /F1 12 Tf 1 0 0 1 72 700 Tm (Line one here) Tj";
    let s2 = "0 -40 Td (Line two here) Tj 0 -40 Td [(Line)-900(three)-900(spaced)] TJ ET";
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents [5 0 R 6 0 R] >>".to_string(),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
        format!("<< /Length {} >>
stream
{s1}
endstream", s1.len() + 1),
        format!("<< /Length {} >>
stream
{s2}
endstream", s2.len() + 1),
    ];
    let mut pdf = b"%PDF-1.7
".to_vec();
    let mut offsets = Vec::new();
    for (i, o) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend(format!("{} 0 obj
{o}
endobj
", i + 1).into_bytes());
    }
    let xref = pdf.len();
    pdf.extend(format!("xref
0 {}
0000000000 65535 f 
", objects.len() + 1).into_bytes());
    for off in offsets {
        pdf.extend(format!("{off:010} 00000 n 
").into_bytes());
    }
    pdf.extend(format!("trailer
<< /Size {} /Root 1 0 R >>
startxref
{xref}
%%EOF
", objects.len() + 1).into_bytes());
    pdf
}
