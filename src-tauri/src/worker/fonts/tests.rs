//! Unit tests for `worker/fonts.rs`. Kept in their own file so coverage reports can exclude test code.

use super::*;

#[test]
fn parses_common_pdf_font_names() {
    let f = guess_from_pdf("ABCDEF+TimesNewRomanPS-BoldItalicMT", 400, 0, 0);
    assert_eq!(f.family, "Times New Roman");
    assert!(f.bold && f.italic);
    let f = guess_from_pdf("ArialMT", 400, 0, 0);
    assert_eq!(f.family, "Arial");
    assert!(!f.bold && !f.italic);
    let f = guess_from_pdf("Calibri,Bold", 400, 0, 0);
    assert_eq!(f.family, "Calibri");
    assert!(f.bold);
    assert_eq!(std_family_for("Arial"), Some(StdFamily::Helvetica));
}

#[test]
fn win_ansi_detection() {
    assert!(is_win_ansi("Hello, “world” — café €5"));
    assert!(!is_win_ansi("Xin chào Việt Nam"));
}

mod more_tests {
    use super::super::*;

    fn spec(family: &str, bold: bool, italic: bool) -> FontSpec {
        FontSpec { family: family.into(), bold, italic }
    }

    #[test]
    fn std_family_aliases() {
        for name in ["Helvetica", "helv", "Arial", "ArialMT", "Liberation Sans", "Arimo", "HELVETICA"] {
            assert_eq!(std_family_for(name), Some(StdFamily::Helvetica), "{name}");
        }
        for name in ["Times", "Times-Roman", "Times New Roman", "TimesNewRomanPSMT", "Liberation Serif", "Tinos"] {
            assert_eq!(std_family_for(name), Some(StdFamily::Times), "{name}");
        }
        for name in ["Courier", "Courier New", "CourierNewPSMT", "Liberation Mono", "Cousine"] {
            assert_eq!(std_family_for(name), Some(StdFamily::Courier), "{name}");
        }
        for name in ["", "Calibri", "Arial Black", "Helvetica Neue", "Times Square", "Segoe UI"] {
            assert_eq!(std_family_for(name), None, "{name}");
        }
    }

    #[test]
    fn std_family_names() {
        assert_eq!(StdFamily::Helvetica.display_name(), "Helvetica");
        assert_eq!(StdFamily::Times.display_name(), "Times");
        assert_eq!(StdFamily::Courier.display_name(), "Courier");
        let expected = [
            (StdFamily::Helvetica, ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"]),
            (StdFamily::Times, ["Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"]),
            (StdFamily::Courier, ["Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"]),
        ];
        for (fam, names) in expected {
            assert_eq!(fam.pdf_name(false, false), names[0]);
            assert_eq!(fam.pdf_name(true, false), names[1]);
            assert_eq!(fam.pdf_name(false, true), names[2]);
            assert_eq!(fam.pdf_name(true, true), names[3]);
            // Every standard family's display name maps back to it.
            assert_eq!(std_family_for(fam.display_name()), Some(fam));
        }
    }

    #[test]
    fn win_ansi_boundaries() {
        assert!(is_win_ansi(""));
        assert!(is_win_ansi(" ~\t\r\n"));
        assert!(is_win_ansi("\u{A0}\u{FF}\u{C0}\u{DF}\u{D8}"));
        // The CP1252 extras in 0x80..0x9F: euro, quotes, dashes, trademark, OE, Z caron, Y diaeresis.
        assert!(is_win_ansi("\u{20AC}\u{201A}\u{2026}\u{2018}\u{2019}\u{201C}\u{201D}\u{2013}\u{2014}\u{2122}\u{152}\u{17D}\u{178}"));
        assert!(!is_win_ansi("\u{7F}"), "DEL");
        assert!(!is_win_ansi("\u{80}"), "C1 control, not the euro sign");
        assert!(!is_win_ansi("\u{9F}"));
        assert!(!is_win_ansi("\u{1}"));
        assert!(!is_win_ansi("\u{100}"), "past Latin-1");
        assert!(!is_win_ansi("\u{131}"), "dotless i");
        assert!(!is_win_ansi("\u{65E5}\u{672C}"), "CJK");
        assert!(!is_win_ansi("ok \u{1F600}"), "emoji");
    }

    #[test]
    fn guess_style_from_numbers_and_flags() {
        let f = guess_from_pdf("Calibri", 700, 0, 0);
        assert!(f.bold && !f.italic);
        assert!(!guess_from_pdf("Calibri", 599, 0, 0).bold);
        assert!(guess_from_pdf("Calibri", 600, 0, 0).bold);
        assert!(guess_from_pdf("Calibri", 400, -12, 0).italic);
        assert!(guess_from_pdf("Calibri", 400, 0, 64).italic, "flag bit 7 = italic");
        assert!(!guess_from_pdf("Calibri", 400, 0, 32).italic);
    }

    #[test]
    fn guess_style_from_names() {
        let f = guess_from_pdf("Helvetica-Oblique", 400, 0, 0);
        assert_eq!((f.family.as_str(), f.bold, f.italic), ("Helvetica", false, true));
        let f = guess_from_pdf("Arial-BoldMT", 400, 0, 0);
        assert_eq!((f.family.as_str(), f.bold, f.italic), ("Arial", true, false));
        let f = guess_from_pdf("Arial,BoldItalic", 400, 0, 0);
        assert_eq!((f.family.as_str(), f.bold, f.italic), ("Arial", true, true));
        let f = guess_from_pdf("SegoeUI-Semibold", 400, 0, 0);
        assert_eq!((f.family.as_str(), f.bold), ("Segoe UI", true));
        let f = guess_from_pdf("ArialBold", 400, 0, 0);
        assert_eq!((f.family.as_str(), f.bold), ("Arial", true));
        let f = guess_from_pdf("Times-Roman", 400, 0, 0);
        assert_eq!((f.family.as_str(), f.bold, f.italic), ("Times", false, false));
        let f = guess_from_pdf("MyriadPro-Regular", 400, 0, 0);
        assert_eq!(f.family, "Myriad");
        assert!(guess_from_pdf("Minion-Black", 400, 0, 0).bold);
    }

    #[test]
    fn guess_subset_tags() {
        assert_eq!(guess_from_pdf("ABCDEF+Georgia", 400, 0, 0).family, "Georgia");
        // Only a six-letter upper-case tag is a subset prefix.
        assert_ne!(guess_from_pdf("ABC+Georgia", 400, 0, 0).family, "Georgia");
        assert_ne!(guess_from_pdf("abcdef+Georgia", 400, 0, 0).family, "Georgia");
    }

    #[test]
    fn guess_keeps_short_names_whole() {
        // Suffixes are only stripped from names long enough to keep a family.
        assert_eq!(guess_from_pdf("Pro", 400, 0, 0).family, "Pro");
        assert_eq!(guess_from_pdf("ArialMT", 400, 0, 0).family, "Arial");
    }

    #[test]
    fn guess_falls_back_on_flags_without_a_name() {
        assert_eq!(guess_from_pdf("", 400, 0, 1).family, "Courier", "fixed pitch");
        assert_eq!(guess_from_pdf("", 400, 0, 2).family, "Times", "serif");
        assert_eq!(guess_from_pdf("", 400, 0, 0).family, "Helvetica");
        assert_eq!(guess_from_pdf("ABCDEF+", 400, 0, 2).family, "Times");
        assert_eq!(guess_from_pdf("-Bold", 400, 0, 0).family, "Helvetica");
    }

    #[test]
    fn spaced_splits_camel_case() {
        assert_eq!(spaced("TimesNewRoman"), "Times New Roman");
        assert_eq!(spaced("DejaVuSans"), "Deja Vu Sans");
        assert_eq!(spaced("ABC"), "ABC");
        assert_eq!(spaced("helvetica"), "helvetica");
        assert_eq!(spaced(""), "");
    }

    #[test]
    fn standard_font_for_win_ansi_text_without_loading_system_fonts() {
        let mut fonts = Fonts::new();
        match fonts.source_for(&spec("Arial", true, false), "Caf\u{E9} \u{20AC}5").unwrap() {
            FontSource::Standard(name) => assert_eq!(name, "Helvetica-Bold"),
            FontSource::TrueType { .. } => panic!("expected a standard font"),
        }
        match fonts.source_for(&spec("Times New Roman", false, true), "x").unwrap() {
            FontSource::Standard(name) => assert_eq!(name, "Times-Italic"),
            FontSource::TrueType { .. } => panic!("expected a standard font"),
        }
        assert!(fonts.db.is_none(), "the system font database should stay unloaded");
    }

    #[test]
    fn resolve_display_maps_standard_aliases() {
        let mut fonts = Fonts::new();
        let f = fonts.resolve_display(&spec("ArialMT", true, true), 0);
        assert_eq!(f, spec("Helvetica", true, true));
        let f = fonts.resolve_display(&spec("Courier New", false, false), 0);
        assert_eq!(f.family, "Courier");
        assert!(fonts.db.is_none());
    }

    #[test]
    fn resolve_display_falls_back_by_flags_for_unknown_fonts() {
        let mut fonts = Fonts::new();
        let unknown = spec("NoSuchFontFamilyXyz", true, false);
        assert_eq!(fonts.resolve_display(&unknown, 1).family, "Courier");
        assert_eq!(fonts.resolve_display(&unknown, 2).family, "Times");
        assert_eq!(fonts.resolve_display(&unknown, 0), spec("Helvetica", true, false), "style is kept");
        assert!(!fonts.has_family("NoSuchFontFamilyXyz"));
    }

    #[test]
    fn covers_rejects_unparseable_data() {
        assert!(!covers(b"not a font", "a"));
        assert!(!covers(&[], ""));
    }

    #[test]
    fn list_families_puts_standard_families_first() {
        let list = list_families();
        assert_eq!(&list[..3], ["Helvetica", "Times", "Courier"]);
        for std in ["Helvetica", "Times", "Courier"] {
            assert_eq!(list.iter().filter(|n| *n == std).count(), 1, "{std} listed twice");
        }
        assert!(!list.iter().any(|n| n.starts_with('.') || n.starts_with('@')));
        let rest: Vec<String> = list[3..].iter().map(|n| n.to_lowercase()).collect();
        assert!(rest.windows(2).all(|w| w[0] <= w[1]), "rest is sorted case-insensitively");
    }
}
