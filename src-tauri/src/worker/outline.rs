//! The document outline (bookmarks), listed flat in document order.
//!
//! The bookmark tree comes from a hostile file, so the walk is iterative (no recursion
//! to overflow), bounded in entries and depth, and remembers every node it has visited:
//! a `/Next` or `/First` that points back into the tree ends that branch instead of
//! looping forever.

use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::ptr;

use pdfium_render::prelude::{FPDF_BOOKMARK, FPDF_BOOL, FPDF_DEST, FS_FLOAT};

use super::pdf::{Doc, PDFACTION_GOTO, read_utf16};
use crate::geometry::Matrix;
use crate::protocol::{MAX_OUTLINE_DEPTH, MAX_OUTLINE_ITEMS, MAX_OUTLINE_TITLE, Outline, OutlineItem};

/// Most distinct pages loaded to place a bookmark within its page. Loading a page
/// parses its content, so a long outline would otherwise cost one parse per page;
/// beyond this, bookmarks go to the top of their page.
pub const MAX_POSITIONED_PAGES: usize = 200;

pub fn list(doc: &Doc) -> Outline {
    let b = doc.lib.b();
    let page_count = doc.page_count();
    let mut out = Outline::default();
    let mut seen: HashSet<usize> = HashSet::new();
    let mut pages: HashMap<i32, Option<(Matrix, f32, bool)>> = HashMap::new();

    // Siblings are pushed before children, so children come out first: pre-order.
    let mut stack: Vec<(FPDF_BOOKMARK, u32)> = Vec::new();
    let first = unsafe { b.FPDFBookmark_GetFirstChild(doc.h, ptr::null_mut()) };
    if !first.is_null() {
        stack.push((first, 0));
    }
    while let Some((bm, depth)) = stack.pop() {
        if !seen.insert(bm as usize) {
            out.truncated = true;
            continue;
        }
        if out.items.len() >= MAX_OUTLINE_ITEMS {
            out.truncated = true;
            break;
        }
        let next = unsafe { b.FPDFBookmark_GetNextSibling(doc.h, bm) };
        if !next.is_null() {
            stack.push((next, depth));
        }
        let child = unsafe { b.FPDFBookmark_GetFirstChild(doc.h, bm) };
        if !child.is_null() {
            if depth < MAX_OUTLINE_DEPTH {
                stack.push((child, depth + 1));
            } else {
                out.truncated = true;
            }
        }

        let (page_index, y) = destination(doc, bm, page_count, &mut pages);
        out.items.push(OutlineItem {
            title: clean_title(&read_utf16(|buf, len| unsafe {
                b.FPDFBookmark_GetTitle(bm, buf as *mut c_void, len)
            })),
            depth,
            page_index,
            y,
            open: unsafe { b.FPDFBookmark_GetCount(bm) } > 0,
        });
    }
    out
}

/// Titles are shown on one line: control characters (often `\r`) become spaces,
/// runs of white space collapse, and the result is cut to `MAX_OUTLINE_TITLE`.
pub fn clean_title(raw: &str) -> String {
    raw.split(|c: char| c.is_whitespace() || c.is_control())
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_OUTLINE_TITLE)
        .collect()
}

/// Page and display-space y of a bookmark's destination (its `/Dest`, or a GoTo
/// action's). Other actions (another file, a URI, a script) have no page here.
fn destination(
    doc: &Doc,
    bm: FPDF_BOOKMARK,
    page_count: i32,
    pages: &mut HashMap<i32, Option<(Matrix, f32, bool)>>,
) -> (Option<i32>, Option<f32>) {
    let b = doc.lib.b();
    let mut dest: FPDF_DEST = unsafe { b.FPDFBookmark_GetDest(doc.h, bm) };
    if dest.is_null() {
        let action = unsafe { b.FPDFBookmark_GetAction(bm) };
        if !action.is_null() && unsafe { b.FPDFAction_GetType(action) } == PDFACTION_GOTO {
            dest = unsafe { b.FPDFAction_GetDest(doc.h, action) };
        }
    }
    if dest.is_null() {
        return (None, None);
    }
    let page = unsafe { b.FPDFDest_GetDestPageIndex(doc.h, dest) };
    if page < 0 || page >= page_count {
        return (None, None);
    }

    let (mut has_x, mut has_y, mut has_zoom): (FPDF_BOOL, FPDF_BOOL, FPDF_BOOL) = (0, 0, 0);
    let (mut x, mut y, mut zoom): (FS_FLOAT, FS_FLOAT, FS_FLOAT) = (0.0, 0.0, 0.0);
    let ok = unsafe {
        b.FPDFDest_GetLocationInPage(dest, &mut has_x, &mut has_y, &mut has_zoom, &mut x, &mut y, &mut zoom)
    };
    if ok == 0 || has_y == 0 || !y.is_finite() || (has_x != 0 && !x.is_finite()) {
        return (Some(page), None);
    }
    let room = pages.len() < MAX_POSITIONED_PAGES;
    let placed = match pages.get(&page) {
        Some(p) => *p,
        None if room => {
            let p = doc
                .page(page)
                .ok()
                .map(|pg| (pg.display_matrix(), pg.display_size().1, pg.rotation() % 2 == 1));
            pages.insert(page, p);
            p
        }
        None => None,
    };
    let Some((m, height, sideways)) = placed else {
        return (Some(page), None);
    };
    // On a page turned a quarter, display y comes from page x: without one, the
    // destination does not say where on the page it is.
    if sideways && has_x == 0 {
        return (Some(page), None);
    }
    let (_, dy) = m.apply(if has_x != 0 { x } else { 0.0 }, y);
    (Some(page), Some(dy.clamp(0.0, height)))
}

#[cfg(test)]
mod tests;
