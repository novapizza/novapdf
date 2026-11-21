//! Unit tests for `worker/extract.rs`. Kept in their own file so coverage reports can exclude test code.

use super::*;

/// An upright Helvetica run: `width` wide, glyph box from 0.75·size above the
/// baseline to 0.25·size below it.
fn run(index: u32, text: &str, ox: f32, baseline: f32, width: f32, size: f32) -> TextObj {
    TextObj {
        index,
        text: text.into(),
        ox,
        baseline,
        x0: ox,
        y0: baseline - 0.75 * size,
        x1: ox + width,
        y1: baseline + 0.25 * size,
        size,
        upright: true,
        invisible: false,
        transparent: false,
        watermark_mark: false,
        font_name: "Helvetica".into(),
        font_spec: FontSpec { family: "Helvetica".into(), bold: false, italic: false },
        font_flags: 0,
        color: [0, 0, 0],
    }
}

/// One run per line, all 12 pt, given as (text, x0, x1, baseline).
fn lines_of(spec: &[(&str, f32, f32, f32)]) -> Vec<TextObj> {
    spec.iter()
        .enumerate()
        .map(|(i, &(t, x0, x1, base))| run(i as u32, t, x0, base, x1 - x0, 12.0))
        .collect()
}

fn texts(lines: &[Line]) -> Vec<&str> {
    lines.iter().map(|l| l.text.as_str()).collect()
}

fn paragraphs(items: &[TextObj]) -> (Vec<Line>, Vec<Vec<usize>>) {
    let lines = build_lines(items);
    let groups = group_paragraphs(&lines, items);
    (lines, groups)
}

/// Builds the single paragraph the items form (asserts there is exactly one).
fn paragraph(items: &[TextObj]) -> Paragraph {
    let (lines, groups) = paragraphs(items);
    assert_eq!(groups.len(), 1, "expected one paragraph, got {groups:?}");
    let mut fonts = Fonts::new();
    make_paragraph(0, &groups[0], &lines, items, &mut fonts).0
}

// ---------- normalize_text / collapse_spaces ----------

#[test]
fn normalize_maps_odd_whitespace_to_spaces() {
    assert_eq!(normalize_text("a\u{A0}b\u{2003}c\u{202F}d\u{205F}e\u{3000}f"), "a b c d e f");
    assert_eq!(normalize_text("a\tb\rc\nd"), "a b c d");
    assert_eq!(normalize_text("\u{2000}\u{200A}"), "  ");
}

#[test]
fn normalize_drops_invisible_and_control_characters() {
    assert_eq!(normalize_text("zero\u{200B}width\u{FEFF}"), "zerowidth");
    assert_eq!(normalize_text("a\u{0}b\u{7}c\u{1B}d\u{7F}e\u{85}f"), "abcdef");
    assert_eq!(normalize_text("\u{FFFE}\u{FFFF}x"), "x");
}

#[test]
fn normalize_keeps_ordinary_text() {
    let s = "Xin ch\u{E0}o Vi\u{1EC7}t Nam \u{2014} \u{65E5}\u{672C} \u{1F600}";
    assert_eq!(normalize_text(s), s);
    assert_eq!(normalize_text(""), "");
}

#[test]
fn collapse_spaces_merges_runs_of_spaces_only() {
    assert_eq!(collapse_spaces("a  b   c"), "a b c");
    assert_eq!(collapse_spaces("  lead"), " lead");
    assert_eq!(collapse_spaces("tab\t\tkept"), "tab\t\tkept");
    assert_eq!(collapse_spaces(""), "");
}

// ---------- build_lines ----------

#[test]
fn no_items_no_lines() {
    assert!(build_lines(&[]).is_empty());
}

#[test]
fn runs_on_a_baseline_join_in_x_order() {
    // Given right-to-left on purpose.
    let items = [run(0, "world", 110.0, 100.0, 30.0, 12.0), run(1, "Hello", 72.0, 100.0, 30.0, 12.0)];
    let lines = build_lines(&items);
    assert_eq!(texts(&lines), ["Hello world"]);
    let l = &lines[0];
    assert_eq!(l.items, [1, 0]);
    assert_eq!((l.x0, l.x1), (72.0, 140.0));
    assert_eq!((l.top, l.bottom), (91.0, 103.0));
    assert_eq!((l.baseline, l.size), (100.0, 12.0));
    assert!(!l.mixed);
}

#[test]
fn small_gaps_do_not_insert_spaces() {
    // 0.5 pt is kerning, not a word gap (threshold 0.18 em).
    let items = [run(0, "Hel", 72.0, 100.0, 20.0, 12.0), run(1, "lo", 92.5, 100.0, 10.0, 12.0)];
    assert_eq!(texts(&build_lines(&items)), ["Hello"]);
    // A run that already carries the space does not get a second one.
    let items = [run(0, "Hello ", 72.0, 100.0, 30.0, 12.0), run(1, "world", 110.0, 100.0, 30.0, 12.0)];
    assert_eq!(texts(&build_lines(&items)), ["Hello world"]);
    let items = [run(0, "Hello", 72.0, 100.0, 30.0, 12.0), run(1, "  world  ", 110.0, 100.0, 30.0, 12.0)];
    assert_eq!(texts(&build_lines(&items)), ["Hello world"]);
}

#[test]
fn wide_gaps_split_columns() {
    // Gap of 1.2 em (14.4 pt) or more starts a new line segment.
    let items = [run(0, "Left", 72.0, 100.0, 30.0, 12.0), run(1, "Right", 117.0, 100.0, 30.0, 12.0)];
    assert_eq!(texts(&build_lines(&items)), ["Left", "Right"]);
    let items = [run(0, "Left", 72.0, 100.0, 30.0, 12.0), run(1, "Right", 116.0, 100.0, 30.0, 12.0)];
    assert_eq!(texts(&build_lines(&items)), ["Left Right"]);
}

#[test]
fn baseline_tolerance_is_three_tenths_of_an_em() {
    let items = [run(0, "a", 72.0, 100.0, 6.0, 12.0), run(1, "b", 80.0, 103.0, 6.0, 12.0)];
    assert_eq!(build_lines(&items).len(), 1);
    let items = [run(0, "a", 72.0, 100.0, 6.0, 12.0), run(1, "b", 80.0, 104.0, 6.0, 12.0)];
    let lines = build_lines(&items);
    assert_eq!(texts(&lines), ["a", "b"]);
    // Lines come out top to bottom regardless of input order.
    let items = [run(0, "low", 72.0, 300.0, 20.0, 12.0), run(1, "high", 72.0, 100.0, 20.0, 12.0)];
    assert_eq!(texts(&build_lines(&items)), ["high", "low"]);
}

#[test]
fn dominant_style_covers_most_characters() {
    let items = [run(0, "Hi", 72.0, 100.0, 12.0, 12.0), run(1, "much longer text", 86.0, 100.0, 60.0, 8.0)];
    let lines = build_lines(&items);
    assert_eq!(lines.len(), 1);
    let l = &lines[0];
    assert_eq!(l.style, 1);
    assert_eq!(l.size, 8.0);
    assert!(l.mixed);
}

#[test]
fn near_identical_styles_are_not_mixed() {
    let mut b = run(1, "world", 110.0, 100.0, 30.0, 12.5);
    b.color = [20, 20, 20];
    let items = [run(0, "Hello", 72.0, 100.0, 30.0, 12.0), b];
    assert!(!build_lines(&items)[0].mixed);
    let mut c = run(1, "world", 110.0, 100.0, 30.0, 12.0);
    c.color = [200, 0, 0];
    let items = [run(0, "Hello", 72.0, 100.0, 30.0, 12.0), c];
    assert!(build_lines(&items)[0].mixed, "red word in black text");
    let mut d = run(1, "world", 110.0, 100.0, 30.0, 12.0);
    d.font_name = "Helvetica-Bold".into();
    let items = [run(0, "Hello", 72.0, 100.0, 30.0, 12.0), d];
    assert!(build_lines(&items)[0].mixed, "bold word");
}

#[test]
fn trailing_spaces_are_trimmed_and_inner_ones_collapsed() {
    let items = [run(0, "a  b   ", 72.0, 100.0, 30.0, 12.0)];
    assert_eq!(texts(&build_lines(&items)), ["a b"]);
}

// ---------- group_paragraphs ----------

#[test]
fn evenly_spaced_aligned_lines_form_one_paragraph() {
    let items = lines_of(&[
        ("one", 72.0, 372.0, 100.0),
        ("two", 72.0, 372.0, 114.0),
        ("three", 72.0, 200.0, 128.0),
    ]);
    let (_, groups) = paragraphs(&items);
    assert_eq!(groups, [vec![0, 1, 2]]);
}

#[test]
fn a_larger_gap_starts_a_new_paragraph() {
    let items = lines_of(&[
        ("one", 72.0, 372.0, 100.0),
        ("two", 72.0, 372.0, 114.0),
        ("next", 72.0, 372.0, 144.0),
    ]);
    let (_, groups) = paragraphs(&items);
    assert_eq!(groups, [vec![0, 1], vec![2]]);
    // After a single line, 1.6 em is the most that still joins.
    let items = lines_of(&[("title", 72.0, 372.0, 100.0), ("body", 72.0, 372.0, 120.0)]);
    assert_eq!(paragraphs(&items).1.len(), 2);
    let items = lines_of(&[("title", 72.0, 372.0, 100.0), ("body", 72.0, 372.0, 119.0)]);
    assert_eq!(paragraphs(&items).1.len(), 1);
}

#[test]
fn uneven_spacing_breaks_the_paragraph() {
    // Spacing set to 14 by the first pair; 20 later differs by more than 0.2 em.
    let items = lines_of(&[
        ("one", 72.0, 372.0, 100.0),
        ("two", 72.0, 372.0, 114.0),
        ("far", 72.0, 372.0, 134.0),
    ]);
    assert_eq!(paragraphs(&items).1, [vec![0, 1], vec![2]]);
}

#[test]
fn different_styles_do_not_join() {
    let mut items = lines_of(&[("heading", 72.0, 372.0, 100.0), ("body", 72.0, 372.0, 114.0)]);
    items[0].font_name = "Helvetica-Bold".into();
    assert_eq!(paragraphs(&items).1.len(), 2);
}

#[test]
fn columns_stay_separate() {
    let items = lines_of(&[
        ("L1", 72.0, 272.0, 100.0),
        ("R1", 320.0, 520.0, 100.0),
        ("L2", 72.0, 272.0, 114.0),
        ("R2", 320.0, 520.0, 114.0),
    ]);
    let (lines, groups) = paragraphs(&items);
    assert_eq!(groups.len(), 2);
    for g in &groups {
        let t: Vec<&str> = g.iter().map(|&i| lines[i].text.as_str()).collect();
        assert!(t == ["L1", "L2"] || t == ["R1", "R2"], "{t:?}");
    }
}

#[test]
fn indented_first_line_joins_its_paragraph() {
    // Ragged right and not centred: only the first-line-indent rule can join these.
    let items = lines_of(&[("indented", 90.0, 372.0, 100.0), ("body", 72.0, 350.0, 114.0)]);
    assert_eq!(paragraphs(&items).1.len(), 1);
    // Outdented by more than the left tolerance after two lines: a new paragraph.
    let items = lines_of(&[
        ("a", 72.0, 372.0, 100.0),
        ("b", 72.0, 372.0, 114.0),
        ("c", 100.0, 300.0, 128.0),
    ]);
    assert_eq!(paragraphs(&items).1.len(), 2);
}

// ---------- make_paragraph ----------

#[test]
fn justified_paragraph() {
    let p = paragraph(&lines_of(&[
        ("The quick brown", 72.0, 372.0, 100.0),
        ("fox jumps over", 72.0, 372.0, 114.0),
        ("the dog.", 72.0, 200.0, 128.0),
    ]));
    assert_eq!(p.align, Align::Justify);
    assert_eq!(p.text, "The quick brown fox jumps over the dog.");
    assert_eq!(p.object_indices, [0, 1, 2]);
    assert_eq!((p.line_count, p.wrap, p.indent), (3, true, 0.0));
    assert!((p.line_height - 14.0 / 12.0).abs() < 1e-4);
    assert_eq!(p.first_baseline, 100.0);
    assert_eq!((p.bounds.x, p.bounds.width), (72.0, 300.0));
    assert_eq!((p.bounds.y, p.bounds.height), (91.0, 40.0));
    assert_eq!(p.font.family, "Helvetica");
    assert_eq!(p.source_font, "Helvetica");
    assert_eq!((p.size, p.h_scale, p.mixed_styles), (12.0, 1.0, false));
}

#[test]
fn two_line_justify_needs_a_short_last_line() {
    let p = paragraph(&lines_of(&[("aaaa", 72.0, 372.0, 100.0), ("bb", 72.0, 200.0, 114.0)]));
    assert_eq!(p.align, Align::Justify);
    let p = paragraph(&lines_of(&[("aaaa", 72.0, 372.0, 100.0), ("bbbb", 72.0, 372.0, 114.0)]));
    assert_eq!(p.align, Align::Left);
}

#[test]
fn ragged_right_is_left_aligned() {
    let p = paragraph(&lines_of(&[
        ("a", 72.0, 372.0, 100.0),
        ("b", 72.0, 300.0, 114.0),
        ("c", 72.0, 350.0, 128.0),
    ]));
    assert_eq!(p.align, Align::Left);
}

#[test]
fn centered_and_right_aligned() {
    let p = paragraph(&lines_of(&[("wide line", 200.0, 400.0, 100.0), ("short", 250.0, 350.0, 114.0)]));
    assert_eq!(p.align, Align::Center);
    assert_eq!(p.indent, 0.0);
    let p = paragraph(&lines_of(&[("wide line", 200.0, 400.0, 100.0), ("short", 300.0, 400.0, 114.0)]));
    assert_eq!(p.align, Align::Right);
}

#[test]
fn first_line_indent_is_measured() {
    let p = paragraph(&lines_of(&[
        ("Indented", 90.0, 372.0, 100.0),
        ("body", 72.0, 372.0, 114.0),
        ("end", 72.0, 250.0, 128.0),
    ]));
    assert_eq!(p.indent, 18.0);
    assert_eq!(p.align, Align::Justify);
    assert_eq!(p.bounds.x, 72.0);
}

#[test]
fn hyphenated_lines_join_without_a_space() {
    let p = paragraph(&lines_of(&[("an exam-", 72.0, 372.0, 100.0), ("ple here", 72.0, 200.0, 114.0)]));
    assert_eq!(p.text, "an exam-ple here");
}

#[test]
fn single_line_defaults() {
    let p = paragraph(&lines_of(&[("Alone", 72.0, 150.0, 100.0)]));
    assert_eq!(p.align, Align::Left);
    assert_eq!((p.line_count, p.wrap, p.indent, p.line_height), (1, false, 0.0, 1.2));
}

#[test]
fn mixed_styles_are_reported() {
    let mut items = vec![
        run(0, "Regular text and", 72.0, 100.0, 100.0, 12.0),
        run(1, "bold", 176.0, 100.0, 25.0, 12.0),
    ];
    items[1].font_name = "Helvetica-Bold".into();
    let p = paragraph(&items);
    assert!(p.mixed_styles);
    assert_eq!(p.text, "Regular text and bold");
    assert_eq!(p.source_font, "Helvetica", "dominant style wins");
}
