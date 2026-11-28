//! Unit tests for `recent.rs`. Kept in their own file so coverage reports can exclude test code.

use super::*;
use std::sync::atomic::{AtomicU32, Ordering};

/// A fresh, empty directory under the system temp dir, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "novapdf-recent-test-{}-{}-{}",
            std::process::id(),
            now_ms(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// An absolute path on this platform.
fn abs(name: &str) -> PathBuf {
    std::env::temp_dir().join("docs").join(name)
}

fn names(r: &Recent) -> Vec<String> {
    r.view().items.into_iter().map(|i| i.file_name).collect()
}

#[test]
fn records_newest_first_without_duplicates_and_keeps_ten() {
    let mut r = Recent::load(None);
    assert!(r.view().enabled);
    for i in 0..12 {
        assert!(r.record(abs(&format!("{i}.pdf")), i));
    }
    assert_eq!(names(&r).len(), MAX_RECENT);
    assert_eq!(names(&r)[0], "11.pdf");
    assert_eq!(names(&r)[9], "2.pdf");

    // Opening one again moves it to the top, with a new time and a new id.
    let old_id = r.view().items[5].id;
    assert!(r.record(abs("6.pdf"), 100));
    let top = &r.view().items[0];
    assert_eq!((top.file_name.as_str(), top.opened_at), ("6.pdf", 100));
    assert_ne!(top.id, old_id);
    assert_eq!(names(&r).iter().filter(|n| *n == "6.pdf").count(), 1);
    assert_eq!(names(&r).len(), MAX_RECENT);
}

#[test]
fn refuses_relative_and_overlong_paths() {
    let mut r = Recent::load(None);
    assert!(!r.record(PathBuf::from("relative.pdf"), 1));
    assert!(!r.record(abs(&"x".repeat(MAX_PATH_BYTES + 1)), 1));
    assert!(r.view().items.is_empty());
}

#[test]
fn ids_find_paths_remove_and_clear() {
    let mut r = Recent::load(None);
    r.record(abs("a.pdf"), 1);
    r.record(abs("b.pdf"), 2);
    let view = r.view();
    let b = &view.items[0];
    assert_eq!(r.path_of(b.id), Some(abs("b.pdf")));
    assert_eq!(b.folder, display(&abs("b.pdf").parent().unwrap().to_path_buf()));
    assert_eq!(r.path_of(999), None);

    assert!(r.remove(b.id));
    assert!(!r.remove(b.id));
    assert_eq!(names(&r), ["a.pdf"]);
    r.clear();
    assert!(r.view().items.is_empty());
}

#[test]
fn turning_off_forgets_and_stops_recording() {
    let mut r = Recent::load(None);
    r.record(abs("a.pdf"), 1);
    r.set_enabled(false);
    assert_eq!(r.view(), RecentView { enabled: false, items: vec![] });
    assert!(!r.record(abs("b.pdf"), 2));
    assert!(r.view().items.is_empty());
    r.set_enabled(true);
    assert!(r.record(abs("b.pdf"), 3));
    assert_eq!(names(&r), ["b.pdf"]);
}

#[test]
fn saves_and_loads_across_launches() {
    let dir = TempDir::new();
    // The data folder may not exist yet on first use.
    let file = dir.0.join("nested").join("recent.json");
    let mut r = Recent::load(Some(file.clone()));
    r.record(abs("a.pdf"), 10);
    r.record(abs("b.pdf"), 20);
    r.save().unwrap();
    assert!(!file.with_extension("json.tmp").exists());

    let again = Recent::load(Some(file.clone()));
    let v = again.view();
    assert!(v.enabled);
    assert_eq!(
        v.items.iter().map(|i| (i.file_name.as_str(), i.opened_at)).collect::<Vec<_>>(),
        [("b.pdf", 20), ("a.pdf", 10)]
    );

    // Off is remembered too, and nothing is kept.
    let mut off = again;
    off.set_enabled(false);
    off.save().unwrap();
    assert_eq!(Recent::load(Some(file.clone())).view(), RecentView { enabled: false, items: vec![] });
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(!text.contains("a.pdf"), "{text}");
}

#[test]
fn a_list_in_memory_only_saves_nothing() {
    let mut r = Recent::load(None);
    r.record(abs("a.pdf"), 1);
    assert_eq!(r.save(), Ok(()));
}

#[test]
fn a_save_that_cannot_write_reports_it() {
    let dir = TempDir::new();
    // The "file" is a directory: the rename over it fails.
    let file = dir.0.join("recent.json");
    std::fs::create_dir_all(file.join("blocker")).unwrap();
    let mut r = Recent::load(Some(file.clone()));
    r.record(abs("a.pdf"), 1);
    let err = r.save().unwrap_err();
    assert!(err.starts_with("Could not save the recent files list"), "{err}");
    assert!(!file.with_extension("json.tmp").exists());
}

#[test]
fn a_bad_store_gives_an_empty_list_that_is_on() {
    let dir = TempDir::new();
    let file = dir.0.join("recent.json");
    let cases: Vec<Vec<u8>> = vec![
        b"not json".to_vec(),
        br#"{"v":99,"enabled":false,"items":[]}"#.to_vec(),
        vec![b' '; (MAX_STORE_BYTES + 1) as usize],
    ];
    for bytes in cases {
        std::fs::write(&file, bytes).unwrap();
        let r = Recent::load(Some(file.clone()));
        assert_eq!(r.view(), RecentView { enabled: true, items: vec![] });
    }
    // A folder where the file should be.
    let dir_file = dir.0.join("folder.json");
    std::fs::create_dir_all(&dir_file).unwrap();
    assert!(Recent::load(Some(dir_file)).view().enabled);
}

#[test]
fn a_stored_list_is_checked_entry_by_entry() {
    let dir = TempDir::new();
    let file = dir.0.join("recent.json");
    let good = abs("good.pdf").to_string_lossy().into_owned();
    let mut items = vec![
        serde_json::json!({ "path": "", "openedAt": 1 }),
        serde_json::json!({ "path": "relative.pdf", "openedAt": 1 }),
        serde_json::json!({ "path": "C:\\bad\u{0}.pdf", "openedAt": 1 }),
        serde_json::json!({ "path": "x".repeat(MAX_PATH_BYTES + 1), "openedAt": 1 }),
        serde_json::json!({ "path": good, "openedAt": 5 }),
        serde_json::json!({ "path": good, "openedAt": 4 }),
    ];
    for i in 0..20 {
        items.push(serde_json::json!({ "path": abs(&format!("{i}.pdf")).to_string_lossy(), "openedAt": 1 }));
    }
    std::fs::write(&file, serde_json::to_vec(&serde_json::json!({ "v": 1, "enabled": true, "items": items })).unwrap())
        .unwrap();
    let r = Recent::load(Some(file));
    let n = names(&r);
    assert_eq!(n.len(), MAX_RECENT);
    assert_eq!(n[0], "good.pdf");
    assert_eq!(n.iter().filter(|x| *x == "good.pdf").count(), 1);
    // Ids are unique.
    let mut ids: Vec<u32> = r.view().items.iter().map(|i| i.id).collect();
    ids.dedup();
    assert_eq!(ids.len(), MAX_RECENT);
}

#[test]
fn a_stored_list_that_is_off_has_no_entries() {
    let dir = TempDir::new();
    let file = dir.0.join("recent.json");
    let items = serde_json::json!([{ "path": abs("a.pdf").to_string_lossy(), "openedAt": 1 }]);
    std::fs::write(&file, serde_json::to_vec(&serde_json::json!({ "v": 1, "enabled": false, "items": items })).unwrap())
        .unwrap();
    assert_eq!(Recent::load(Some(file)).view(), RecentView { enabled: false, items: vec![] });
}

#[test]
fn shows_paths_without_the_windows_verbatim_prefix() {
    assert_eq!(display(Path::new(r"\\?\C:\Users\me\a.pdf")), r"C:\Users\me\a.pdf");
    assert_eq!(display(Path::new(r"\\?\UNC\server\share\a.pdf")), r"\\server\share\a.pdf");
    assert_eq!(display(Path::new("/home/me/a.pdf")), "/home/me/a.pdf");
}

#[test]
fn a_path_with_no_file_name_still_shows_something() {
    let mut r = Recent::load(None);
    let root = std::env::temp_dir().ancestors().last().unwrap().to_path_buf();
    assert!(r.record(root.clone(), 1));
    let v = r.view();
    assert_eq!(v.items[0].file_name, display(&root));
    assert!(now_ms() > 1_600_000_000_000);
}
