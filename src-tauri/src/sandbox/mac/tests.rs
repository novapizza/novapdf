use super::*;

#[test]
fn profile_denies_by_default_and_allows_font_folders() {
    let p = profile(None);
    assert!(p.starts_with("(version 1)\n(deny default)\n"));
    assert!(p.contains(r#"(subpath "/System/Library/Fonts")"#));
    assert!(p.contains(r#"(subpath "/Library/Fonts")"#));
    assert!(!p.contains("file-write"));
    assert!(!p.contains("network"));
    assert!(!p.contains("process-exec"));
    assert!(!p.contains("Users"));
}

#[test]
fn profile_adds_the_users_font_folder_escaped() {
    let p = profile(Some("/Users/a\"b\\c/"));
    assert!(p.contains(r#"(subpath "/Users/a\"b\\c/Library/Fonts")"#), "{p}");
    // Relative or odd HOME values are ignored rather than trusted.
    assert_eq!(profile(Some("relative")), profile(None));
    assert_eq!(profile(Some("/a\0b")), profile(None));
}

#[test]
fn usage_reads_a_live_child_and_kill_stops_it() {
    let mut child = std::process::Command::new("/bin/sleep").arg("30").spawn().unwrap();
    let pid = child.id();
    let first = usage(pid).expect("child is running");
    assert!(first.footprint > 0);
    assert!(first.started > 0);
    assert_eq!(usage(pid).unwrap().started, first.started, "start time is stable");

    kill(pid);
    let status = child.wait().unwrap();
    assert!(!status.success());
    assert_eq!(usage(pid), None, "a reaped process has no usage");
}
