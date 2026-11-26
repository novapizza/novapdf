use super::*;

#[test]
fn listed_subtypes_skip_links_popups_widgets_and_watermarks() {
    assert_eq!(subtype_name(FPDF_ANNOT_TEXT), Some("Text"));
    assert_eq!(subtype_name(FPDF_ANNOT_HIGHLIGHT), Some("Highlight"));
    assert_eq!(subtype_name(FPDF_ANNOT_INK), Some("Ink"));
    for not_a_comment in [2, 16, 20, 24, 0, 99] {
        assert_eq!(subtype_name(not_a_comment), None, "subtype {not_a_comment}");
    }
}

#[test]
fn comments_must_lie_on_the_page() {
    use crate::protocol::{Point, Rect};
    let page = (600.0, 800.0);
    let note = |x, y| AnnotShape::Note { x, y };
    assert_eq!(shape_bounds(&note(10.0, 20.0)), (10.0, 20.0, 30.0, 40.0));
    assert!(on_page(shape_bounds(&note(0.0, 0.0)), page));
    assert!(on_page(shape_bounds(&note(580.5, 780.5)), page), "rounding slack at the edge");
    assert!(!on_page(shape_bounds(&note(590.0, 10.0)), page), "sticks out on the right");
    assert!(!on_page(shape_bounds(&note(-5.0, 10.0)), page));
    assert!(!on_page(shape_bounds(&note(10.0, 5000.0)), page));

    let hl = AnnotShape::Highlight {
        rects: vec![Rect { x: 50.0, y: 60.0, width: 100.0, height: 12.0 }, Rect { x: 40.0, y: 80.0, width: 20.0, height: 12.0 }],
    };
    assert_eq!(shape_bounds(&hl), (40.0, 60.0, 150.0, 92.0));
    let ink = |pts: &[(f32, f32)]| AnnotShape::Ink {
        strokes: vec![pts.iter().map(|&(x, y)| Point { x, y }).collect()],
        width: 2.0,
    };
    assert_eq!(shape_bounds(&ink(&[(5.0, 9.0), (1.0, 20.0)])), (1.0, 9.0, 5.0, 20.0));
    assert!(!on_page(shape_bounds(&ink(&[(5.0, 9.0), (700.0, 20.0)])), page));
}

#[test]
fn cut_counts_characters_not_bytes() {
    assert_eq!(cut("héllo".into(), 10), ("héllo".to_string(), false));
    assert_eq!(cut("héllo".into(), 2), ("hé".to_string(), true));
    assert_eq!(cut("abc".into(), 3), ("abc".to_string(), false));
    assert_eq!(cut(String::new(), 0), (String::new(), false));
}

#[test]
fn clean_text_drops_control_characters_but_keeps_line_breaks() {
    assert_eq!(clean_text("a\r\nb\u{0}c\td\u{7}\n"), "a\nbc\td\n");
    assert_eq!(clean_text("lone\rreturn"), "lone\nreturn");
}

#[test]
fn rich_text_escapes_markup_and_splits_paragraphs() {
    let rc = rich_text("a <b> & \"c\"\nsecond");
    assert!(rc.starts_with("<?xml"), "{rc}");
    assert!(rc.contains("<p>a &lt;b&gt; &amp; &quot;c&quot;</p><p>second</p>"), "{rc}");
    assert!(rc.ends_with("</body>"));
}

#[test]
fn bounds_track_min_and_max() {
    let mut b = Bounds::default();
    assert_eq!(b.get(), (0.0, 0.0, 0.0, 0.0));
    b.add((10.0, 5.0));
    b.add((2.0, 8.0));
    b.add((4.0, -1.0));
    assert_eq!(b.get(), (2.0, -1.0, 10.0, 8.0));
}

#[test]
fn rect_of_rounds_to_hundredths() {
    let r = rect_of(1.004, 2.0, 11.0161, 7.5);
    assert_eq!((r.x, r.y, r.width, r.height), (1.0, 2.0, 10.01, 5.5));
}
