//! Unit tests for `protocol.rs`. Kept in their own file so coverage reports can exclude test code.

use super::*;
use serde_json::json;

fn font() -> FontSpec {
    FontSpec { family: "Helvetica".into(), bold: false, italic: false }
}

fn block() -> TextBlock {
    TextBlock {
        id: "b1".into(),
        x: 72.0,
        baseline: 100.0,
        width: Some(300.0),
        text: "Hello".into(),
        font: font(),
        size: 12.0,
        color: [0, 0, 0],
        line_height: 1.2,
        align: Align::Left,
        indent: 0.0,
        h_scale: 1.0,
        continues: false,
    }
}

fn edits_with(b: TextBlock) -> PageEdits {
    PageEdits { blocks: vec![b], ..Default::default() }
}

fn watermark() -> Watermark {
    Watermark { text: "DRAFT".into(), font: font(), size: 48.0, color: [255, 0, 0], opacity: 0.5, angle: 45.0 }
}

fn layout_args() -> LayoutArgs {
    LayoutArgs { text: "Hello world".into(), font: font(), size: 12.0, width: Some(200.0), indent: 0.0, h_scale: 1.0 }
}

// ---------- PageEdits ----------

#[test]
fn page_edits_is_empty() {
    assert!(PageEdits::default().is_empty());
    assert!(!PageEdits { removed_objects: vec![1], ..Default::default() }.is_empty());
    assert!(!PageEdits { removed_annots: vec![0], ..Default::default() }.is_empty());
    assert!(!edits_with(block()).is_empty());
}

#[test]
fn page_edits_valid_block_passes() {
    assert!(PageEdits::default().validate().is_ok());
    assert!(edits_with(block()).validate().is_ok());
    // Inclusive bounds are accepted.
    let b = TextBlock {
        x: -20_000.0,
        baseline: 20_000.0,
        size: 0.5,
        line_height: 5.0,
        width: Some(1.0),
        indent: -5000.0,
        h_scale: 2.0,
        id: "x".repeat(128),
        text: "a".repeat(MAX_TEXT_CHARS),
        ..block()
    };
    assert!(edits_with(b).validate().is_ok());
    assert!(edits_with(TextBlock { width: None, ..block() }).validate().is_ok());
}

#[test]
fn page_edits_rejects_bad_geometry() {
    let cases: Vec<(&str, TextBlock)> = vec![
        ("x NaN", TextBlock { x: f32::NAN, ..block() }),
        ("x too far", TextBlock { x: 20_000.5, ..block() }),
        ("baseline inf", TextBlock { baseline: f32::INFINITY, ..block() }),
        ("baseline too far", TextBlock { baseline: -20_001.0, ..block() }),
        ("size small", TextBlock { size: 0.49, ..block() }),
        ("size large", TextBlock { size: 1000.1, ..block() }),
        ("size NaN", TextBlock { size: f32::NAN, ..block() }),
        ("line height small", TextBlock { line_height: 0.4, ..block() }),
        ("line height large", TextBlock { line_height: 5.1, ..block() }),
        ("width small", TextBlock { width: Some(0.9), ..block() }),
        ("width large", TextBlock { width: Some(20_001.0), ..block() }),
        ("width NaN", TextBlock { width: Some(f32::NAN), ..block() }),
        ("indent", TextBlock { indent: 5000.1, ..block() }),
        ("indent NaN", TextBlock { indent: f32::NAN, ..block() }),
        ("h_scale small", TextBlock { h_scale: 0.49, ..block() }),
        ("h_scale large", TextBlock { h_scale: 2.01, ..block() }),
        ("long id", TextBlock { id: "x".repeat(129), ..block() }),
    ];
    for (name, b) in cases {
        assert_eq!(edits_with(b).validate(), Err("Text block has invalid geometry".to_string()), "{name}");
    }
}

#[test]
fn page_edits_rejects_long_text_counted_in_chars() {
    let b = TextBlock { text: "a".repeat(MAX_TEXT_CHARS + 1), ..block() };
    assert_eq!(edits_with(b).validate(), Err("Text block is too long".into()));
    // The limit is in characters, not bytes: MAX_TEXT_CHARS two-byte chars pass.
    let b = TextBlock { text: "é".repeat(MAX_TEXT_CHARS), ..block() };
    assert!(edits_with(b).validate().is_ok());
}

#[test]
fn page_edits_rejects_long_font_family() {
    let b = TextBlock { font: FontSpec { family: "F".repeat(257), ..font() }, ..block() };
    assert_eq!(edits_with(b).validate(), Err("Font family name is too long".into()));
    let b = TextBlock { font: FontSpec { family: "F".repeat(256), ..font() }, ..block() };
    assert!(edits_with(b).validate().is_ok());
}

#[test]
fn page_edits_rejects_too_many_blocks_and_indices() {
    let e = PageEdits { blocks: vec![block(); MAX_BLOCKS_PER_PAGE + 1], ..Default::default() };
    assert_eq!(e.validate(), Err("Too many text blocks on one page".into()));
    let e = PageEdits { blocks: vec![block(); MAX_BLOCKS_PER_PAGE], ..Default::default() };
    assert!(e.validate().is_ok());
    let e = PageEdits { removed_objects: vec![0; MAX_INDEX_LIST + 1], ..Default::default() };
    assert_eq!(e.validate(), Err("Too many removed objects".into()));
    let e = PageEdits { removed_annots: vec![0; MAX_INDEX_LIST + 1], ..Default::default() };
    assert_eq!(e.validate(), Err("Too many removed objects".into()));
    let e = PageEdits { removed_objects: vec![0; MAX_INDEX_LIST], ..Default::default() };
    assert!(e.validate().is_ok());
}

#[test]
fn page_edits_checks_every_block() {
    let e = PageEdits { blocks: vec![block(), TextBlock { size: 0.0, ..block() }], ..Default::default() };
    assert!(e.validate().is_err());
}

// ---------- Watermark ----------

#[test]
fn watermark_validate() {
    assert!(watermark().validate().is_ok());
    for w in [
        Watermark { size: 1.0, opacity: 0.0, angle: -360.0, ..watermark() },
        Watermark { size: 1000.0, opacity: 1.0, angle: 360.0, ..watermark() },
        Watermark { text: "é".repeat(500), ..watermark() },
    ] {
        assert!(w.validate().is_ok(), "{w:?}");
    }
    let text_err = Err("Watermark text must be 1–500 characters".to_string());
    assert_eq!(Watermark { text: String::new(), ..watermark() }.validate(), text_err);
    assert_eq!(Watermark { text: " \t\n ".into(), ..watermark() }.validate(), text_err);
    assert_eq!(Watermark { text: "a".repeat(501), ..watermark() }.validate(), text_err);
    let range_err = Err("Watermark settings are out of range".to_string());
    for w in [
        Watermark { size: 0.99, ..watermark() },
        Watermark { size: 1000.1, ..watermark() },
        Watermark { size: f32::NAN, ..watermark() },
        Watermark { opacity: -0.01, ..watermark() },
        Watermark { opacity: 1.01, ..watermark() },
        Watermark { opacity: f32::NAN, ..watermark() },
        Watermark { angle: 360.5, ..watermark() },
        Watermark { angle: f32::NEG_INFINITY, ..watermark() },
    ] {
        assert_eq!(w.validate(), range_err, "{w:?}");
    }
    let w = Watermark { font: FontSpec { family: "F".repeat(300), ..font() }, ..watermark() };
    assert_eq!(w.validate(), Err("Font family name is too long".into()));
}

// ---------- LayoutArgs ----------

#[test]
fn layout_args_validate() {
    assert!(layout_args().validate().is_ok());
    assert!(LayoutArgs { width: None, ..layout_args() }.validate().is_ok());
    assert!(LayoutArgs { text: String::new(), ..layout_args() }.validate().is_ok());
    assert!(LayoutArgs { text: "a\nb".into(), ..layout_args() }.validate().is_ok());

    let text_err = Err("Text is too long or not normalised".to_string());
    assert_eq!(LayoutArgs { text: "a\r\nb".into(), ..layout_args() }.validate(), text_err);
    assert_eq!(LayoutArgs { text: "a\rb".into(), ..layout_args() }.validate(), text_err);
    assert_eq!(LayoutArgs { text: "a".repeat(MAX_TEXT_CHARS + 1), ..layout_args() }.validate(), text_err);
    assert!(LayoutArgs { text: "a".repeat(MAX_TEXT_CHARS), ..layout_args() }.validate().is_ok());

    let range_err = Err("Layout settings are out of range".to_string());
    for a in [
        LayoutArgs { size: 0.4, ..layout_args() },
        LayoutArgs { size: 1001.0, ..layout_args() },
        LayoutArgs { size: f32::NAN, ..layout_args() },
        LayoutArgs { width: Some(0.5), ..layout_args() },
        LayoutArgs { width: Some(f32::INFINITY), ..layout_args() },
        LayoutArgs { indent: -5000.5, ..layout_args() },
        LayoutArgs { indent: f32::NAN, ..layout_args() },
        LayoutArgs { h_scale: 0.4, ..layout_args() },
        LayoutArgs { h_scale: 2.5, ..layout_args() },
    ] {
        assert_eq!(a.validate(), range_err, "{a:?}");
    }
    let a = LayoutArgs { font: FontSpec { family: "F".repeat(257), ..font() }, ..layout_args() };
    assert_eq!(a.validate(), Err("Font family name is too long".into()));
}

// ---------- Request::doc_ids ----------

fn page(doc_id: DocId) -> OutputPage {
    OutputPage { doc_id, page_index: 0, rotation: 0, edits: None }
}

#[test]
fn doc_ids_per_request() {
    assert!(Request::Open { doc_id: 3, password: None }.doc_ids().is_empty());
    assert!(Request::OpenShared { doc_id: 3, handle: 1, len: 1, password: None }.doc_ids().is_empty());
    assert!(Request::Close { doc_id: 3 }.doc_ids().is_empty());
    assert!(Request::Layout(layout_args()).doc_ids().is_empty());
    let render = Request::Render {
        doc_id: 4,
        page_index: 0,
        width: 100,
        format: ImageFormat::Png,
        rotation: 0,
        edits: None,
        watermark: None,
    };
    assert_eq!(render.doc_ids(), [4]);
    assert_eq!(Request::Extract { doc_id: 5, page_index: 1 }.doc_ids(), [5]);
    assert_eq!(Request::FindWatermarks { doc_id: 6, text: None }.doc_ids(), [6]);
    assert_eq!(Request::Annotations { doc_id: 7, first: 0, count: 1 }.doc_ids(), [7]);
    assert_eq!(Request::TextChars { doc_id: 8, page_index: 0 }.doc_ids(), [8]);
    assert_eq!(Request::Outline { doc_id: 9 }.doc_ids(), [9]);
}

// ---------- comments ----------

const DATE: &str = "D:20261126093000+07'00'";

fn new_annot(shape: AnnotShape) -> NewAnnot {
    NewAnnot {
        id: "a1".into(),
        shape,
        color: [255, 235, 59],
        opacity: 0.5,
        contents: "Note".into(),
        author: "Me".into(),
        date: DATE.into(),
    }
}

fn note() -> NewAnnot {
    new_annot(AnnotShape::Note { x: 10.0, y: 20.0 })
}

fn rect(x: f32, y: f32, width: f32, height: f32) -> Rect {
    Rect { x, y, width, height }
}

fn ink(strokes: Vec<Vec<Point>>, width: f32) -> NewAnnot {
    new_annot(AnnotShape::Ink { strokes, width })
}

#[test]
fn pdf_dates() {
    for ok in ["D:2026", "D:20261126093000Z", DATE, "D:20261126093000-05'00"] {
        assert!(validate_pdf_date(ok).is_ok(), "{ok}");
    }
    for bad in ["", "D:", "D:20x6", "2026112609", "D:2026 11", "D:2026é", &format!("D:{}", "1".repeat(31))] {
        assert!(validate_pdf_date(bad).is_err(), "{bad}");
    }
}

#[test]
fn new_annotations_validate() {
    assert!(note().validate().is_ok());
    let hl = new_annot(AnnotShape::Highlight { rects: vec![rect(1.0, 2.0, 30.0, 12.0)] });
    assert!(hl.validate().is_ok());
    let pts = vec![Point { x: 1.0, y: 1.0 }, Point { x: 5.0, y: 9.0 }];
    assert!(ink(vec![pts.clone()], 2.0).validate().is_ok());

    let bad = [
        NewAnnot { id: String::new(), ..note() },
        NewAnnot { id: "x".repeat(129), ..note() },
        NewAnnot { contents: "x".repeat(MAX_ANNOT_TEXT + 1), ..note() },
        NewAnnot { author: "x".repeat(257), ..note() },
        NewAnnot { opacity: 0.0, ..note() },
        NewAnnot { opacity: f32::NAN, ..note() },
        NewAnnot { date: "now".into(), ..note() },
        new_annot(AnnotShape::Note { x: f32::INFINITY, y: 0.0 }),
        new_annot(AnnotShape::Note { x: 0.0, y: 30_000.0 }),
        new_annot(AnnotShape::Highlight { rects: vec![] }),
        new_annot(AnnotShape::Highlight { rects: vec![rect(0.0, 0.0, -1.0, 5.0)] }),
        new_annot(AnnotShape::Highlight { rects: vec![rect(0.0, f32::NAN, 1.0, 5.0)] }),
        new_annot(AnnotShape::Highlight { rects: vec![rect(0.0, 0.0, 1.0, 1.0); 2001] }),
        ink(vec![], 2.0),
        ink(vec![vec![]], 2.0),
        ink(vec![pts.clone()], 0.0),
        ink(vec![pts.clone()], 500.0),
        ink(vec![vec![Point { x: f32::NAN, y: 0.0 }]], 2.0),
        ink(vec![vec![Point { x: 0.0, y: 0.0 }]; 501], 2.0),
        ink(vec![vec![Point { x: 0.0, y: 0.0 }; 25_001]; 2], 2.0),
    ];
    for (i, a) in bad.iter().enumerate() {
        assert!(a.validate().is_err(), "case {i}");
    }
}

#[test]
fn page_edits_validate_comments() {
    let with = |annotations: Vec<NewAnnot>, changed: Vec<AnnotChange>| PageEdits {
        annotations,
        changed_annots: changed,
        ..Default::default()
    };
    let change = |contents: String, date: &str| AnnotChange { index: 0, contents: Some(contents), at: None, date: date.into() };
    let moved = |x: f32, y: f32| AnnotChange { index: 0, contents: None, at: Some(Point { x, y }), date: DATE.into() };
    assert!(with(vec![note()], vec![change("new".into(), DATE)]).validate().is_ok());
    // A move alone (text untouched) is fine; a non-finite or far-off position is not.
    assert!(with(vec![], vec![moved(10.0, 20.0)]).validate().is_ok());
    assert!(with(vec![], vec![moved(f32::NAN, 0.0)]).validate().is_err());
    assert!(with(vec![], vec![moved(0.0, 1e9)]).validate().is_err());
    let parsed: AnnotChange = serde_json::from_str(r#"{"index":2,"at":{"x":1,"y":2},"date":"D:2026"}"#).unwrap();
    assert!(parsed.contents.is_none() && parsed.at == Some(Point { x: 1.0, y: 2.0 }));
    assert!(with(vec![NewAnnot { opacity: 2.0, ..note() }], vec![]).validate().is_err());
    assert!(with(vec![], vec![change("x".repeat(MAX_ANNOT_TEXT + 1), DATE)]).validate().is_err());
    assert!(with(vec![], vec![change("new".into(), "bad")]).validate().is_err());
    assert!(with(vec![note(); MAX_ANNOTS_PER_PAGE + 1], vec![]).validate().is_err());
    assert!(with(vec![], vec![change("a".into(), DATE); MAX_ANNOTS_PER_PAGE + 1]).validate().is_err());
    // Either list alone makes the edits non-empty.
    assert!(!with(vec![note()], vec![]).is_empty());
    assert!(!with(vec![], vec![change("a".into(), DATE)]).is_empty());
}

#[test]
fn new_annotations_use_the_ui_json_shape() {
    let v = json!({"id": "n", "kind": "ink", "strokes": [[{"x": 1, "y": 2}]], "width": 3,
                   "color": [1, 2, 3], "date": DATE});
    let a: NewAnnot = serde_json::from_value(v).unwrap();
    assert!(matches!(a.shape, AnnotShape::Ink { width, .. } if width == 3.0));
    assert_eq!((a.opacity, a.contents.as_str()), (1.0, ""), "defaults");
    let back = serde_json::to_value(&a).unwrap();
    assert_eq!(back["kind"], "ink");
    // Edits from older versions of the UI have no comment fields.
    let e: PageEdits = serde_json::from_value(json!({"removedObjects": [1]})).unwrap();
    assert!(e.annotations.is_empty() && e.changed_annots.is_empty());
}

#[test]
fn doc_ids_save_sorted_and_deduplicated() {
    let save = Request::Save {
        pages: vec![page(9), page(2), page(9), page(5), page(2)],
        watermark: None,
        sanitize: true,
        encrypt: None,
    };
    assert_eq!(save.doc_ids(), [2, 5, 9]);
    let empty = Request::Save { pages: vec![], watermark: None, sanitize: false, encrypt: None };
    assert!(empty.doc_ids().is_empty());
}

// ---------- framing (blocking) ----------

#[test]
fn frame_round_trip() {
    let mut buf = Vec::new();
    write_frame(&mut buf, b"{\"op\":\"close\"}", b"\x00\x01payload").unwrap();
    write_frame(&mut buf, b"", b"").unwrap();
    // [u32 LE header length][header][u32 LE payload length][payload]
    assert_eq!(&buf[..4], &14u32.to_le_bytes());
    assert_eq!(&buf[18..22], &9u32.to_le_bytes());
    let mut r = io::Cursor::new(buf);
    let (h, p) = read_frame(&mut r).unwrap();
    assert_eq!(h, b"{\"op\":\"close\"}");
    assert_eq!(p, b"\x00\x01payload");
    let (h, p) = read_frame(&mut r).unwrap();
    assert!(h.is_empty() && p.is_empty());
    // End of stream is an error (the worker treats it as "host closed the pipe").
    assert_eq!(read_frame(&mut r).unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
}

#[test]
fn frame_rejects_oversized_lengths() {
    let mut bytes = (MAX_HEADER_BYTES + 1).to_le_bytes().to_vec();
    bytes.extend_from_slice(b"junk");
    let err = read_frame(&mut io::Cursor::new(bytes)).unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);

    let mut bytes = 2u32.to_le_bytes().to_vec();
    bytes.extend_from_slice(b"{}");
    bytes.extend_from_slice(&(MAX_PAYLOAD_BYTES + 1).to_le_bytes());
    let err = read_frame(&mut io::Cursor::new(bytes)).unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);

    let bytes = u32::MAX.to_le_bytes().to_vec();
    assert_eq!(read_frame(&mut io::Cursor::new(bytes)).unwrap_err().kind(), io::ErrorKind::InvalidData);
}

#[test]
fn frame_truncated_is_an_error() {
    let mut buf = Vec::new();
    write_frame(&mut buf, b"header", b"payload").unwrap();
    for cut in [0, 3, 4, 9, 10, 13, buf.len() - 1] {
        let err = read_frame(&mut io::Cursor::new(&buf[..cut])).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof, "cut at {cut}");
    }
}

// ---------- framing (async) ----------

#[tokio::test]
async fn async_frame_round_trip_matches_blocking_format() {
    let mut buf: Vec<u8> = Vec::new();
    async_io::write_frame(&mut buf, b"hdr", b"body").await.unwrap();
    let mut sync_buf = Vec::new();
    write_frame(&mut sync_buf, b"hdr", b"body").unwrap();
    assert_eq!(buf, sync_buf);

    let mut r: &[u8] = &buf;
    let (h, p) = async_io::read_frame(&mut r).await.unwrap();
    assert_eq!(h, b"hdr");
    assert_eq!(p, b"body");
    let err = async_io::read_frame(&mut r).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);

    // A frame written by the blocking side is read by the async side.
    let mut sync_buf = Vec::new();
    write_frame(&mut sync_buf, b"{}", &[7u8; 1000]).unwrap();
    let mut r: &[u8] = &sync_buf;
    let (h, p) = async_io::read_frame(&mut r).await.unwrap();
    assert_eq!((h.len(), p.len()), (2, 1000));
}

#[tokio::test]
async fn async_frame_rejects_oversized_lengths() {
    let bytes = (MAX_HEADER_BYTES + 1).to_le_bytes();
    let mut r: &[u8] = &bytes;
    assert_eq!(async_io::read_frame(&mut r).await.unwrap_err().kind(), io::ErrorKind::InvalidData);

    let mut bytes = 0u32.to_le_bytes().to_vec();
    bytes.extend_from_slice(&(MAX_PAYLOAD_BYTES + 1).to_le_bytes());
    let mut r: &[u8] = &bytes;
    assert_eq!(async_io::read_frame(&mut r).await.unwrap_err().kind(), io::ErrorKind::InvalidData);
}

// ---------- JSON shape (must match src/lib/types.ts) ----------

#[test]
fn text_block_serializes_camel_case() {
    let v = serde_json::to_value(block()).unwrap();
    let obj = v.as_object().unwrap();
    let mut keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        ["align", "baseline", "color", "continues", "font", "hScale", "id", "indent", "lineHeight", "size", "text", "width", "x"]
    );
    assert_eq!(v["align"], "left");
    assert_eq!(v["font"], json!({"family": "Helvetica", "bold": false, "italic": false}));
    assert_eq!(v["color"], json!([0, 0, 0]));
}

#[test]
fn align_and_image_format_are_lowercase() {
    for (a, s) in [(Align::Left, "left"), (Align::Center, "center"), (Align::Right, "right"), (Align::Justify, "justify")] {
        assert_eq!(serde_json::to_value(a).unwrap(), json!(s));
        assert_eq!(serde_json::from_value::<Align>(json!(s)).unwrap(), a);
    }
    assert!(serde_json::from_value::<Align>(json!("Left")).is_err());
    assert_eq!(Align::default(), Align::Left);
    assert_eq!(serde_json::to_value(ImageFormat::Jpeg).unwrap(), json!("jpeg"));
    assert_eq!(serde_json::to_value(ImageFormat::Png).unwrap(), json!("png"));
}

#[test]
fn optional_fields_take_defaults() {
    // TS marks indent / hScale / continues optional; bold / italic default too.
    let b: TextBlock = serde_json::from_value(json!({
        "id": "n1", "x": 1, "baseline": 2, "width": null, "text": "t",
        "font": {"family": "Arial"}, "size": 10, "color": [1, 2, 3], "lineHeight": 1.2
    }))
    .unwrap();
    assert_eq!(b.align, Align::Left);
    assert_eq!(b.indent, 0.0);
    assert_eq!(b.h_scale, 1.0);
    assert!(!b.continues);
    assert!(b.width.is_none());
    assert!(!b.font.bold && !b.font.italic);

    let e: PageEdits = serde_json::from_value(json!({})).unwrap();
    assert!(e.is_empty());
    let e: PageEdits = serde_json::from_value(json!({"removedAnnots": [2]})).unwrap();
    assert!(e.removed_objects.is_empty() && e.blocks.is_empty());
    assert_eq!(e.removed_annots, [2]);

    let p: OutputPage = serde_json::from_value(json!({"docId": 1, "pageIndex": 0})).unwrap();
    assert_eq!(p.rotation, 0);
    assert!(p.edits.is_none());

    let l: LayoutArgs = serde_json::from_value(json!({
        "text": "x", "font": {"family": "Times", "bold": true, "italic": false}, "size": 9, "width": null
    }))
    .unwrap();
    assert_eq!((l.indent, l.h_scale), (0.0, 1.0));

    // A required field missing is an error, not a silent default.
    assert!(serde_json::from_value::<TextBlock>(json!({"id": "n"})).is_err());
    // snake_case keys are not accepted as the camelCase ones.
    let e: PageEdits = serde_json::from_value(json!({"removed_objects": [1]})).unwrap();
    assert!(e.removed_objects.is_empty());
}

#[test]
fn deserializes_page_edits_exactly_as_the_ui_sends_them() {
    // Written as src/lib/types.ts `PageEdits` / `TextBlock` serialise.
    let ui = r#"{
        "removedObjects": [3, 4],
        "removedAnnots": [],
        "blocks": [{
            "id": "p-0-2",
            "x": 72.5,
            "baseline": 120,
            "width": 300,
            "text": "Edited paragraph\nsecond line",
            "font": { "family": "Times New Roman", "bold": true, "italic": false },
            "size": 11,
            "color": [10, 20, 30],
            "lineHeight": 1.15,
            "align": "justify",
            "indent": 18,
            "hScale": 0.94,
            "continues": true
        }]
    }"#;
    let e: PageEdits = serde_json::from_str(ui).unwrap();
    assert_eq!(e.removed_objects, [3, 4]);
    let b = &e.blocks[0];
    assert_eq!(b.id, "p-0-2");
    assert_eq!(b.width, Some(300.0));
    assert_eq!(b.text, "Edited paragraph\nsecond line");
    assert_eq!(b.font, FontSpec { family: "Times New Roman".into(), bold: true, italic: false });
    assert_eq!(b.color, [10, 20, 30]);
    assert_eq!(b.line_height, 1.15);
    assert_eq!(b.align, Align::Justify);
    assert_eq!((b.indent, b.h_scale, b.continues), (18.0, 0.94, true));
    assert!(e.validate().is_ok());
}

#[test]
fn deserializes_watermark_layout_and_pages_as_the_ui_sends_them() {
    let w: Watermark = serde_json::from_str(
        r#"{"text":"CONFIDENTIAL","font":{"family":"Helvetica","bold":false,"italic":false},
            "size":60,"color":[200,0,0],"opacity":0.3,"angle":45}"#,
    )
    .unwrap();
    assert_eq!((w.size, w.opacity, w.angle), (60.0, 0.3, 45.0));
    assert!(w.validate().is_ok());

    // api.ts layoutText: { text, font, size, width, indent, hScale }
    let l: LayoutArgs = serde_json::from_str(
        r#"{"text":"Hello","font":{"family":"Arial","bold":false,"italic":true},
            "size":12,"width":220,"indent":0,"hScale":1}"#,
    )
    .unwrap();
    assert_eq!(l.width, Some(220.0));
    assert!(l.font.italic);
    assert!(l.validate().is_ok());

    // api.ts saveWithDialog pages: { docId, pageIndex, rotation, edits }
    let p: OutputPage =
        serde_json::from_str(r#"{"docId":7,"pageIndex":2,"rotation":270,"edits":null}"#).unwrap();
    assert_eq!((p.doc_id, p.page_index, p.rotation), (7, 2, 270));
    assert!(p.edits.is_none());
}

#[test]
fn results_serialize_with_ts_field_names() {
    let para = Paragraph {
        id: 1,
        object_indices: vec![0, 1],
        bounds: Rect { x: 1.0, y: 2.0, width: 3.0, height: 4.0 },
        text: "t".into(),
        font: font(),
        source_font: "ABCDEF+Helvetica".into(),
        size: 12.0,
        color: [0, 0, 0],
        line_height: 1.2,
        first_baseline: 10.0,
        align: Align::Center,
        wrap: true,
        line_count: 2,
        indent: 0.0,
        h_scale: 1.0,
        mixed_styles: false,
    };
    let loose = LooseText {
        object_index: 5,
        bounds: Rect { x: 0.0, y: 0.0, width: 1.0, height: 1.0 },
        text: "w".into(),
        rotated: true,
        transparent: false,
        watermark_mark: true,
    };
    let page = PageText { width: 612.0, height: 792.0, paragraphs: vec![para], loose: vec![loose] };
    let v = serde_json::to_value(&page).unwrap();
    let p = v["paragraphs"][0].as_object().unwrap();
    let mut keys: Vec<&str> = p.keys().map(|k| k.as_str()).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "align", "bounds", "color", "firstBaseline", "font", "hScale", "id", "indent", "lineCount",
            "lineHeight", "mixedStyles", "objectIndices", "size", "sourceFont", "text", "wrap"
        ]
    );
    assert_eq!(v["paragraphs"][0]["align"], "center");
    assert_eq!(v["paragraphs"][0]["bounds"], json!({"x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0}));
    let l = v["loose"][0].as_object().unwrap();
    let mut keys: Vec<&str> = l.keys().map(|k| k.as_str()).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["bounds", "objectIndex", "rotated", "text", "transparent", "watermarkMark"]);

    let scan = WatermarkScan {
        pages: vec![PageWatermarks { page_index: 1, objects: vec![2], annots: vec![] }],
        marked_objects: 1,
        annotations: 0,
        matching_text: 0,
    };
    assert_eq!(
        serde_json::to_value(&scan).unwrap(),
        json!({"pages": [{"pageIndex": 1, "objects": [2], "annots": []}],
               "markedObjects": 1, "annotations": 0, "matchingText": 0})
    );
    assert_eq!(serde_json::to_value(LayoutResult { line_starts: vec![0, 7] }).unwrap(), json!({"lineStarts": [0, 7]}));
    assert_eq!(serde_json::to_value(PageInfo { width: 1.0, height: 2.0 }).unwrap(), json!({"width": 1.0, "height": 2.0}));
}

#[test]
fn request_tags_use_op_names() {
    let cases = [
        (Request::Open { doc_id: 1, password: None }, json!({"op": "open", "docId": 1})),
        (
            Request::Open { doc_id: 1, password: Some("pw".into()) },
            json!({"op": "open", "docId": 1, "password": "pw"}),
        ),
        (
            Request::OpenShared { doc_id: 1, handle: 0x1a4, len: 4096, password: None },
            json!({"op": "openShared", "docId": 1, "handle": 0x1a4, "len": 4096}),
        ),
        (Request::Close { doc_id: 2 }, json!({"op": "close", "docId": 2})),
        (Request::Extract { doc_id: 3, page_index: 4 }, json!({"op": "extract", "docId": 3, "pageIndex": 4})),
        (
            Request::FindWatermarks { doc_id: 5, text: Some("x".into()) },
            json!({"op": "findWatermarks", "docId": 5, "text": "x"}),
        ),
    ];
    for (req, expected) in cases {
        assert_eq!(serde_json::to_value(&req).unwrap(), expected);
        let back: Request = serde_json::from_value(expected.clone()).unwrap();
        assert_eq!(serde_json::to_value(&back).unwrap(), expected);
    }

    let render: Request = serde_json::from_value(json!({
        "op": "render", "docId": 1, "pageIndex": 0, "width": 800, "format": "png",
        "edits": null, "watermark": null
    }))
    .unwrap();
    match render {
        Request::Render { rotation, format: ImageFormat::Png, width: 800, .. } => assert_eq!(rotation, 0),
        other => panic!("{other:?}"),
    }

    let save: Request = serde_json::from_value(json!({
        "op": "save", "pages": [{"docId": 1, "pageIndex": 0}], "watermark": null, "sanitize": true
    }))
    .unwrap();
    assert!(matches!(save, Request::Save { sanitize: true, encrypt: None, .. }));

    // Layout is a newtype variant: its fields sit next to the tag.
    let v = serde_json::to_value(Request::Layout(layout_args())).unwrap();
    assert_eq!(v["op"], "layout");
    assert_eq!(v["hScale"], 1.0);
    let back: Request = serde_json::from_value(v).unwrap();
    assert!(matches!(back, Request::Layout(a) if a.text == "Hello world"));

    assert!(serde_json::from_value::<Request>(json!({"op": "Open", "docId": 1})).is_err());
    assert!(serde_json::from_value::<Request>(json!({"op": "delete"})).is_err());
    assert!(serde_json::from_value::<Request>(json!({"docId": 1})).is_err());
}

#[test]
fn response_tag_is_status() {
    let ok = Response::Ok { result: json!([1, 2]) };
    assert_eq!(serde_json::to_value(&ok).unwrap(), json!({"status": "ok", "result": [1, 2]}));
    let err = Response::Err { message: "boom".into() };
    assert_eq!(serde_json::to_value(&err).unwrap(), json!({"status": "err", "message": "boom"}));
    // The worker's hard-coded fallback header must parse as a Response.
    let fallback: Response = serde_json::from_slice(b"{\"status\":\"err\",\"message\":\"encode\"}").unwrap();
    assert!(matches!(fallback, Response::Err { message } if message == "encode"));
}

// ---------- Outline ----------

fn outline_item(depth: u32) -> OutlineItem {
    OutlineItem { title: "Intro".into(), depth, page_index: Some(0), y: Some(10.0), open: true }
}

#[test]
fn outline_validate() {
    let ok = Outline { items: vec![outline_item(0), outline_item(MAX_OUTLINE_DEPTH)], truncated: false };
    assert!(ok.validate().is_ok());
    assert!(Outline::default().validate().is_ok());
    let bad = |it: OutlineItem| Outline { items: vec![it], truncated: false }.validate().is_err();
    assert!(bad(outline_item(MAX_OUTLINE_DEPTH + 1)));
    assert!(bad(OutlineItem { title: "x".repeat(MAX_OUTLINE_TITLE + 1), ..outline_item(0) }));
    assert!(bad(OutlineItem { page_index: Some(-1), ..outline_item(0) }));
    assert!(bad(OutlineItem { y: Some(f32::NAN), ..outline_item(0) }));
    assert!(bad(OutlineItem { y: Some(1e9), ..outline_item(0) }));
    // A title at the limit counts characters, not bytes.
    assert!(!bad(OutlineItem { title: "ệ".repeat(MAX_OUTLINE_TITLE), page_index: None, y: None, ..outline_item(0) }));
    let many = Outline { items: vec![outline_item(0); MAX_OUTLINE_ITEMS + 1], truncated: true };
    assert!(many.validate().is_err());
}

#[test]
fn outline_uses_the_ui_json_shape() {
    let v = serde_json::to_value(Outline { items: vec![outline_item(1)], truncated: true }).unwrap();
    assert_eq!(
        v,
        serde_json::json!({ "items": [{ "title": "Intro", "depth": 1, "pageIndex": 0, "y": 10.0, "open": true }], "truncated": true })
    );
}

// ---------- passwords ----------

#[test]
fn passwords_are_checked() {
    assert!(validate_password("open sesame").is_ok());
    assert!(validate_password(&"x".repeat(MAX_PASSWORD_BYTES)).is_ok());
    assert_eq!(validate_password("").unwrap_err(), "Enter the password.");
    assert!(validate_password(&"x".repeat(MAX_PASSWORD_BYTES + 1)).is_err());
    // PDFium reads a C string: a NUL would cut the password short.
    assert!(validate_password("ab\0cd").is_err());
}

#[test]
fn encrypt_settings_are_checked_and_never_printed() {
    let good = Encrypt { password: "pw".into(), key: vec![7; 32] };
    assert!(good.validate().is_ok());
    assert!(Encrypt { password: String::new(), key: vec![7; 32] }.validate().is_err());
    assert_eq!(Encrypt { password: "pw".into(), key: vec![7; 31] }.validate().unwrap_err(), "The encryption key is invalid.");
    assert_eq!(format!("{good:?}"), "Encrypt { .. }");

    // On the wire: the save request carries it only when set.
    let save = Request::Save { pages: vec![], watermark: None, sanitize: true, encrypt: Some(good) };
    let v = serde_json::to_value(&save).unwrap();
    assert_eq!(v["encrypt"]["password"], "pw");
    assert_eq!(v["encrypt"]["key"].as_array().unwrap().len(), 32);
    let back: Request = serde_json::from_value(v).unwrap();
    assert!(matches!(back, Request::Save { encrypt: Some(_), .. }));
    let plain = serde_json::to_value(Request::Save { pages: vec![], watermark: None, sanitize: true, encrypt: None }).unwrap();
    assert!(plain.get("encrypt").is_none());
}
