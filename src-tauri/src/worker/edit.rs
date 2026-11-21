//! Applies edits to pages, renders pages and builds output documents.
//!
//! Edits are a pure description (see `protocol::PageEdits`); source documents are
//! never modified. Rendering an edited page copies that one page into a scratch
//! document first, and saving copies every page into a fresh document.

use std::collections::{HashMap, HashSet};
use std::ffi::{c_int, c_uint, c_ulong};
use std::io::Cursor;

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder};
use pdfium_render::prelude::{FPDF_FONT, FPDF_PAGEOBJECT, FS_MATRIX};

use super::content;
use super::fonts::{FontSource, Fonts};
use super::pdf::{
    Doc, FPDF_ANNOT_FILEATTACHMENT, FPDF_ANNOT_LINK, FPDF_ANNOT_MOVIE, FPDF_ANNOT_RICHMEDIA,
    FPDF_ANNOT_SCREEN, FPDF_ANNOT_SOUND, FPDF_ANNOT_THREED, FPDF_FONT_TRUETYPE, FontCache, Lib,
    PDFACTION_GOTO, PDFACTION_URI, Page, to_wide,
};
use crate::geometry::Matrix;
use crate::protocol::{
    Align, DocId, FontSpec, ImageFormat, OutputPage, PageEdits, TextBlock, Watermark,
};

pub const MAX_RENDER_WIDTH: i32 = 4000;
pub const MAX_RENDER_HEIGHT: i32 = 6000;
const MAX_OUTPUT_PAGES: usize = 100_000;

// ---------- layout (pure) ----------

#[derive(Debug, PartialEq)]
pub struct LaidLine {
    pub text: String,
    pub width: f32,
    /// Byte offset in the input where this line starts.
    pub start: usize,
}

/// Breaks `text` into lines. Explicit newlines always break; with `wrap` set, lines
/// also break between words (or inside a word that is wider than the box). The first
/// line of each paragraph (after an explicit newline) is `indent` narrower.
pub fn layout(
    text: &str,
    wrap: Option<f32>,
    indent: f32,
    measure: &mut dyn FnMut(&str) -> f32,
) -> Vec<LaidLine> {
    let mut out = Vec::new();
    fn push(out: &mut Vec<LaidLine>, measure: &mut dyn FnMut(&str) -> f32, s: &str, start: usize) {
        let t = s.trim_end().to_string();
        let width = measure(&t);
        out.push(LaidLine { text: t, width, start });
    }
    let mut hard_start = 0usize;
    for hard in text.split('\n') {
        let Some(max) = wrap else {
            push(&mut out, &mut *measure, hard, hard_start);
            hard_start += hard.len() + 1;
            continue;
        };
        let first_line = out.len();
        let limit = |out: &Vec<LaidLine>| if out.len() == first_line { max - indent } else { max };
        let mut current = String::new();
        let mut cur_start = hard_start;
        let mut pos = hard_start;
        for token in hard.split_inclusive(' ') {
            let candidate = format!("{current}{token}");
            if current.trim().is_empty() || measure(candidate.trim_end()) <= limit(&out) {
                current = candidate;
            } else {
                push(&mut out, &mut *measure, &current, cur_start);
                current = token.to_string();
                cur_start = pos;
            }
            pos += token.len();
            // A single word wider than the box: break it between characters.
            while measure(current.trim_end()) > limit(&out) && current.trim_end().chars().count() > 1 {
                let max = limit(&out);
                let chars: Vec<char> = current.chars().collect();
                let mut fit = 1;
                while fit < chars.len() && measure(&chars[..=fit].iter().collect::<String>()) <= max {
                    fit += 1;
                }
                let head: String = chars[..fit].iter().collect();
                let head_len = head.len();
                push(&mut out, &mut *measure, &head, cur_start);
                cur_start += head_len;
                current = chars[fit..].iter().collect();
            }
        }
        push(&mut out, &mut *measure, &current, cur_start);
        hard_start += hard.len() + 1;
    }
    out
}

/// Line starts of `text` as character (Unicode scalar) offsets, for the UI.
pub fn line_starts_in_chars(text: &str, lines: &[LaidLine]) -> Vec<u32> {
    let mut out = Vec::with_capacity(lines.len());
    let (mut chars, mut last) = (0usize, 0usize);
    for l in lines {
        chars += text[last..l.start].chars().count();
        last = l.start;
        out.push(chars as u32);
    }
    out
}

/// True when line `i` is the first line of a paragraph (start of text or after a newline).
fn starts_paragraph(text: &str, lines: &[LaidLine], i: usize) -> bool {
    i == 0 || text[..lines[i].start].ends_with('\n')
}

// ---------- writing text into a document ----------

enum Metrics {
    Pdf(FPDF_FONT),
    Ttf { advances: HashMap<char, f32>, data: std::sync::Arc<Vec<u8>> },
}

pub struct Writer<'a, 'l> {
    doc: &'a Doc<'l>,
    cache: FontCache<'l>,
    fonts: &'a mut Fonts,
}

impl<'a, 'l> Writer<'a, 'l> {
    pub fn new(doc: &'a Doc<'l>, fonts: &'a mut Fonts) -> Self {
        Self { doc, cache: FontCache::new(doc.lib), fonts }
    }

    fn font_for(&mut self, spec: &FontSpec, text: &str) -> Result<(FPDF_FONT, Metrics), String> {
        let b = self.doc.lib.b();
        let doc_h = self.doc.h;
        match self.fonts.source_for(spec, text)? {
            FontSource::Standard(name) => {
                let f = self
                    .cache
                    .get_or_load(name, || unsafe { b.FPDFText_LoadStandardFont(doc_h, name) })?;
                Ok((f, Metrics::Pdf(f)))
            }
            FontSource::TrueType { key, data } => {
                let f = self.cache.get_or_load(&key, || unsafe {
                    b.FPDFText_LoadFont(
                        doc_h,
                        data.as_ptr(),
                        data.len() as c_uint,
                        FPDF_FONT_TRUETYPE,
                        1,
                    )
                })?;
                Ok((f, Metrics::Ttf { advances: HashMap::new(), data }))
            }
        }
    }

    fn measure(&self, metrics: &mut Metrics, size: f32, s: &str) -> f32 {
        match metrics {
            Metrics::Pdf(font) => {
                let b = self.doc.lib.b();
                s.chars()
                    .map(|c| {
                        let mut w = 0f32;
                        unsafe { b.FPDFFont_GetGlyphWidth(*font, c as u32, size, &mut w) };
                        w
                    })
                    .sum()
            }
            Metrics::Ttf { advances, data } => {
                let face = ttf_parser::Face::parse(data, 0).ok();
                let upem = face.as_ref().map_or(1000.0, |f| f.units_per_em() as f32);
                s.chars()
                    .map(|c| {
                        *advances.entry(c).or_insert_with(|| {
                            face.as_ref()
                                .and_then(|f| f.glyph_index(c).and_then(|g| f.glyph_hor_advance(g)))
                                .map_or(0.0, |a| a as f32 / upem)
                        }) * size
                    })
                    .sum()
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn add_run(
        &self,
        page: &Page,
        font: FPDF_FONT,
        size: f32,
        text: &str,
        matrix: Matrix,
        rgb: [u8; 3],
        alpha: u8,
    ) -> Result<FPDF_PAGEOBJECT, String> {
        let b = self.doc.lib.b();
        unsafe {
            let obj = b.FPDFPageObj_CreateTextObj(self.doc.h, font, size);
            if obj.is_null() {
                return Err("Could not create a text object".into());
            }
            let wide = to_wide(text);
            if b.FPDFText_SetText(obj, wide.as_ptr()) == 0 {
                b.FPDFPageObj_Destroy(obj);
                return Err("Could not set text".into());
            }
            b.FPDFPageObj_SetFillColor(obj, rgb[0] as c_uint, rgb[1] as c_uint, rgb[2] as c_uint, alpha as c_uint);
            let m: FS_MATRIX = matrix.into();
            b.FPDFPageObj_SetMatrix(obj, &m);
            let _ = b.FPDFPage_InsertObject(page.h, obj);
            Ok(obj)
        }
    }

    /// Lays out text with the same fonts and metrics used to draw it.
    pub fn measure_lines(
        &mut self,
        text: &str,
        font: &FontSpec,
        size: f32,
        width: Option<f32>,
        indent: f32,
        h_scale: f32,
    ) -> Result<Vec<LaidLine>, String> {
        let (_, mut metrics) = self.font_for(font, if text.is_empty() { " " } else { text })?;
        let mut measure = |s: &str| self.measure(&mut metrics, size, s) * h_scale;
        Ok(layout(text, width, indent, &mut measure))
    }

    /// Natural width of each string when drawn in `font` (no horizontal scaling).
    pub fn text_widths(&mut self, font: &FontSpec, size: f32, texts: &[&str]) -> Result<Vec<f32>, String> {
        let all = texts.concat();
        let (_, mut metrics) = self.font_for(font, if all.is_empty() { " " } else { &all })?;
        Ok(texts.iter().map(|t| self.measure(&mut metrics, size, t)).collect())
    }

    /// Applies removals and text blocks. Returns true when PDFium must regenerate the
    /// page content (objects were removed or added).
    pub fn apply_edits(&mut self, page: &Page, edits: &PageEdits) -> Result<bool, String> {
        self.apply_edits_with(page, edits, true)
    }

    /// Like `apply_edits`, but with `remove_objects` false the objects to remove stay
    /// on the page: the caller removes them from the saved content bytes instead (see
    /// `content.rs`), because PDFium rewriting the original content damages it.
    pub fn apply_edits_with(&mut self, page: &Page, edits: &PageEdits, remove_objects: bool) -> Result<bool, String> {
        edits.validate()?;
        let b = self.doc.lib.b();
        let display = page.display_matrix();
        let inv = display.invert().ok_or("Page has an invalid size")?;

        // Collect handles first: removing shifts the indices of later objects.
        let count = page.object_count().max(0) as u32;
        let mut indices: Vec<u32> = edits.removed_objects.iter().copied().filter(|&i| i < count).collect();
        indices.sort_unstable();
        indices.dedup();
        if !remove_objects {
            indices.clear();
        }
        let objs: Vec<FPDF_PAGEOBJECT> = indices.iter().map(|&i| page.object(i as i32)).collect();
        for obj in &objs {
            if !obj.is_null() && unsafe { b.FPDFPage_RemoveObject(page.h, *obj) } != 0 {
                unsafe { b.FPDFPageObj_Destroy(*obj) };
            }
        }

        let annot_count = unsafe { b.FPDFPage_GetAnnotCount(page.h) }.max(0) as u32;
        let mut annots: Vec<u32> = edits.removed_annots.iter().copied().filter(|&i| i < annot_count).collect();
        annots.sort_unstable_by(|a, b| b.cmp(a));
        annots.dedup();
        for i in annots {
            unsafe { b.FPDFPage_RemoveAnnot(page.h, i as c_int) };
        }

        for block in &edits.blocks {
            self.draw_block(page, &inv, block)?;
        }
        Ok(!objs.is_empty() || !edits.blocks.is_empty())
    }

    fn draw_block(&mut self, page: &Page, inv: &Matrix, block: &TextBlock) -> Result<(), String> {
        let text = block.text.replace("\r\n", "\n").replace('\r', "\n");
        if text.trim().is_empty() {
            return Ok(());
        }
        let (font, mut metrics) = self.font_for(&block.font, &text)?;
        let size = block.size;
        let hs = block.h_scale;
        let line_step = size * block.line_height;
        let scale = Matrix::new(hs, 0.0, 0.0, 1.0, 0.0, 0.0);

        // Work out every run first, so the borrow of `self` by `measure` ends before drawing.
        let mut runs: Vec<(f32, usize, String)> = Vec::new();
        {
            let mut measure = |s: &str| self.measure(&mut metrics, size, s) * hs;
            let lines = layout(&text, block.width, block.indent, &mut measure);
            let widest = lines
                .iter()
                .enumerate()
                .map(|(i, l)| l.width + if starts_paragraph(&text, &lines, i) { block.indent } else { 0.0 })
                .fold(0.0, f32::max);
            let box_width = block.width.unwrap_or(widest);
            for (i, line) in lines.iter().enumerate() {
                if line.text.is_empty() {
                    continue;
                }
                let indent = if starts_paragraph(&text, &lines, i) { block.indent } else { 0.0 };
                let left = block.x + indent;
                let avail = box_width - indent;
                let last_line = i + 1 == lines.len();
                let last_of_paragraph = last_line || starts_paragraph(&text, &lines, i + 1);
                let justify = block.align == Align::Justify
                    && block.width.is_some()
                    && (!last_of_paragraph || (last_line && block.continues));
                if justify {
                    let words: Vec<&str> = line.text.split(' ').filter(|w| !w.is_empty()).collect();
                    if words.len() > 1 {
                        let widths: Vec<f32> = words.iter().map(|w| measure(w)).collect();
                        let gap = (avail - widths.iter().sum::<f32>()) / (words.len() - 1) as f32;
                        // A nearly empty line would be stretched absurdly: leave it ragged.
                        // (Gaps above one em would also read as column breaks on extraction.)
                        if gap > 0.0 && gap < size * 1.15 {
                            let mut x = left;
                            for (w, ww) in words.iter().zip(&widths) {
                                runs.push((x, i, (*w).to_string()));
                                x += ww + gap;
                            }
                            continue;
                        }
                    }
                }
                let x = match block.align {
                    Align::Left | Align::Justify => left,
                    Align::Center => left + (avail - line.width) / 2.0,
                    Align::Right => left + avail - line.width,
                };
                runs.push((x, i, line.text.clone()));
            }
        }
        for (x, i, t) in runs {
            let y = block.baseline + i as f32 * line_step;
            let m = scale.then(&Matrix::glyph_to_display(x, y, 0.0)).then(inv);
            self.add_run(page, font, size, &t, m, block.color, 255)?;
        }
        Ok(())
    }

    /// Draws a watermark centred on the page and tags it as a PDF watermark artifact,
    /// so it can be found (and removed) later.
    pub fn draw_watermark(&mut self, page: &Page, wm: &Watermark) -> Result<(), String> {
        wm.validate()?;
        let b = self.doc.lib.b();
        let display = page.display_matrix();
        let inv = display.invert().ok_or("Page has an invalid size")?;
        let (pw, ph) = page.size();
        let text = wm.text.replace(['\r', '\n'], " ");
        let (font, mut metrics) = self.font_for(&wm.font, &text)?;
        let w = self.measure(&mut metrics, wm.size, &text);
        let (s, c) = wm.angle.to_radians().sin_cos();
        let cap = 0.35 * wm.size;
        let dx = c * w / 2.0 - s * cap;
        let dy = -s * w / 2.0 - c * cap;
        let m = Matrix::glyph_to_display(pw / 2.0 - dx, ph / 2.0 - dy, wm.angle).then(&inv);
        let alpha = (wm.opacity.clamp(0.0, 1.0) * 255.0).round() as u8;
        let obj = self.add_run(page, font, wm.size, &text, m, wm.color, alpha)?;
        unsafe {
            let mark = b.FPDFPageObj_AddMark(obj, "Artifact");
            if !mark.is_null() {
                b.FPDFPageObjMark_SetStringParam(self.doc.h, obj, mark, "Type", "Pagination");
                b.FPDFPageObjMark_SetStringParam(self.doc.h, obj, mark, "Subtype", "Watermark");
            }
        }
        Ok(())
    }
}

/// Removes annotations that can run code, launch files or carry embedded content.
/// Returns how many were removed.
pub fn sanitize_page(doc: &Doc, page: &Page) -> u32 {
    let b = doc.lib.b();
    let n = unsafe { b.FPDFPage_GetAnnotCount(page.h) }.clamp(0, 100_000);
    let mut removed = 0;
    for i in (0..n).rev() {
        let a = unsafe { b.FPDFPage_GetAnnot(page.h, i) };
        if a.is_null() {
            continue;
        }
        let subtype = unsafe { b.FPDFAnnot_GetSubtype(a) };
        let remove = match subtype {
            FPDF_ANNOT_FILEATTACHMENT | FPDF_ANNOT_SOUND | FPDF_ANNOT_MOVIE | FPDF_ANNOT_SCREEN
            | FPDF_ANNOT_RICHMEDIA | FPDF_ANNOT_THREED => true,
            FPDF_ANNOT_LINK => unsafe {
                let link = b.FPDFAnnot_GetLink(a);
                let action = if link.is_null() { std::ptr::null_mut() } else { b.FPDFLink_GetAction(link) };
                if action.is_null() {
                    false
                } else {
                    match b.FPDFAction_GetType(action) {
                        PDFACTION_GOTO => false,
                        PDFACTION_URI => !uri_is_safe(doc, action),
                        // JavaScript, Launch, remote/embedded GoTo and anything unknown.
                        _ => true,
                    }
                }
            },
            _ => false,
        };
        unsafe { b.FPDFPage_CloseAnnot(a) };
        if remove && unsafe { b.FPDFPage_RemoveAnnot(page.h, i) } != 0 {
            removed += 1;
        }
    }
    removed
}

fn uri_is_safe(doc: &Doc, action: pdfium_render::prelude::FPDF_ACTION) -> bool {
    let b = doc.lib.b();
    let needed = unsafe { b.FPDFAction_GetURIPath(doc.h, action, std::ptr::null_mut(), 0) } as usize;
    if needed == 0 || needed > 64 * 1024 {
        return false;
    }
    let mut buf = vec![0u8; needed];
    unsafe {
        b.FPDFAction_GetURIPath(doc.h, action, buf.as_mut_ptr() as *mut _, needed as c_ulong)
    };
    let uri = String::from_utf8_lossy(&buf).trim_end_matches('\0').trim().to_ascii_lowercase();
    uri.starts_with("http://") || uri.starts_with("https://") || uri.starts_with("mailto:")
}

// ---------- rendering ----------

pub fn render_size(page_w: f32, page_h: f32, width: i32) -> (i32, i32) {
    let mut w = width.clamp(16, MAX_RENDER_WIDTH);
    let aspect = if page_w > 0.0 { page_h / page_w } else { 1.414 };
    let mut h = (w as f32 * aspect).round() as i32;
    if h > MAX_RENDER_HEIGHT {
        h = MAX_RENDER_HEIGHT;
        w = ((h as f32 / aspect).round() as i32).max(1);
    }
    (w.max(1), h.max(1))
}

/// Drops the alpha channel in place, so a large page needs one pixel buffer, not two.
fn rgba_to_rgb(mut px: Vec<u8>) -> Vec<u8> {
    let n = px.len() / 4;
    for i in 0..n {
        let (s, d) = (i * 4, i * 3);
        px[d] = px[s];
        px[d + 1] = px[s + 1];
        px[d + 2] = px[s + 2];
    }
    px.truncate(n * 3);
    px
}

fn encode(rgba: Vec<u8>, w: i32, h: i32, format: ImageFormat) -> Result<Vec<u8>, String> {
    let rgb = rgba_to_rgb(rgba);
    let mut out = Cursor::new(Vec::with_capacity(rgb.len() / 8));
    let res = match format {
        ImageFormat::Jpeg => JpegEncoder::new_with_quality(&mut out, 85).write_image(
            &rgb,
            w as u32,
            h as u32,
            ExtendedColorType::Rgb8,
        ),
        ImageFormat::Png => PngEncoder::new_with_quality(&mut out, CompressionType::Fast, FilterType::Sub)
            .write_image(&rgb, w as u32, h as u32, ExtendedColorType::Rgb8),
    };
    drop(rgb);
    res.map_err(|e| format!("Could not encode the page image: {e}"))?;
    Ok(out.into_inner())
}

fn render_loaded(page: &Page, width: i32, extra_quarter_turns: i32, format: ImageFormat) -> Result<Vec<u8>, String> {
    let (mut pw, mut ph) = page.size();
    if extra_quarter_turns.rem_euclid(2) == 1 {
        std::mem::swap(&mut pw, &mut ph);
    }
    let (w, h) = render_size(pw, ph, width);
    let rgba = page.render_rgba(w, h, extra_quarter_turns)?;
    encode(rgba, w, h, format)
}

#[allow(clippy::too_many_arguments)]
pub fn render(
    lib: &Lib,
    src: &Doc,
    page_index: i32,
    width: i32,
    format: ImageFormat,
    rotation: i32,
    edits: Option<&PageEdits>,
    watermark: Option<&Watermark>,
    fonts: &mut Fonts,
) -> Result<Vec<u8>, String> {
    let quarter = rotation.rem_euclid(360) / 90;
    let edits = edits.filter(|e| !e.is_empty());
    if edits.is_none() && watermark.is_none() {
        let page = src.page(page_index)?;
        return render_loaded(&page, width, quarter, format);
    }

    let scratch = Doc::new_empty(lib)?;
    scratch.import_pages(src, &[page_index])?;
    let page = scratch.page(0)?;
    {
        let mut writer = Writer::new(&scratch, fonts);
        if let Some(e) = edits {
            writer.apply_edits(&page, e)?;
        }
        if quarter != 0 {
            page.set_rotation(page.rotation() + quarter);
        }
        if let Some(wm) = watermark {
            writer.draw_watermark(&page, wm)?;
        }
    }
    render_loaded(&page, width, 0, format)
}

// ---------- saving ----------

/// The saved document, plus warnings for the user.
pub struct Saved {
    pub bytes: Vec<u8>,
    pub warnings: Vec<String>,
}

pub fn save(
    lib: &Lib,
    docs: &HashMap<DocId, Doc>,
    pages: &[OutputPage],
    watermark: Option<&Watermark>,
    sanitize: bool,
    fonts: &mut Fonts,
) -> Result<Saved, String> {
    if pages.is_empty() {
        return Err("There are no pages to save.".into());
    }
    if pages.len() > MAX_OUTPUT_PAGES {
        return Err("Too many pages.".into());
    }
    if let Some(wm) = watermark {
        wm.validate()?;
    }

    // Removed objects are cut out of the saved content bytes, leaving the rest of the
    // page byte-for-byte as it was (see `content.rs`). Pages where that cannot be done
    // safely fall back to PDFium removing them, which may disturb the page's layout.
    let mut fallback: HashSet<usize> = HashSet::new();
    for _ in 0..2 {
        let (bytes, removals) = build(lib, docs, pages, watermark, sanitize, fonts, &fallback)?;
        if removals.is_empty() {
            return Ok(Saved { bytes, warnings: fallback_warnings(&fallback) });
        }
        match content::apply_removals(&bytes, &removals) {
            Ok(bytes) => {
                // The result must still open in PDFium.
                let check = Doc::load(lib, bytes.clone()).map_err(|e| format!("The edited file failed a check: {e}"))?;
                if check.page_count() as usize != pages.len() {
                    return Err("The edited file failed a check: page count changed.".into());
                }
                return Ok(Saved { bytes, warnings: fallback_warnings(&fallback) });
            }
            Err(content::RemovalError::Pages(failed)) => fallback.extend(failed),
            Err(content::RemovalError::Document(_)) => fallback.extend(removals.iter().map(|r| r.page)),
        }
    }
    Err("Could not save the edited pages.".into())
}

fn fallback_warnings(pages: &HashSet<usize>) -> Vec<String> {
    if pages.is_empty() {
        return Vec::new();
    }
    let mut list: Vec<usize> = pages.iter().map(|p| p + 1).collect();
    list.sort_unstable();
    let list: Vec<String> = list.iter().map(|n| n.to_string()).collect();
    vec![format!(
        "Page {} could not be edited in place, so its content was rewritten. Check its layout and spacing.",
        list.join(", ")
    )]
}

/// Builds the output with PDFium. Objects to remove stay in place (except on
/// `pdfium_removal` pages); they are returned for `content::apply_removals`.
#[allow(clippy::too_many_arguments)]
fn build(
    lib: &Lib,
    docs: &HashMap<DocId, Doc>,
    pages: &[OutputPage],
    watermark: Option<&Watermark>,
    sanitize: bool,
    fonts: &mut Fonts,
    pdfium_removal: &HashSet<usize>,
) -> Result<(Vec<u8>, Vec<content::PageRemoval>), String> {
    // Only catalog-free page copies end up in `out`: document-level JavaScript,
    // OpenAction, embedded files and XFA from the sources are never carried over.
    let out = Doc::new_empty(lib)?;
    let mut i = 0;
    while i < pages.len() {
        let mut j = i;
        while j + 1 < pages.len() && pages[j + 1].doc_id == pages[i].doc_id {
            j += 1;
        }
        let src = docs
            .get(&pages[i].doc_id)
            .ok_or("A source document is no longer open")?;
        let indices: Vec<i32> = pages[i..=j].iter().map(|p| p.page_index).collect();
        out.import_pages(src, &indices)?;
        i = j + 1;
    }

    let mut removals = Vec::new();
    {
        let mut writer = Writer::new(&out, fonts);
        for (k, p) in pages.iter().enumerate() {
            let edits = p.edits.as_ref().filter(|e| !e.is_empty());
            let quarter = p.rotation.rem_euclid(360) / 90;
            if edits.is_none() && quarter == 0 && watermark.is_none() && !sanitize {
                continue;
            }
            let page = out.page(k as i32)?;
            let mut changed = false;
            if let Some(e) = edits {
                let in_pdfium = pdfium_removal.contains(&k);
                let count = page.object_count().max(0) as u32;
                let mut remove: Vec<u32> = e.removed_objects.iter().copied().filter(|&i| i < count).collect();
                remove.sort_unstable();
                remove.dedup();
                if !in_pdfium && !remove.is_empty() {
                    // Describe the original objects before new ones are added.
                    removals.push(content::PageRemoval { page: k, objects: content::describe_objects(&page), remove });
                }
                changed |= writer.apply_edits_with(&page, e, in_pdfium)?;
            }
            if quarter != 0 {
                page.set_rotation(page.rotation() + quarter);
            }
            if let Some(wm) = watermark {
                writer.draw_watermark(&page, wm)?;
                changed = true;
            }
            if sanitize {
                sanitize_page(&out, &page);
            }
            if changed {
                page.generate_content()?;
            }
        }
    }
    Ok((out.save()?, removals))
}

#[cfg(test)]
mod tests;
