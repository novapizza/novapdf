//! Unit tests for `encrypt.rs`. Kept in their own file so coverage reports can exclude test code.
//! That PDFium opens the result is checked in `tests/pipeline.rs`.

use super::*;
use lopdf::content::{Content, Operation};
use lopdf::{LoadOptions, Object, Stream, dictionary};

/// A one-page PDF whose page says `text`.
fn pdf_with(text: &str) -> Vec<u8> {
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let font_id = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" });
    let content = Content {
        operations: vec![
            Operation::new("BT", vec![]),
            Operation::new("Tf", vec!["F1".into(), 12.into()]),
            Operation::new("Td", vec![72.into(), 720.into()]),
            Operation::new("Tj", vec![Object::string_literal(text)]),
            Operation::new("ET", vec![]),
        ],
    };
    let content_id = doc.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "Contents" => content_id,
        "Resources" => dictionary! { "Font" => dictionary! { "F1" => font_id } },
        "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
    });
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1 }),
    );
    let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog_id);
    let mut out = Vec::new();
    doc.save_to(&mut out).unwrap();
    out
}

const KEY: [u8; 32] = [9; 32];

#[test]
fn the_result_opens_only_with_the_password_and_keeps_the_text() {
    let plain = pdf_with("Confidential figures");
    let out = encrypt(&plain, "s3cret pass", &KEY).unwrap();
    assert!(out.starts_with(b"%PDF-"));
    // The text is no longer readable in the file.
    assert!(!out.windows(12).any(|w| w == b"Confidential"));
    // AES-256: version 5, revision 6.
    let raw = Document::load_mem(&out).unwrap();
    let enc = raw.get_encrypted().unwrap();
    assert_eq!(enc.get(b"V").unwrap().as_i64().unwrap(), 5);
    assert_eq!(enc.get(b"R").unwrap().as_i64().unwrap(), 6);

    let opened = Document::load_mem_with_options(&out, LoadOptions::with_password("s3cret pass")).unwrap();
    assert!(!opened.is_encrypted());
    assert_eq!(opened.get_pages().len(), 1);
    let text = opened.extract_text(&[1]).unwrap();
    assert!(text.contains("Confidential figures"), "{text}");

    assert!(Document::load_mem_with_options(&out, LoadOptions::with_password("wrong")).is_err());
}

#[test]
fn passwords_outside_ascii_work() {
    let out = encrypt(&pdf_with("x"), "mật khẩu – 密码", &KEY).unwrap();
    assert!(Document::load_mem_with_options(&out, LoadOptions::with_password("mật khẩu – 密码")).is_ok());
}

#[test]
fn refuses_a_bad_key_and_input_that_is_not_a_pdf() {
    assert_eq!(encrypt(&pdf_with("x"), "p", &[1; 16]).unwrap_err(), "The encryption key is invalid.");
    let err = encrypt(b"not a pdf", "p", &KEY).unwrap_err();
    assert!(err.starts_with("The file could not be password-protected"), "{err}");
}

#[test]
fn a_file_that_is_already_encrypted_is_refused() {
    let once = encrypt(&pdf_with("x"), "p", &KEY).unwrap();
    let err = encrypt(&once, "p", &KEY).unwrap_err();
    assert!(err.starts_with("The file could not be password-protected"), "{err}");
}
