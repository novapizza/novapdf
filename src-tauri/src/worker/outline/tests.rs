use super::*;

#[test]
fn titles_are_one_line_and_bounded() {
    assert_eq!(clean_title("  Chapter\r\n 1\t– Intro  "), "Chapter 1 – Intro");
    assert_eq!(clean_title("a\u{0}b"), "a b");
    assert_eq!(clean_title(""), "");
    assert_eq!(clean_title(&"x".repeat(MAX_OUTLINE_TITLE + 10)).chars().count(), MAX_OUTLINE_TITLE);
}
