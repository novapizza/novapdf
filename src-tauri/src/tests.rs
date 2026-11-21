//! Unit tests for `lib.rs`. Kept in their own file so coverage reports can exclude test code.

use super::*;

fn allowed(s: &str) -> bool {
    is_app_url(&Url::parse(s).unwrap())
}

#[test]
fn app_urls_are_allowed() {
    assert!(allowed("tauri://localhost"));
    assert!(allowed("tauri://localhost/index.html#/doc"));
    assert!(allowed("http://tauri.localhost/"));
    assert!(allowed("https://tauri.localhost/assets/app.js"));
    // Hosts are case-insensitive and normalised by the URL parser.
    assert!(allowed("HTTP://TAURI.LOCALHOST/"));
}

#[test]
fn localhost_is_allowed_only_in_debug_builds() {
    assert_eq!(allowed("http://localhost:1420/"), cfg!(debug_assertions));
    assert_eq!(allowed("https://localhost/"), cfg!(debug_assertions));
}

#[test]
fn other_hosts_and_schemes_are_rejected() {
    for url in [
        "https://example.com/",
        "http://tauri.localhost.evil.com/",
        "http://evil.com/tauri.localhost",
        "http://tauri.localhost@evil.com/",
        "http://evil.tauri.localhost/",
        "http://127.0.0.1:1420/",
        "http://localhost.evil.com/",
        "ftp://tauri.localhost/",
        "file:///C:/Windows/win.ini",
        "javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "about:blank",
        "mailto:a@b.c",
    ] {
        assert!(!allowed(url), "{url} should be rejected");
    }
}
