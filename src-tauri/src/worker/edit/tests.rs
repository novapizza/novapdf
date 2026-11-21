//! Unit tests for `worker/edit.rs`. Kept in their own file so coverage reports can exclude test code.

use super::*;

fn mono(s: &str) -> f32 {
    s.chars().count() as f32
}

#[test]
fn wraps_between_words() {
    let lines = layout("the quick brown fox", Some(10.0), 0.0, &mut mono);
    let texts: Vec<_> = lines.iter().map(|l| l.text.as_str()).collect();
    assert_eq!(texts, ["the quick", "brown fox"]);
}

#[test]
fn keeps_hard_breaks_and_splits_long_words() {
    let lines = layout("ab\nabcdefghij", Some(4.0), 0.0, &mut mono);
    let texts: Vec<_> = lines.iter().map(|l| l.text.as_str()).collect();
    assert_eq!(texts, ["ab", "abcd", "efgh", "ij"]);
}

#[test]
fn records_line_starts() {
    let text = "the quick brown fox\nab abcdefghij";
    let lines = layout(text, Some(10.0), 0.0, &mut mono);
    let texts: Vec<_> = lines.iter().map(|l| l.text.as_str()).collect();
    assert_eq!(texts, ["the quick", "brown fox", "ab", "abcdefghij"]);
    for l in &lines {
        assert!(text[l.start..].starts_with(&l.text), "{:?} at {}", l.text, l.start);
    }
    let lines = layout("abcdefghij", Some(4.0), 0.0, &mut mono);
    let starts: Vec<_> = lines.iter().map(|l| l.start).collect();
    assert_eq!(starts, [0, 4, 8]);
}

#[test]
fn line_starts_count_characters() {
    let text = "ééé ééé";
    let lines = layout(text, Some(3.0), 0.0, &mut mono);
    assert_eq!(line_starts_in_chars(text, &lines), [0, 4]);
}

#[test]
fn first_line_indent_narrows_each_paragraph() {
    let lines = layout("aa bb cc\naa bb cc", Some(8.0), 3.0, &mut mono);
    let texts: Vec<_> = lines.iter().map(|l| l.text.as_str()).collect();
    assert_eq!(texts, ["aa bb", "cc", "aa bb", "cc"]);
}

#[test]
fn no_wrap_without_width() {
    let lines = layout("a very long line", None, 0.0, &mut mono);
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].width, 16.0);
}

#[test]
fn render_size_is_bounded() {
    assert_eq!(render_size(612.0, 792.0, 100_000).0, MAX_RENDER_WIDTH);
    let (_, h) = render_size(10.0, 100_000.0, 4000);
    assert!(h <= MAX_RENDER_HEIGHT);
}

mod more_tests {
    use super::super::*;

    /// Every character is one unit wide.
    fn mono(s: &str) -> f32 {
        s.chars().count() as f32
    }

    fn lay(text: &str, wrap: Option<f32>, indent: f32) -> (Vec<String>, Vec<usize>) {
        let lines = layout(text, wrap, indent, &mut mono);
        (lines.iter().map(|l| l.text.clone()).collect(), lines.iter().map(|l| l.start).collect())
    }

    // ---------- layout ----------

    #[test]
    fn empty_text_is_one_empty_line() {
        for wrap in [None, Some(10.0)] {
            let lines = layout("", wrap, 0.0, &mut mono);
            assert_eq!(lines, [LaidLine { text: String::new(), width: 0.0, start: 0 }]);
        }
    }

    #[test]
    fn blank_lines_and_trailing_spaces() {
        assert_eq!(lay("a\n\nb", None, 0.0), (vec!["a".into(), "".into(), "b".into()], vec![0, 2, 3]));
        let lines = layout("abc   ", None, 0.0, &mut mono);
        assert_eq!((lines[0].text.as_str(), lines[0].width), ("abc", 3.0));
        assert_eq!(lay("x\n", Some(5.0), 0.0).0, ["x", ""]);
    }

    #[test]
    fn exact_fit_does_not_wrap() {
        assert_eq!(lay("ab cd", Some(5.0), 0.0).0, ["ab cd"]);
        assert_eq!(lay("ab cd", Some(4.9), 0.0).0, ["ab", "cd"]);
    }

    #[test]
    fn runs_of_spaces_at_a_break_are_dropped() {
        let (texts, starts) = lay("aa   bb", Some(2.0), 0.0);
        assert_eq!(texts, ["aa", "bb"]);
        assert_eq!(starts, [0, 5]);
    }

    #[test]
    fn long_word_after_a_short_one() {
        let (texts, starts) = lay("ab cdefgh", Some(4.0), 0.0);
        assert_eq!(texts, ["ab", "cdef", "gh"]);
        assert_eq!(starts, [0, 3, 7]);
    }

    #[test]
    fn splits_multibyte_words_on_character_boundaries() {
        let text = "\u{E9}\u{E9}\u{E9}\u{E9}\u{E9}";
        let lines = layout(text, Some(2.0), 0.0, &mut mono);
        let starts: Vec<usize> = lines.iter().map(|l| l.start).collect();
        assert_eq!(starts, [0, 4, 8], "byte offsets");
        assert_eq!(line_starts_in_chars(text, &lines), [0, 2, 4]);

        let emoji = "\u{1F600}\u{1F600}\u{1F600}";
        let lines = layout(emoji, Some(1.0), 0.0, &mut mono);
        assert_eq!(lines.len(), 3);
        assert_eq!(line_starts_in_chars(emoji, &lines), [0, 1, 2]);
    }

    #[test]
    fn line_starts_count_characters_across_words_and_newlines() {
        // CJK: three bytes per character.
        let text = "\u{65E5}\u{672C} \u{8A9E}\u{5B66}\n\u{6587}";
        let lines = layout(text, Some(2.0), 0.0, &mut mono);
        assert_eq!(lines.len(), 3);
        assert_eq!(line_starts_in_chars(text, &lines), [0, 3, 6]);
        assert!(line_starts_in_chars(text, &[]).is_empty());
    }

    #[test]
    fn indent_wider_than_the_box_still_terminates() {
        let (texts, starts) = lay("abc def", Some(4.0), 10.0);
        assert_eq!(texts, ["a", "bc", "def"]);
        assert_eq!(starts, [0, 1, 4]);
    }

    #[test]
    fn negative_indent_widens_the_first_line() {
        // A hanging indent: the first line may be wider than the rest.
        assert_eq!(lay("aaa bbb ccc", Some(5.0), -3.0).0, ["aaa bbb", "ccc"]);
    }

    #[test]
    fn layout_invariants_hold_for_many_widths() {
        let text = "The  quick brown fox\njumps over\n\n the lazy dog. Supercalifragilistic word, Vi\u{1EC7}t Nam \u{65E5}\u{672C}\u{8A9E}.";
        let non_space: String = text.chars().filter(|c| !c.is_whitespace()).collect();
        for indent in [0.0, 3.0, -2.0] {
            for w in 1..=30 {
                let lines = layout(text, Some(w as f32), indent, &mut mono);
                let mut prev = 0;
                for (i, l) in lines.iter().enumerate() {
                    assert!(l.start >= prev, "w={w}: starts go backwards at line {i}");
                    assert!(text.is_char_boundary(l.start), "w={w}: start inside a character");
                    assert!(text[l.start..].starts_with(&l.text), "w={w}: {:?} not at {}", l.text, l.start);
                    assert_eq!(l.width, mono(&l.text));
                    prev = l.start;
                }
                // No character is lost or duplicated.
                let joined: String = lines.iter().flat_map(|l| l.text.chars()).filter(|c| !c.is_whitespace()).collect();
                assert_eq!(joined, non_space, "w={w} indent={indent}");
                // Every line fits unless it is a single character.
                for (i, l) in lines.iter().enumerate() {
                    let limit = if starts_paragraph(text, &lines, i) { w as f32 - indent } else { w as f32 };
                    assert!(l.width <= limit.max(1.0), "w={w} indent={indent}: {:?} too wide", l.text);
                }
                let chars = line_starts_in_chars(text, &lines);
                assert_eq!(chars.len(), lines.len());
            }
        }
    }

    #[test]
    fn starts_paragraph_after_newlines_only() {
        let text = "aa bb\ncc";
        let lines = layout(text, Some(2.0), 0.0, &mut mono);
        assert_eq!(lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), ["aa", "bb", "cc"]);
        assert!(starts_paragraph(text, &lines, 0));
        assert!(!starts_paragraph(text, &lines, 1), "a wrapped line");
        assert!(starts_paragraph(text, &lines, 2), "after an explicit newline");
    }

    // ---------- fallback_warnings ----------

    #[test]
    fn fallback_warnings_list_one_based_sorted_pages() {
        assert!(fallback_warnings(&HashSet::new()).is_empty());
        let one = fallback_warnings(&HashSet::from([4]));
        assert_eq!(
            one,
            ["Page 5 could not be edited in place, so its content was rewritten. Check its layout and spacing."]
        );
        let many = fallback_warnings(&HashSet::from([9, 0, 2]));
        assert_eq!(many.len(), 1);
        assert!(many[0].starts_with("Page 1, 3, 10 could not be edited"), "{}", many[0]);
    }

    // ---------- rendering helpers ----------

    #[test]
    fn render_size_keeps_aspect_and_bounds() {
        assert_eq!(render_size(612.0, 792.0, 612), (612, 792));
        assert_eq!(render_size(792.0, 612.0, 792), (792, 612));
        assert_eq!(render_size(612.0, 792.0, 0).0, 16, "minimum width");
        assert_eq!(render_size(612.0, 792.0, -50).0, 16);
        // A degenerate page width falls back to A4 proportions.
        assert_eq!(render_size(0.0, 792.0, 100), (100, 141));
        // Very tall pages are capped in height and narrowed to keep the aspect ratio.
        let (w, h) = render_size(100.0, 10_000.0, 1000);
        assert_eq!((w, h), (60, MAX_RENDER_HEIGHT));
        // Never zero, even for absurd aspect ratios.
        let (w, h) = render_size(1.0, 1e9, 16);
        assert!(w >= 1 && (1..=MAX_RENDER_HEIGHT).contains(&h));
        let (w, h) = render_size(1e9, 1.0, 4000);
        assert_eq!((w, h), (4000, 1));
    }

    #[test]
    fn encode_produces_decodable_images() {
        // 2x1 RGBA: red, then blue. Alpha is dropped.
        let rgba = vec![255, 0, 0, 255, 0, 0, 255, 0];
        let png = encode(rgba, 2, 1, ImageFormat::Png).unwrap();
        assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
        let img = image::load_from_memory(&png).unwrap().to_rgb8();
        assert_eq!(img.dimensions(), (2, 1));
        assert_eq!(img.get_pixel(0, 0).0, [255, 0, 0]);
        assert_eq!(img.get_pixel(1, 0).0, [0, 0, 255]);

        let jpeg = encode(vec![128; 4 * 16 * 8], 16, 8, ImageFormat::Jpeg).unwrap();
        assert!(jpeg.starts_with(&[0xFF, 0xD8, 0xFF]));
        assert_eq!(image::load_from_memory(&jpeg).unwrap().width(), 16);
    }

    #[test]
    fn rgba_to_rgb_drops_alpha_in_place() {
        let rgba = vec![1, 2, 3, 9, 4, 5, 6, 9, 7, 8, 9, 9];
        let cap = rgba.capacity();
        let rgb = rgba_to_rgb(rgba);
        assert_eq!(rgb, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
        assert_eq!(rgb.capacity(), cap, "no second buffer is allocated");
        assert!(rgba_to_rgb(Vec::new()).is_empty());
    }
}
