//! Messages exchanged between the app (host) and the sandboxed PDF worker process,
//! plus the edit model shared with the UI.
//!
//! Wire format, in both directions, over the worker's stdin/stdout:
//!   [u32 LE header length][header JSON][u32 LE payload length][payload bytes]
//! Lengths are bounded on read so a misbehaving peer cannot make the other side
//! allocate unbounded memory.

use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};

pub type DocId = u32;

pub const MAX_HEADER_BYTES: u32 = 64 * 1024 * 1024;
pub const MAX_PAYLOAD_BYTES: u32 = 1536 * 1024 * 1024;

// ---------- Edit model (shared with the UI, camelCase JSON) ----------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FontSpec {
    pub family: String,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Align {
    #[default]
    Left,
    Center,
    Right,
    /// Flush on both sides; the last line of each paragraph stays left-aligned.
    Justify,
}

fn one() -> f32 {
    1.0
}

/// A block of text the app draws onto a page: an edited paragraph or a new text box.
/// Coordinates are in "display space": PDF points, origin at the top-left of the page
/// as shown (after the page's own /Rotate and crop box), y pointing down.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TextBlock {
    pub id: String,
    /// Left edge of the block.
    pub x: f32,
    /// Baseline of the first line.
    pub baseline: f32,
    /// Wrap width. `None` means lines only break at explicit newlines.
    pub width: Option<f32>,
    pub text: String,
    pub font: FontSpec,
    pub size: f32,
    pub color: [u8; 3],
    /// Baseline-to-baseline distance as a multiple of `size`.
    pub line_height: f32,
    #[serde(default)]
    pub align: Align,
    /// First-line indent of each paragraph (after every explicit newline), in points.
    #[serde(default)]
    pub indent: f32,
    /// Horizontal glyph scale (1 = normal). Used to match the metrics of the original
    /// font when the substitute font is a little wider.
    #[serde(default = "one")]
    pub h_scale: f32,
    /// The text continues in another box, so the last line is justified too.
    #[serde(default)]
    pub continues: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PageEdits {
    /// Indices of top-level page objects (on the original page) to remove.
    #[serde(default)]
    pub removed_objects: Vec<u32>,
    /// Indices of annotations (on the original page) to remove.
    #[serde(default)]
    pub removed_annots: Vec<u32>,
    #[serde(default)]
    pub blocks: Vec<TextBlock>,
}

impl PageEdits {
    pub fn is_empty(&self) -> bool {
        self.removed_objects.is_empty() && self.removed_annots.is_empty() && self.blocks.is_empty()
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Watermark {
    pub text: String,
    pub font: FontSpec,
    pub size: f32,
    pub color: [u8; 3],
    /// 0.0 – 1.0
    pub opacity: f32,
    /// Counter-clockwise, in degrees, as seen on screen.
    pub angle: f32,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    Jpeg,
    Png,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OutputPage {
    pub doc_id: DocId,
    pub page_index: i32,
    /// Extra clockwise rotation: 0, 90, 180 or 270.
    #[serde(default)]
    pub rotation: i32,
    #[serde(default)]
    pub edits: Option<PageEdits>,
}

// ---------- Results ----------

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    pub width: f32,
    pub height: f32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Paragraph {
    pub id: u32,
    pub object_indices: Vec<u32>,
    pub bounds: Rect,
    pub text: String,
    /// Font the app will use when this paragraph is edited (best local match).
    pub font: FontSpec,
    /// Font name as written in the PDF.
    pub source_font: String,
    pub size: f32,
    pub color: [u8; 3],
    pub line_height: f32,
    pub first_baseline: f32,
    pub align: Align,
    /// True when the paragraph has more than one line, so edits should wrap.
    pub wrap: bool,
    /// Number of lines on the page.
    pub line_count: u32,
    /// First-line indent, in points.
    pub indent: f32,
    /// Horizontal scale that makes the substitute font measure like the original.
    pub h_scale: f32,
    /// True when it mixes fonts/sizes/colors that an edit will unify.
    pub mixed_styles: bool,
}

/// A text object that is not part of an editable paragraph (rotated, invisible,
/// or otherwise unusual). It can still be selected and deleted.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LooseText {
    pub object_index: u32,
    pub bounds: Rect,
    pub text: String,
    pub rotated: bool,
    pub transparent: bool,
    pub watermark_mark: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PageText {
    pub width: f32,
    pub height: f32,
    pub paragraphs: Vec<Paragraph>,
    pub loose: Vec<LooseText>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PageWatermarks {
    pub page_index: i32,
    pub objects: Vec<u32>,
    pub annots: Vec<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkScan {
    pub pages: Vec<PageWatermarks>,
    pub marked_objects: u32,
    pub annotations: u32,
    pub matching_text: u32,
}

// ---------- Requests / responses ----------

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Request {
    /// Payload: the PDF bytes.
    #[serde(rename_all = "camelCase")]
    Open { doc_id: DocId },
    #[serde(rename_all = "camelCase")]
    Close { doc_id: DocId },
    #[serde(rename_all = "camelCase")]
    Render {
        doc_id: DocId,
        page_index: i32,
        width: i32,
        format: ImageFormat,
        /// Extra clockwise rotation: 0, 90, 180 or 270.
        #[serde(default)]
        rotation: i32,
        edits: Option<PageEdits>,
        watermark: Option<Watermark>,
    },
    #[serde(rename_all = "camelCase")]
    Extract { doc_id: DocId, page_index: i32 },
    #[serde(rename_all = "camelCase")]
    FindWatermarks { doc_id: DocId, text: Option<String> },
    Save {
        pages: Vec<OutputPage>,
        watermark: Option<Watermark>,
        sanitize: bool,
    },
    /// Line breaks for text drawn with the given style (no document needed).
    Layout(LayoutArgs),
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LayoutArgs {
    pub text: String,
    pub font: FontSpec,
    pub size: f32,
    pub width: Option<f32>,
    #[serde(default)]
    pub indent: f32,
    #[serde(default = "one")]
    pub h_scale: f32,
}

impl LayoutArgs {
    pub fn validate(&self) -> Result<(), String> {
        if self.text.chars().count() > MAX_TEXT_CHARS || self.text.contains('\r') {
            return Err("Text is too long or not normalised".into());
        }
        if !finite_in(self.size, 0.5, 1000.0)
            || self.width.is_some_and(|w| !finite_in(w, 1.0, 20_000.0))
            || !finite_in(self.indent, -5000.0, 5000.0)
            || !finite_in(self.h_scale, 0.5, 2.0)
        {
            return Err("Layout settings are out of range".into());
        }
        validate_font(&self.font)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LayoutResult {
    /// Where each line starts, as character offsets into the text.
    pub line_starts: Vec<u32>,
}

impl Request {
    /// Documents that must be loaded in the worker before this request runs.
    pub fn doc_ids(&self) -> Vec<DocId> {
        match self {
            Request::Open { .. } | Request::Close { .. } | Request::Layout(_) => vec![],
            Request::Render { doc_id, .. }
            | Request::Extract { doc_id, .. }
            | Request::FindWatermarks { doc_id, .. } => vec![*doc_id],
            Request::Save { pages, .. } => {
                let mut ids: Vec<DocId> = pages.iter().map(|p| p.doc_id).collect();
                ids.sort_unstable();
                ids.dedup();
                ids
            }
        }
    }
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Response {
    Ok { result: serde_json::Value },
    Err { message: String },
}

// ---------- Framing (blocking; the worker side) ----------

pub fn write_frame<W: Write>(w: &mut W, header: &[u8], payload: &[u8]) -> io::Result<()> {
    w.write_all(&(header.len() as u32).to_le_bytes())?;
    w.write_all(header)?;
    w.write_all(&(payload.len() as u32).to_le_bytes())?;
    w.write_all(payload)?;
    w.flush()
}

fn read_len<R: Read>(r: &mut R, max: u32) -> io::Result<usize> {
    let mut buf = [0u8; 4];
    r.read_exact(&mut buf)?;
    let len = u32::from_le_bytes(buf);
    if len > max {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
    }
    Ok(len as usize)
}

pub fn read_frame<R: Read>(r: &mut R) -> io::Result<(Vec<u8>, Vec<u8>)> {
    let n = read_len(r, MAX_HEADER_BYTES)?;
    let mut header = vec![0u8; n];
    r.read_exact(&mut header)?;
    let n = read_len(r, MAX_PAYLOAD_BYTES)?;
    let mut payload = vec![0u8; n];
    r.read_exact(&mut payload)?;
    Ok((header, payload))
}

// ---------- Framing (async; the host side) ----------

pub mod async_io {
    use super::*;
    use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

    pub async fn write_frame<W: AsyncWrite + Unpin>(
        w: &mut W,
        header: &[u8],
        payload: &[u8],
    ) -> io::Result<()> {
        if payload.len() > MAX_PAYLOAD_BYTES as usize {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "payload too large"));
        }
        w.write_all(&(header.len() as u32).to_le_bytes()).await?;
        w.write_all(header).await?;
        w.write_all(&(payload.len() as u32).to_le_bytes()).await?;
        w.write_all(payload).await?;
        w.flush().await
    }

    async fn read_len<R: AsyncRead + Unpin>(r: &mut R, max: u32) -> io::Result<usize> {
        let len = r.read_u32_le().await?;
        if len > max {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
        }
        Ok(len as usize)
    }

    pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> io::Result<(Vec<u8>, Vec<u8>)> {
        let n = read_len(r, MAX_HEADER_BYTES).await?;
        let mut header = vec![0u8; n];
        r.read_exact(&mut header).await?;
        let n = read_len(r, MAX_PAYLOAD_BYTES).await?;
        let mut payload = vec![0u8; n];
        r.read_exact(&mut payload).await?;
        Ok((header, payload))
    }
}

// ---------- Input validation ----------

pub const MAX_BLOCKS_PER_PAGE: usize = 2000;
pub const MAX_TEXT_CHARS: usize = 200_000;
pub const MAX_INDEX_LIST: usize = 200_000;

fn finite_in(v: f32, lo: f32, hi: f32) -> bool {
    v.is_finite() && v >= lo && v <= hi
}

fn validate_font(f: &FontSpec) -> Result<(), String> {
    if f.family.len() > 256 {
        return Err("Font family name is too long".into());
    }
    Ok(())
}

impl PageEdits {
    pub fn validate(&self) -> Result<(), String> {
        if self.removed_objects.len() > MAX_INDEX_LIST || self.removed_annots.len() > MAX_INDEX_LIST {
            return Err("Too many removed objects".into());
        }
        if self.blocks.len() > MAX_BLOCKS_PER_PAGE {
            return Err("Too many text blocks on one page".into());
        }
        for b in &self.blocks {
            if b.text.chars().count() > MAX_TEXT_CHARS {
                return Err("Text block is too long".into());
            }
            if !finite_in(b.x, -20_000.0, 20_000.0)
                || !finite_in(b.baseline, -20_000.0, 20_000.0)
                || !finite_in(b.size, 0.5, 1000.0)
                || !finite_in(b.line_height, 0.5, 5.0)
                || b.width.is_some_and(|w| !finite_in(w, 1.0, 20_000.0))
                || !finite_in(b.indent, -5000.0, 5000.0)
                || !finite_in(b.h_scale, 0.5, 2.0)
                || b.id.len() > 128
            {
                return Err("Text block has invalid geometry".into());
            }
            validate_font(&b.font)?;
        }
        Ok(())
    }
}

impl Watermark {
    pub fn validate(&self) -> Result<(), String> {
        if self.text.trim().is_empty() || self.text.chars().count() > 500 {
            return Err("Watermark text must be 1–500 characters".into());
        }
        if !finite_in(self.size, 1.0, 1000.0)
            || !finite_in(self.opacity, 0.0, 1.0)
            || !finite_in(self.angle, -360.0, 360.0)
        {
            return Err("Watermark settings are out of range".into());
        }
        validate_font(&self.font)
    }
}

#[cfg(test)]
mod tests;
