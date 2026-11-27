//! Font selection for new and edited text.
//!
//! Fonts embedded in the source PDF are not reused: they are often subsets (missing
//! the glyphs a user types) or in formats PDFium cannot re-embed. Instead, a
//! standard-14 font (Helvetica / Times / Courier) is used when the family matches and
//! every character is in WinAnsi, so nothing is embedded. Otherwise an installed
//! TrueType font that covers every character is embedded in full. Only system font
//! files are ever handed to PDFium's font loader.

use std::collections::HashMap;
use std::sync::Arc;

use crate::protocol::FontSpec;

const MAX_FONT_FILE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StdFamily {
    Helvetica,
    Times,
    Courier,
}

impl StdFamily {
    pub fn display_name(self) -> &'static str {
        match self {
            StdFamily::Helvetica => "Helvetica",
            StdFamily::Times => "Times",
            StdFamily::Courier => "Courier",
        }
    }

    pub fn pdf_name(self, bold: bool, italic: bool) -> &'static str {
        match (self, bold, italic) {
            (StdFamily::Helvetica, false, false) => "Helvetica",
            (StdFamily::Helvetica, true, false) => "Helvetica-Bold",
            (StdFamily::Helvetica, false, true) => "Helvetica-Oblique",
            (StdFamily::Helvetica, true, true) => "Helvetica-BoldOblique",
            (StdFamily::Times, false, false) => "Times-Roman",
            (StdFamily::Times, true, false) => "Times-Bold",
            (StdFamily::Times, false, true) => "Times-Italic",
            (StdFamily::Times, true, true) => "Times-BoldItalic",
            (StdFamily::Courier, false, false) => "Courier",
            (StdFamily::Courier, true, false) => "Courier-Bold",
            (StdFamily::Courier, false, true) => "Courier-Oblique",
            (StdFamily::Courier, true, true) => "Courier-BoldOblique",
        }
    }

    /// Installed families that look the same (used when the text needs embedding).
    fn system_equivalents(self) -> &'static [&'static str] {
        match self {
            StdFamily::Helvetica => &["Arial", "Helvetica", "Liberation Sans", "Arimo", "DejaVu Sans"],
            StdFamily::Times => &["Times New Roman", "Times", "Liberation Serif", "Tinos", "DejaVu Serif"],
            StdFamily::Courier => &["Courier New", "Courier", "Liberation Mono", "Cousine", "DejaVu Sans Mono"],
        }
    }
}

fn squash(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase()
}

pub fn std_family_for(name: &str) -> Option<StdFamily> {
    match squash(name).as_str() {
        "helvetica" | "helv" | "arial" | "arialmt" | "liberationsans" | "arimo" => {
            Some(StdFamily::Helvetica)
        }
        "times" | "timesroman" | "timesnewroman" | "timesnewromanps" | "timesnewromanpsmt"
        | "liberationserif" | "tinos" => Some(StdFamily::Times),
        "courier" | "couriernew" | "couriernewpsmt" | "liberationmono" | "cousine" => {
            Some(StdFamily::Courier)
        }
        _ => None,
    }
}

/// True when every character can be written with a standard font's WinAnsi encoding.
pub fn is_win_ansi(text: &str) -> bool {
    const CP1252_EXTRA: &str = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
    text.chars().all(|c| {
        matches!(c, '\n' | '\r' | '\t' | ' '..='~' | '\u{A0}'..='\u{FF}') || CP1252_EXTRA.contains(c)
    })
}

/// Best guess at the intended font from what the PDF says about it.
pub fn guess_from_pdf(base_name: &str, weight: i32, italic_angle: i32, flags: i32) -> FontSpec {
    // Drop a subset tag like "ABCDEF+".
    let name = match base_name.split_once('+') {
        Some((tag, rest)) if tag.len() == 6 && tag.chars().all(|c| c.is_ascii_uppercase()) => rest,
        _ => base_name,
    };
    let (family_part, style_part) = match name.find(['-', ',']) {
        Some(i) => (&name[..i], name[i + 1..].to_lowercase()),
        None => (name, String::new()),
    };
    let lower = family_part.to_lowercase();
    let style_says_bold = ["bold", "black", "heavy", "semibold", "demi"]
        .iter()
        .any(|k| style_part.contains(k) || lower.ends_with(k));
    let bold = style_says_bold || weight >= 600;
    let italic = style_part.contains("italic")
        || style_part.contains("oblique")
        || lower.ends_with("italic")
        || italic_angle != 0
        || flags & 64 != 0;

    let mut fam = family_part.to_string();
    for suffix in ["PSMT", "MT", "PS", "LTStd", "Std", "Pro", "Bold", "Italic"] {
        if fam.len() > suffix.len() + 2 && fam.ends_with(suffix) {
            fam.truncate(fam.len() - suffix.len());
        }
    }
    let family = spaced(&fam);
    let family = if family.trim().is_empty() {
        let fallback = if flags & 1 != 0 {
            StdFamily::Courier
        } else if flags & 2 != 0 {
            StdFamily::Times
        } else {
            StdFamily::Helvetica
        };
        fallback.display_name().to_string()
    } else {
        family
    };
    FontSpec { family, bold, italic }
}

/// "TimesNewRoman" → "Times New Roman".
fn spaced(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    let mut prev: Option<char> = None;
    for c in s.chars() {
        if let Some(p) = prev
            && c.is_uppercase()
            && p.is_lowercase()
        {
            out.push(' ');
        }
        out.push(c);
        prev = Some(c);
    }
    out.trim().to_string()
}

pub enum FontSource {
    Standard(&'static str),
    TrueType { key: String, data: Arc<Vec<u8>> },
}

pub struct Fonts {
    db: Option<fontdb::Database>,
    data: HashMap<fontdb::ID, Option<Arc<Vec<u8>>>>,
}

impl Default for Fonts {
    fn default() -> Self {
        Self::new()
    }
}

impl Fonts {
    pub fn new() -> Self {
        Self { db: None, data: HashMap::new() }
    }

    fn db(&mut self) -> &fontdb::Database {
        self.db.get_or_insert_with(|| {
            let mut db = fontdb::Database::new();
            db.load_system_fonts();
            db
        })
    }

    pub fn has_family(&mut self, family: &str) -> bool {
        let want = squash(family);
        self.db()
            .faces()
            .any(|f| f.families.iter().any(|(n, _)| squash(n) == want))
    }

    /// The family name the app will show and use for an edited paragraph.
    pub fn resolve_display(&mut self, spec: &FontSpec, flags: i32) -> FontSpec {
        if let Some(std) = std_family_for(&spec.family) {
            return FontSpec { family: std.display_name().into(), ..spec.clone() };
        }
        if self.has_family(&spec.family) {
            return spec.clone();
        }
        let fallback = if flags & 1 != 0 {
            StdFamily::Courier
        } else if flags & 2 != 0 {
            StdFamily::Times
        } else {
            StdFamily::Helvetica
        };
        FontSpec { family: fallback.display_name().into(), ..spec.clone() }
    }

    /// Picks the font to write `text` with.
    pub fn source_for(&mut self, spec: &FontSpec, text: &str) -> Result<FontSource, String> {
        let std = std_family_for(&spec.family);
        if let Some(std) = std
            && is_win_ansi(text)
        {
            return Ok(FontSource::Standard(std.pdf_name(spec.bold, spec.italic)));
        }

        let mut candidates: Vec<&str> = vec![spec.family.as_str()];
        if let Some(std) = std {
            candidates.extend_from_slice(std.system_equivalents());
        }
        candidates.extend_from_slice(&[
            "Arial",
            "Segoe UI",
            "Tahoma",
            "Liberation Sans",
            "DejaVu Sans",
            "Noto Sans",
            "Arial Unicode MS",
        ]);

        for family in candidates {
            if let Some((id, data)) = self.load_face(family, spec.bold, spec.italic)
                && covers(&data, text)
            {
                return Ok(FontSource::TrueType { key: format!("{id:?}"), data });
            }
        }
        // Last resort: a standard font (characters outside WinAnsi will be missing).
        Ok(FontSource::Standard(
            std.unwrap_or(StdFamily::Helvetica).pdf_name(spec.bold, spec.italic),
        ))
    }

    fn load_face(&mut self, family: &str, bold: bool, italic: bool) -> Option<(fontdb::ID, Arc<Vec<u8>>)> {
        let query = fontdb::Query {
            families: &[fontdb::Family::Name(family)],
            weight: if bold { fontdb::Weight::BOLD } else { fontdb::Weight::NORMAL },
            stretch: fontdb::Stretch::Normal,
            style: if italic { fontdb::Style::Italic } else { fontdb::Style::Normal },
        };
        let id = self.db().query(&query)?;
        if let Some(cached) = self.data.get(&id) {
            return cached.clone().map(|d| (id, d));
        }
        let loaded = self
            .db()
            .with_face_data(id, |data, index| (index == 0 && embeddable(data)).then(|| Arc::new(data.to_vec())))
            .flatten();
        self.data.insert(id, loaded.clone());
        loaded.map(|d| (id, d))
    }
}

/// Whether a font file may be embedded whole in a saved PDF.
///
/// PDFium embeds whole TrueType files only: no collections, no CFF. The font's
/// license must also allow embedding: OS/2 `fsType` "Restricted" forbids it.
/// Preview & Print, Editable and Installable all allow it.
fn embeddable(data: &[u8]) -> bool {
    if data.len() > MAX_FONT_FILE_BYTES || data.len() <= 12 || &data[..4] == b"ttcf" || &data[..4] == b"OTTO" {
        return false;
    }
    let Ok(face) = ttf_parser::Face::parse(data, 0) else {
        return false;
    };
    face.permissions() != Some(ttf_parser::Permissions::Restricted)
}

fn covers(data: &[u8], text: &str) -> bool {
    let Ok(face) = ttf_parser::Face::parse(data, 0) else {
        return false;
    };
    text.chars()
        .filter(|c| !c.is_whitespace() && !c.is_control())
        .all(|c| face.glyph_index(c).is_some())
}

/// Installed font families for the UI, standard families first.
pub fn list_families() -> Vec<String> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    let mut names: Vec<String> = db
        .faces()
        .filter_map(|f| f.families.first().map(|(n, _)| n.clone()))
        .filter(|n| !n.starts_with('.') && !n.starts_with('@'))
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    names.dedup();
    let mut out: Vec<String> = ["Helvetica", "Times", "Courier"].map(String::from).to_vec();
    out.extend(
        names
            .into_iter()
            .filter(|n| !matches!(n.as_str(), "Helvetica" | "Times" | "Courier")),
    );
    out
}

#[cfg(test)]
mod tests;
