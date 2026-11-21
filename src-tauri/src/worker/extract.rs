//! Reads a page's text objects and groups them into editable paragraphs.

use std::ffi::{c_int, c_ulong};

use pdfium_render::prelude::{FPDF_PAGEOBJECT, PdfiumLibraryBindings};

use super::edit::Writer;
use super::fonts::{Fonts, guess_from_pdf};
use super::pdf::{
    Doc, FPDF_ANNOT_WATERMARK, FPDF_PAGEOBJ_TEXT, FPDF_TEXTRENDERMODE_INVISIBLE, Page, TextPage,
    obj_bounds, obj_fill, obj_matrix, read_cstr, read_utf16, read_utf16_out,
};
use crate::geometry::Matrix;
use crate::protocol::{
    Align, FontSpec, LooseText, PageText, PageWatermarks, Paragraph, Rect, WatermarkScan,
};

const MAX_TEXT_OBJECTS: i32 = 50_000;

pub struct TextObj {
    pub index: u32,
    pub text: String,
    /// Origin of the text run (display space).
    pub ox: f32,
    pub baseline: f32,
    /// Display-space bounds.
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
    pub size: f32,
    pub upright: bool,
    pub invisible: bool,
    pub transparent: bool,
    pub watermark_mark: bool,
    pub font_name: String,
    pub font_spec: FontSpec,
    pub font_flags: i32,
    pub color: [u8; 3],
}

pub(crate) fn has_watermark_mark(b: &dyn PdfiumLibraryBindings, obj: FPDF_PAGEOBJECT) -> bool {
    let n = unsafe { b.FPDFPageObj_CountMarks(obj) }.clamp(0, 64);
    for i in 0..n {
        let mark = unsafe { b.FPDFPageObj_GetMark(obj, i as c_ulong) };
        if mark.is_null() {
            continue;
        }
        let name = read_utf16_out(|buf, len, out| unsafe {
            b.FPDFPageObjMark_GetName(mark, buf, len, out) != 0
        })
        .unwrap_or_default();
        if name == "Watermark" {
            return true;
        }
        if name == "Artifact" {
            let sub = read_utf16_out(|buf, len, out| unsafe {
                b.FPDFPageObjMark_GetParamStringValue(mark, "Subtype", buf, len, out) != 0
            });
            if sub.as_deref() == Some("Watermark") {
                return true;
            }
        }
    }
    false
}

/// Maps the odd whitespace PDFs produce (NBSP from font CMaps, en/em spaces, line
/// breaks inside a run) to plain spaces and drops other control characters, so text
/// re-wraps normally when edited.
pub fn normalize_text(s: &str) -> String {
    s.chars()
        .filter_map(|c| match c {
            '\u{A0}' | '\u{2000}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\t' | '\r' | '\n' => Some(' '),
            '\u{200B}' | '\u{FEFF}' | '\u{FFFE}' | '\u{FFFF}' => None,
            c if c.is_control() => None,
            c => Some(c),
        })
        .collect()
}

pub(crate) fn read_text_obj(
    page: &Page,
    tp: &TextPage,
    display: &Matrix,
    index: i32,
    obj: FPDF_PAGEOBJECT,
) -> Option<TextObj> {
    let b = page.b();
    if unsafe { b.FPDFPageObj_GetType(obj) } != FPDF_PAGEOBJ_TEXT {
        return None;
    }
    let text = normalize_text(&read_utf16(|buf, len| unsafe {
        b.FPDFTextObj_GetText(obj, tp.h, buf, len)
    }));
    if text.trim().is_empty() {
        return None;
    }
    let dm = obj_matrix(b, obj)?.then(display);
    let mut font_size = 0f32;
    unsafe { b.FPDFTextObj_GetFontSize(obj, &mut font_size) };
    let v_scale = (dm.c * dm.c + dm.d * dm.d).sqrt();
    let size = font_size * v_scale;
    if !size.is_finite() || size <= 0.1 {
        return None;
    }
    let upright = dm.a > 0.0
        && dm.b.abs() <= 0.02 * dm.a.abs()
        && dm.d < 0.0
        && dm.c.abs() <= 0.35 * dm.d.abs();

    let [l, bt, r, t] = obj_bounds(b, obj)?;
    let (x0, y0, x1, y1) = display.apply_rect(l, bt, r, t);

    let font = unsafe { b.FPDFTextObj_GetFont(obj) };
    let (font_name, weight, italic_angle, flags) = if font.is_null() {
        (String::new(), 400, 0, 0)
    } else {
        let name = read_cstr(|buf, len| unsafe { b.FPDFFont_GetBaseFontName(font, buf, len) });
        let weight = unsafe { b.FPDFFont_GetWeight(font) };
        let mut angle: c_int = 0;
        unsafe { b.FPDFFont_GetItalicAngle(font, &mut angle) };
        let flags = unsafe { b.FPDFFont_GetFlags(font) };
        (name, weight, angle, flags)
    };
    let [cr, cg, cb, _] = obj_fill(b, obj);

    Some(TextObj {
        index: index as u32,
        text,
        ox: dm.e,
        baseline: dm.f,
        x0,
        y0,
        x1,
        y1,
        size,
        upright,
        invisible: unsafe { b.FPDFTextObj_GetTextRenderMode(obj) } == FPDF_TEXTRENDERMODE_INVISIBLE,
        transparent: unsafe { b.FPDFPageObj_HasTransparency(obj) } != 0,
        watermark_mark: has_watermark_mark(b, obj),
        font_spec: guess_from_pdf(&font_name, weight, italic_angle, flags),
        font_name,
        font_flags: flags,
        color: [cr, cg, cb],
    })
}

pub fn extract_page(doc: &Doc, page_index: i32, fonts: &mut Fonts) -> Result<PageText, String> {
    let page = doc.page(page_index)?;
    let (width, height) = page.size();
    let display = page.display_matrix();
    let tp = page.text_page()?;

    let count = page.object_count().min(MAX_TEXT_OBJECTS);
    let mut items = Vec::new();
    let mut loose = Vec::new();
    for i in 0..count {
        let obj = page.object(i);
        if obj.is_null() {
            continue;
        }
        let Some(t) = read_text_obj(&page, &tp, &display, i, obj) else {
            continue;
        };
        if t.invisible {
            // OCR layers over scanned images: editing them changes nothing visible.
            continue;
        }
        if t.upright && !t.watermark_mark {
            items.push(t);
        } else {
            loose.push(LooseText {
                object_index: t.index,
                bounds: Rect { x: t.x0, y: t.y0, width: t.x1 - t.x0, height: t.y1 - t.y0 },
                text: t.text.trim().to_string(),
                rotated: !t.upright,
                transparent: t.transparent,
                watermark_mark: t.watermark_mark,
            });
        }
    }

    let lines = build_lines(&items);
    let groups = group_paragraphs(&lines, &items);
    let mut built: Vec<(Paragraph, Vec<(String, f32)>)> = groups
        .into_iter()
        .enumerate()
        .map(|(id, g)| make_paragraph(id as u32, &g, &lines, &items, fonts))
        .collect();

    // Match the substitute font's metrics to the original, so re-typeset text breaks
    // onto the same lines. Fonts are loaded into a scratch document, never this one.
    if let Ok(scratch) = Doc::new_empty(doc.lib) {
        let mut writer = Writer::new(&scratch, fonts);
        for (para, line_widths) in &mut built {
            calibrate(&mut writer, para, line_widths);
        }
    }
    let paragraphs = built.into_iter().map(|(p, _)| p).collect();

    Ok(PageText { width, height, paragraphs, loose })
}

// ---------- lines ----------

pub struct Line {
    pub items: Vec<usize>,
    pub x0: f32,
    pub x1: f32,
    pub top: f32,
    pub bottom: f32,
    pub baseline: f32,
    pub size: f32,
    pub text: String,
    /// Index of the item whose style dominates the line.
    pub style: usize,
    pub mixed: bool,
}

fn same_style(a: &TextObj, b: &TextObj) -> bool {
    a.font_name == b.font_name
        && (a.size - b.size).abs() <= 0.06 * a.size.max(b.size)
        && color_dist(a.color, b.color) <= 24
}

fn color_dist(a: [u8; 3], b: [u8; 3]) -> u32 {
    (0..3).map(|i| (a[i] as i32 - b[i] as i32).unsigned_abs()).max().unwrap_or(0)
}

pub fn build_lines(items: &[TextObj]) -> Vec<Line> {
    let mut order: Vec<usize> = (0..items.len()).collect();
    order.sort_by(|&a, &b| items[a].baseline.total_cmp(&items[b].baseline));

    // Rows: runs that share a baseline.
    let mut rows: Vec<Vec<usize>> = Vec::new();
    for i in order {
        let it = &items[i];
        match rows.last_mut() {
            Some(row) if (it.baseline - items[row[0]].baseline).abs() <= 0.3 * it.size.max(1.0) => {
                row.push(i)
            }
            _ => rows.push(vec![i]),
        }
    }

    let mut lines = Vec::new();
    for mut row in rows {
        row.sort_by(|&a, &b| items[a].ox.total_cmp(&items[b].ox));
        // Split a row into segments at wide gaps (columns, table cells).
        let mut seg: Vec<usize> = Vec::new();
        let mut seg_x1 = f32::MIN;
        for i in row {
            let it = &items[i];
            let gap = it.ox - seg_x1;
            if !seg.is_empty() && gap > 1.2 * it.size.max(4.0) {
                lines.push(make_line(std::mem::take(&mut seg), items));
                seg_x1 = f32::MIN;
            }
            seg_x1 = seg_x1.max(it.x1);
            seg.push(i);
        }
        if !seg.is_empty() {
            lines.push(make_line(seg, items));
        }
    }
    lines
}

fn make_line(seg: Vec<usize>, items: &[TextObj]) -> Line {
    let mut text = String::new();
    let mut prev_x1: Option<f32> = None;
    let (mut x0, mut x1, mut top, mut bottom) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
    for &i in &seg {
        let it = &items[i];
        if let Some(px1) = prev_x1 {
            let gap = it.ox - px1;
            let boundary_space = text.ends_with(char::is_whitespace) || it.text.starts_with(char::is_whitespace);
            if gap > 0.18 * it.size && !boundary_space {
                text.push(' ');
            }
        }
        text.push_str(&it.text);
        prev_x1 = Some(prev_x1.map_or(it.x1, |p| p.max(it.x1)));
        x0 = x0.min(it.ox);
        x1 = x1.max(it.x1);
        top = top.min(it.y0);
        bottom = bottom.max(it.y1);
    }

    // Dominant style: the one covering the most characters.
    let mut best = seg[0];
    let mut best_chars = 0usize;
    for &i in &seg {
        let chars: usize = seg
            .iter()
            .filter(|&&j| same_style(&items[i], &items[j]))
            .map(|&j| items[j].text.chars().count())
            .sum();
        if chars > best_chars {
            best = i;
            best_chars = chars;
        }
    }
    let mixed = seg.iter().any(|&j| !same_style(&items[best], &items[j]));
    let baseline = items[best].baseline;
    let size = items[best].size;
    Line {
        items: seg,
        x0,
        x1,
        top,
        bottom,
        baseline,
        size,
        text: collapse_spaces(text.trim_end()),
        style: best,
        mixed,
    }
}

fn collapse_spaces(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c == ' ' && out.ends_with(' ') {
            continue;
        }
        out.push(c);
    }
    out
}

// ---------- paragraphs ----------

pub fn group_paragraphs(lines: &[Line], items: &[TextObj]) -> Vec<Vec<usize>> {
    let mut order: Vec<usize> = (0..lines.len()).collect();
    order.sort_by(|&a, &b| {
        lines[a]
            .baseline
            .total_cmp(&lines[b].baseline)
            .then(lines[a].x0.total_cmp(&lines[b].x0))
    });

    struct Para {
        lines: Vec<usize>,
        spacing: Option<f32>,
    }
    let mut paras: Vec<Para> = Vec::new();

    for li in order {
        let l = &lines[li];
        let mut best: Option<(usize, f32)> = None;
        for (pi, p) in paras.iter().enumerate() {
            let last = &lines[*p.lines.last().unwrap()];
            if !same_style(&items[last.style], &items[l.style]) {
                continue;
            }
            let delta = l.baseline - last.baseline;
            // Body text line spacing is rarely above 1.6×; a larger gap after a single
            // line usually means a paragraph break (spacing after, blank line).
            let max_delta = if p.spacing.is_none() { 1.6 } else { 2.0 };
            if delta < 0.8 * l.size || delta > max_delta * l.size {
                continue;
            }
            if let Some(sp) = p.spacing
                && (delta - sp).abs() > 0.2 * l.size
            {
                continue;
            }
            let overlap = l.x1.min(last.x1) - l.x0.max(last.x0);
            if overlap <= 0.0 {
                continue;
            }
            let left_ok = (l.x0 - last.x0).abs() <= (0.6 * l.size).max(2.0);
            let center_ok = ((l.x0 + l.x1) / 2.0 - (last.x0 + last.x1) / 2.0).abs() <= 2.0;
            let right_ok = (l.x1 - last.x1).abs() <= 2.0;
            // Second line of a paragraph whose first line is indented.
            let indent_ok = p.lines.len() == 1 && last.x0 - l.x0 > 0.0 && last.x0 - l.x0 <= 4.0 * l.size;
            if !(left_ok || center_ok || right_ok || indent_ok) {
                continue;
            }
            if best.is_none_or(|(_, d)| delta < d) {
                best = Some((pi, delta));
            }
        }
        match best {
            Some((pi, delta)) => {
                let p = &mut paras[pi];
                p.spacing.get_or_insert(delta);
                p.lines.push(li);
            }
            None => paras.push(Para { lines: vec![li], spacing: None }),
        }
    }
    paras.into_iter().map(|p| p.lines).collect()
}

/// Sets `h_scale` so every original line, measured in the substitute font, fits in
/// the width it had on the page. Justified lines are stretched, so the tightest line
/// is the best estimate of the natural ratio.
fn calibrate(writer: &mut Writer, para: &mut Paragraph, lines: &[(String, f32)]) {
    let texts: Vec<&str> = lines.iter().map(|(t, _)| t.as_str()).collect();
    let Ok(natural) = writer.text_widths(&para.font, para.size, &texts) else {
        return;
    };
    let mut ratio = f32::MAX;
    for ((text, actual), natural) in lines.iter().zip(natural) {
        if text.chars().count() < 8 || natural <= 0.0 || *actual <= 0.0 {
            continue;
        }
        ratio = ratio.min(actual / natural);
    }
    if ratio < 0.995 {
        para.h_scale = (ratio.max(0.8) * 1000.0).floor() / 1000.0;
    }
}

fn make_paragraph(
    id: u32,
    group: &[usize],
    lines: &[Line],
    items: &[TextObj],
    fonts: &mut Fonts,
) -> (Paragraph, Vec<(String, f32)>) {
    let ls: Vec<&Line> = group.iter().map(|&i| &lines[i]).collect();
    let first = ls[0];
    let style = &items[first.style];

    let x0 = ls.iter().map(|l| l.x0).fold(f32::MAX, f32::min);
    let x1 = ls.iter().map(|l| l.x1).fold(f32::MIN, f32::max);
    let top = ls.iter().map(|l| l.top).fold(f32::MAX, f32::min);
    let bottom = ls.iter().map(|l| l.bottom).fold(f32::MIN, f32::max);

    let mut text = String::new();
    for (i, l) in ls.iter().enumerate() {
        if i > 0 && !text.ends_with('-') {
            text.push(' ');
        }
        text.push_str(l.text.trim());
    }

    let spread = |f: &dyn Fn(&Line) -> f32, range: std::ops::Range<usize>| {
        let vals: Vec<f32> = ls[range].iter().map(|l| f(l)).collect();
        if vals.is_empty() {
            return 0.0;
        }
        vals.iter().cloned().fold(f32::MIN, f32::max) - vals.iter().cloned().fold(f32::MAX, f32::min)
    };
    let n = ls.len();
    let tol = (0.15 * first.size).max(1.5);

    // First-line indent: the other lines share a left edge and the first starts further in.
    let indent = if n >= 2 {
        let rest_x0 = ls[1..].iter().map(|l| l.x0).fold(f32::MAX, f32::min);
        let d = first.x0 - rest_x0;
        if spread(&|l| l.x0, 1..n) <= tol && d > tol && d < 0.3 * (x1 - x0) { d } else { 0.0 }
    } else {
        0.0
    };
    let left_edge_ok = if indent > 0.0 { spread(&|l| l.x0, 1..n) <= tol } else { spread(&|l| l.x0, 0..n) <= tol };

    let align = if n < 2 {
        Align::Left
    } else if left_edge_ok && spread(&|l| l.x1, 0..n - 1) <= tol && (n >= 3 || ls[n - 1].x1 < x1 - tol) {
        // Every line but the last reaches the same right edge.
        Align::Justify
    } else if left_edge_ok {
        Align::Left
    } else if spread(&|l| (l.x0 + l.x1) / 2.0, 0..n) <= 2.0 {
        Align::Center
    } else if spread(&|l| l.x1, 0..n) <= 2.0 {
        Align::Right
    } else {
        Align::Left
    };

    let line_height = if ls.len() >= 2 {
        ((ls[ls.len() - 1].baseline - first.baseline) / (ls.len() - 1) as f32 / first.size)
            .clamp(0.8, 3.0)
    } else {
        1.2
    };

    let mixed = ls.iter().any(|l| l.mixed);
    let font = fonts.resolve_display(&style.font_spec, style.font_flags);

    let line_widths = ls.iter().map(|l| (l.text.trim().to_string(), l.x1 - l.x0)).collect();
    let para = Paragraph {
        id,
        object_indices: ls
            .iter()
            .flat_map(|l| l.items.iter().map(|&i| items[i].index))
            .collect(),
        bounds: Rect { x: x0, y: top, width: x1 - x0, height: bottom - top },
        text,
        font,
        source_font: style.font_name.clone(),
        size: first.size,
        color: style.color,
        line_height,
        first_baseline: first.baseline,
        align,
        wrap: ls.len() >= 2,
        line_count: ls.len() as u32,
        indent,
        h_scale: 1.0,
        mixed_styles: mixed,
    };
    (para, line_widths)
}

// ---------- watermark detection ----------

pub fn find_watermarks(doc: &Doc, text: Option<&str>) -> Result<WatermarkScan, String> {
    let query = text
        .map(|t| t.trim().to_lowercase())
        .filter(|t| !t.is_empty());
    let mut scan = WatermarkScan::default();
    for page_index in 0..doc.page_count() {
        let page = doc.page(page_index)?;
        let b = page.b();
        let mut found = PageWatermarks { page_index, ..Default::default() };

        let display = page.display_matrix();
        let tp = if query.is_some() { Some(page.text_page()?) } else { None };
        for i in 0..page.object_count().min(MAX_TEXT_OBJECTS) {
            let obj = page.object(i);
            if obj.is_null() {
                continue;
            }
            if has_watermark_mark(b, obj) {
                found.objects.push(i as u32);
                scan.marked_objects += 1;
                continue;
            }
            if let (Some(q), Some(tp)) = (&query, &tp)
                && let Some(t) = read_text_obj(&page, tp, &display, i, obj)
            {
                let s = t.text.trim().to_lowercase();
                let exact = s == *q;
                // Fragments only count when they look like a watermark, so a body-text
                // "C" is never removed because the watermark says "CONFIDENTIAL".
                let fragment = !s.is_empty() && q.contains(&s) && (!t.upright || t.transparent);
                if exact || fragment {
                    found.objects.push(i as u32);
                    scan.matching_text += 1;
                }
            }
        }

        let annots = unsafe { b.FPDFPage_GetAnnotCount(page.h) }.clamp(0, 10_000);
        for i in 0..annots {
            let a = unsafe { b.FPDFPage_GetAnnot(page.h, i) };
            if a.is_null() {
                continue;
            }
            let subtype = unsafe { b.FPDFAnnot_GetSubtype(a) };
            unsafe { b.FPDFPage_CloseAnnot(a) };
            if subtype == FPDF_ANNOT_WATERMARK {
                found.annots.push(i as u32);
                scan.annotations += 1;
            }
        }

        if !found.objects.is_empty() || !found.annots.is_empty() {
            scan.pages.push(found);
        }
    }
    Ok(scan)
}

#[cfg(test)]
mod tests;
