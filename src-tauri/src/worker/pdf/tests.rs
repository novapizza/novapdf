//! Unit tests for `worker/pdf.rs`. Kept in their own file so coverage reports can exclude test code.

use super::*;

/// A fake PDFium "call twice" UTF-16 API returning `units` (incl. terminator).
fn utf16_api(units: Vec<u16>) -> impl FnMut(*mut FPDF_WCHAR, c_ulong) -> c_ulong {
    move |buf, len| {
        let bytes = units.len() * 2;
        if !buf.is_null() && len as usize >= bytes {
            unsafe { ptr::copy_nonoverlapping(units.as_ptr(), buf, units.len()) };
        }
        bytes as c_ulong
    }
}

#[test]
fn to_wide_is_nul_terminated_utf16() {
    assert_eq!(to_wide(""), [0]);
    assert_eq!(to_wide("Ab"), [0x41, 0x62, 0]);
    // Characters outside the BMP become surrogate pairs.
    assert_eq!(to_wide("\u{1F600}"), [0xD83D, 0xDE00, 0]);
}

#[test]
fn read_utf16_strips_terminators() {
    assert_eq!(read_utf16(utf16_api(to_wide("Hello"))), "Hello");
    let s = "Vi\u{1EC7}t \u{1F600}";
    assert_eq!(read_utf16(utf16_api(to_wide(s))), s);
    let mut padded = to_wide("x");
    padded.extend([0, 0]);
    assert_eq!(read_utf16(utf16_api(padded)), "x");
}

#[test]
fn read_utf16_handles_empty_and_oversized_answers() {
    assert_eq!(read_utf16(utf16_api(vec![0])), "", "just a terminator");
    assert_eq!(read_utf16(|_, _| 0), "");
    assert_eq!(read_utf16(|_, _| (MAX_STRING_BYTES + 2) as c_ulong), "");
    // The second call reports fewer bytes than first promised: only those are used.
    let mut first = true;
    let s = read_utf16(|buf, _| {
        if first {
            first = false;
            return 10;
        }
        unsafe { ptr::copy_nonoverlapping([0x61u16, 0x62, 0x63, 0x64, 0].as_ptr(), buf, 5) };
        4
    });
    assert_eq!(s, "ab");
}

#[test]
fn read_utf16_out_reports_failure() {
    assert_eq!(read_utf16_out(|_, _, _| false), None);
    let empty = read_utf16_out(|_, _, out| {
        unsafe { *out = 2 };
        true
    });
    assert_eq!(empty.as_deref(), Some(""));
    let units = to_wide("Watermark");
    let s = read_utf16_out(|buf, len, out| {
        unsafe { *out = (units.len() * 2) as c_ulong };
        if !buf.is_null() && len as usize >= units.len() * 2 {
            unsafe { ptr::copy_nonoverlapping(units.as_ptr(), buf, units.len()) };
        }
        true
    });
    assert_eq!(s.as_deref(), Some("Watermark"));
    // Failing on the second call is a failure too.
    let mut calls = 0;
    let r = read_utf16_out(|_, _, out| {
        calls += 1;
        unsafe { *out = 20 };
        calls == 1
    });
    assert_eq!(r, None);
}

#[test]
fn read_cstr_reads_utf8_and_strips_nul() {
    let data = b"ABCDEF+Arial-BoldMT\0".to_vec();
    let s = read_cstr(|buf, len| {
        if !buf.is_null() {
            unsafe { ptr::copy_nonoverlapping(data.as_ptr(), buf as *mut u8, len.min(data.len())) };
        }
        data.len()
    });
    assert_eq!(s, "ABCDEF+Arial-BoldMT");
    assert_eq!(read_cstr(|_, _| 1), "", "just a terminator");
    assert_eq!(read_cstr(|_, _| 0), "");
    assert_eq!(read_cstr(|_, _| MAX_STRING_BYTES + 1), "");
    // Invalid UTF-8 (a Latin-1 name) is replaced rather than rejected.
    let latin1 = b"Caf\xE9\0".to_vec();
    let s = read_cstr(|buf, len| {
        if !buf.is_null() {
            unsafe { ptr::copy_nonoverlapping(latin1.as_ptr(), buf as *mut u8, len.min(latin1.len())) };
        }
        latin1.len()
    });
    assert_eq!(s, "Caf\u{FFFD}");
}
