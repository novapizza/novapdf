//! Unit tests for `worker/content.rs`. Kept in their own file so coverage reports can exclude test code.

use super::*;

fn text(x: f32, y: f32) -> ObjDesc {
    ObjDesc { kind: ObjKind::Text, origin: Some((x, y)) }
}
fn run(content: &str, objects: &[ObjDesc], remove: &[u32]) -> String {
    String::from_utf8(remove_objects(content.as_bytes(), objects, remove).unwrap()).unwrap()
}

#[test]
fn removes_a_line_and_keeps_the_rest_byte_for_byte() {
    let c = "BT /F1 12 Tf 1 0 0 1 72 700 Tm [(Hel)20(lo)] TJ 0 -14 Td (World) Tj ET";
    let out = run(c, &[text(72.0, 700.0), text(72.0, 686.0)], &[0]);
    assert_eq!(out, "BT /F1 12 Tf 1 0 0 1 72 700 Tm  0 -14 Td (World) Tj ET");
}

#[test]
fn text_split_across_streams_keeps_relative_positions() {
    // Stream 1 ends inside BT; stream 2 continues with a relative move.
    let c = "BT 1 0 0 1 100 500 Tm (one) Tj\n0 -12 Td (two) Tj 0 -12 Td (three) Tj ET";
    let out = run(c, &[text(100.0, 500.0), text(100.0, 488.0), text(100.0, 476.0)], &[0]);
    assert!(out.contains("0 -12 Td (two) Tj 0 -12 Td (three) Tj"));
    assert!(!out.contains("(one)"));
}

#[test]
fn uses_the_ctm_for_positions() {
    let c = "q 1 0 0 1 50 60 cm BT 1 0 0 1 10 20 Tm (a) Tj ET Q BT 1 0 0 1 10 20 Tm (b) Tj ET";
    let out = run(c, &[text(60.0, 80.0), text(10.0, 20.0)], &[1]);
    assert!(out.contains("(a) Tj") && !out.contains("(b)"));
}

#[test]
fn hides_a_run_that_a_later_run_depends_on() {
    let c = "BT 1 0 0 1 72 700 Tm (A) Tj (B) Tj ET";
    let out = run(c, &[text(72.0, 700.0), ObjDesc { kind: ObjKind::Text, origin: None }], &[0]);
    assert_eq!(out, "BT 1 0 0 1 72 700 Tm 3 Tr (A) Tj 0 Tr (B) Tj ET");
}

#[test]
fn keeps_line_moves_of_quote_operators() {
    let c = "BT 14 TL 1 0 0 1 72 700 Tm (a) Tj (b) ' 1 2 (c) \" ET";
    let objs = [text(72.0, 700.0), text(72.0, 686.0), text(72.0, 672.0)];
    let out = run(c, &objs, &[1, 2]);
    assert_eq!(out, "BT 14 TL 1 0 0 1 72 700 Tm (a) Tj T* 1 Tw 2 Tc T* ET");
}

#[test]
fn paths_images_and_shadings() {
    let c = "0 0 10 10 re f /Im1 Do 5 5 m 6 6 l S /Sh1 sh BI /W 1 /H 1 ID \x01EI\x02 EI Q";
    let objs = [
        ObjDesc { kind: ObjKind::Path, origin: None },
        ObjDesc { kind: ObjKind::Image, origin: None },
        ObjDesc { kind: ObjKind::Path, origin: None },
        ObjDesc { kind: ObjKind::Shading, origin: None },
        ObjDesc { kind: ObjKind::Image, origin: None },
    ];
    let out = run(c, &objs, &[0, 1, 3, 4]);
    assert_eq!(out, "0 0 10 10 re n  5 5 m 6 6 l S   Q");
}

#[test]
fn refuses_when_objects_do_not_match() {
    let c = "BT 1 0 0 1 72 700 Tm (A) Tj ET";
    assert!(remove_objects(c.as_bytes(), &[text(300.0, 300.0)], &[0]).is_err());
}

#[test]
fn strings_with_parens_escapes_and_hex() {
    let c = r"BT 1 0 0 1 1 1 Tm (a\)b(c)) Tj 1 0 0 1 1 2 Tm <0041> Tj 1 0 0 1 1 3 Tm () Tj ET";
    let out = run(c, &[text(1.0, 1.0), text(1.0, 2.0)], &[0, 1]);
    assert_eq!(out, "BT 1 0 0 1 1 1 Tm  1 0 0 1 1 2 Tm  1 0 0 1 1 3 Tm () Tj ET");
}

mod removal_tests {
    use super::super::*;

    /// A minimal PDF with one page per entry; each page's content is split into the
    /// given streams.
    fn pdf(pages: &[&[&str]]) -> Vec<u8> {
        let n = pages.len();
        let mut objects: Vec<String> = Vec::new();
        objects.push("<< /Type /Catalog /Pages 2 0 R >>".into());
        let kids: Vec<String> = (0..n).map(|i| format!("{} 0 R", 3 + i)).collect();
        objects.push(format!("<< /Type /Pages /Kids [{}] /Count {n} >>", kids.join(" ")));
        let font_id = 3 + n;
        let mut next = font_id + 1;
        let mut streams = Vec::new();
        for streams_of_page in pages {
            let ids: Vec<String> = (0..streams_of_page.len()).map(|k| format!("{} 0 R", next + k)).collect();
            next += streams_of_page.len();
            objects.push(format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font_id} 0 R >> >> /Contents [{}] >>",
                ids.join(" ")
            ));
            streams.extend(streams_of_page.iter().map(|s| s.to_string()));
        }
        objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".into());
        for s in streams {
            objects.push(format!("<< /Length {} >>\nstream\n{s}\nendstream", s.len() + 1));
        }
        let mut out = b"%PDF-1.7\n".to_vec();
        let mut offsets = Vec::new();
        for (i, o) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend(format!("{} 0 obj\n{o}\nendobj\n", i + 1).into_bytes());
        }
        let xref = out.len();
        out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).into_bytes());
        for off in offsets {
            out.extend(format!("{off:010} 00000 n \n").into_bytes());
        }
        out.extend(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).into_bytes());
        out
    }

    fn text(x: f32, y: f32) -> ObjDesc {
        ObjDesc { kind: ObjKind::Text, origin: Some((x, y)) }
    }

    fn page_content(bytes: &[u8], page: u32) -> String {
        let doc = lopdf::Document::load_mem(bytes).unwrap();
        let id = doc.get_pages()[&page];
        String::from_utf8(doc.get_page_content(id)).unwrap()
    }

    const S1: &str = "BT /F1 12 Tf 1 0 0 1 72 700 Tm (Line one) Tj";
    const S2: &str = "0 -40 Td (Line two) Tj ET";

    #[test]
    fn removes_text_across_streams_and_drops_old_streams() {
        let src = pdf(&[&[S1, S2]]);
        let removal = PageRemoval { page: 0, objects: vec![text(72.0, 700.0), text(72.0, 660.0)], remove: vec![0] };
        let out = apply_removals(&src, &[removal]).unwrap();
        let content = page_content(&out, 1);
        assert!(!content.contains("(Line one)"), "{content}");
        assert!(content.contains("0 -40 Td (Line two) Tj ET"), "{content}");
        // The removed text is gone from the file, not just unreferenced.
        let doc = lopdf::Document::load_mem(&out).unwrap();
        let all: Vec<u8> = doc
            .objects
            .values()
            .filter_map(|o| o.as_stream().ok())
            .flat_map(|s| s.decompressed_content().unwrap_or_else(|_| s.content.clone()))
            .collect();
        assert!(!all.windows(10).any(|w| w == b"(Line one)"));
    }

    #[test]
    fn only_listed_pages_change() {
        let src = pdf(&[&[S1, S2], &["BT /F1 12 Tf 1 0 0 1 72 700 Tm (Keep me) Tj ET"]]);
        let removal = PageRemoval { page: 0, objects: vec![text(72.0, 700.0), text(72.0, 660.0)], remove: vec![1] };
        let out = apply_removals(&src, &[removal]).unwrap();
        assert!(page_content(&out, 1).contains("(Line one) Tj"));
        assert!(!page_content(&out, 1).contains("(Line two)"));
        assert!(page_content(&out, 2).contains("(Keep me) Tj"));
    }

    #[test]
    fn unmatched_or_missing_pages_are_reported_and_nothing_changes() {
        let src = pdf(&[&[S1, S2]]);
        let wrong = PageRemoval { page: 0, objects: vec![text(300.0, 300.0)], remove: vec![0] };
        let missing = PageRemoval { page: 5, objects: vec![text(72.0, 700.0)], remove: vec![0] };
        match apply_removals(&src, &[wrong, missing]) {
            Err(RemovalError::Pages(p)) => assert_eq!(p, [0, 5]),
            other => panic!("expected page failures, got {:?}", other.map(|b| b.len())),
        }
    }

    #[test]
    fn unreadable_documents_are_a_document_error() {
        let removal = PageRemoval { page: 0, objects: vec![], remove: vec![] };
        assert!(matches!(
            apply_removals(b"%PDF-1.7\ngarbage", &[removal]),
            Err(RemovalError::Document(_))
        ));
    }

    #[test]
    fn no_removals_still_round_trips() {
        let src = pdf(&[&[S1, S2]]);
        let out = apply_removals(&src, &[]).unwrap();
        assert!(out.starts_with(b"%PDF-"));
        assert!(page_content(&out, 1).contains("(Line one) Tj"));
    }
}
