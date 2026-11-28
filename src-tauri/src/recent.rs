//! Recently opened files.
//!
//! The list is kept here, in Rust, and never handed to the UI as something it can
//! open: the UI gets an id per entry plus a name to show, and asks for an entry by
//! id (`open_recent`). So the rule in `commands.rs` holds: the UI never supplies a
//! path to read. Only files that opened successfully through a dialog, a drop or a
//! launch are recorded.
//!
//! The list is stored as JSON in the app's data folder. File paths reveal what
//! someone has worked on, so the list can be cleared, and turned off (which also
//! clears it).

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Entries kept.
pub const MAX_RECENT: usize = 10;
/// A stored list larger than this is not read (it was not written by us).
const MAX_STORE_BYTES: u64 = 256 * 1024;
/// A stored path longer than this is dropped.
const MAX_PATH_BYTES: usize = 4096;
const STORE_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    v: u32,
    enabled: bool,
    items: Vec<StoredItem>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredItem {
    path: String,
    opened_at: u64,
}

struct Item {
    /// Stable for the session; never stored.
    id: u32,
    path: PathBuf,
    /// Milliseconds since the Unix epoch.
    opened_at: u64,
}

/// What the UI sees: names to show, and ids to ask for.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecentView {
    pub enabled: bool,
    pub items: Vec<RecentItem>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecentItem {
    pub id: u32,
    pub file_name: String,
    /// The folder, for display only.
    pub folder: String,
    pub opened_at: u64,
}

pub struct Recent {
    /// Where the list is stored; `None` keeps it in memory only.
    file: Option<PathBuf>,
    enabled: bool,
    items: Vec<Item>,
    next_id: u32,
}

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// A path as people write it: without Windows' `\\?\` prefix, which `canonicalize` adds.
fn display(path: &Path) -> String {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s.into_owned()
    }
}

impl Recent {
    /// Reads the stored list. A missing, oversized or unreadable file gives an empty
    /// list that is on: the list is a convenience, never a reason to fail.
    pub fn load(file: Option<PathBuf>) -> Self {
        let mut r = Recent { file, enabled: true, items: Vec::new(), next_id: 1 };
        let Some(stored) = r.file.as_deref().and_then(read_store) else {
            return r;
        };
        r.enabled = stored.enabled;
        if !r.enabled {
            return r;
        }
        for it in stored.items {
            if r.items.len() == MAX_RECENT {
                break;
            }
            let ok = !it.path.is_empty() && it.path.len() <= MAX_PATH_BYTES && !it.path.contains('\0');
            let path = PathBuf::from(&it.path);
            // Absolute only, and each path once.
            if ok && path.is_absolute() && !r.items.iter().any(|x| x.path == path) {
                let id = r.take_id();
                r.items.push(Item { id, path, opened_at: it.opened_at });
            }
        }
        r
    }

    fn take_id(&mut self) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    pub fn view(&self) -> RecentView {
        RecentView {
            enabled: self.enabled,
            items: self
                .items
                .iter()
                .map(|it| RecentItem {
                    id: it.id,
                    file_name: it
                        .path
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| display(&it.path)),
                    folder: it.path.parent().map(display).unwrap_or_default(),
                    opened_at: it.opened_at,
                })
                .collect(),
        }
    }

    pub fn path_of(&self, id: u32) -> Option<PathBuf> {
        self.items.iter().find(|it| it.id == id).map(|it| it.path.clone())
    }

    /// Puts a file at the top of the list. Returns whether the list changed.
    pub fn record(&mut self, path: PathBuf, now: u64) -> bool {
        if !self.enabled || !path.is_absolute() || path.as_os_str().len() > MAX_PATH_BYTES {
            return false;
        }
        self.items.retain(|it| it.path != path);
        let id = self.take_id();
        self.items.insert(0, Item { id, path, opened_at: now });
        self.items.truncate(MAX_RECENT);
        true
    }

    pub fn remove(&mut self, id: u32) -> bool {
        let before = self.items.len();
        self.items.retain(|it| it.id != id);
        self.items.len() != before
    }

    pub fn clear(&mut self) {
        self.items.clear();
    }

    /// Turning the list off also forgets what is in it.
    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
        if !enabled {
            self.items.clear();
        }
    }

    /// Writes the list to its file, atomically. A list kept in memory has nothing to do.
    pub fn save(&self) -> Result<(), String> {
        let Some(file) = &self.file else {
            return Ok(());
        };
        let stored = Stored {
            v: STORE_VERSION,
            enabled: self.enabled,
            items: self
                .items
                .iter()
                .map(|it| StoredItem { path: it.path.to_string_lossy().into_owned(), opened_at: it.opened_at })
                .collect(),
        };
        let bytes = serde_json::to_vec(&stored).map_err(|e| e.to_string())?;
        write_atomically(file, &bytes).map_err(|e| format!("Could not save the recent files list: {e}"))
    }
}

fn read_store(file: &Path) -> Option<Stored> {
    let meta = std::fs::metadata(file).ok()?;
    if !meta.is_file() || meta.len() > MAX_STORE_BYTES {
        return None;
    }
    let stored: Stored = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    (stored.v == STORE_VERSION).then_some(stored)
}

fn write_atomically(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension("json.tmp");
    let result = std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, file));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests;
