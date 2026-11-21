//! Byte-level removal of objects from a page content stream.
//!
//! Why not let PDFium do it: removing an object makes PDFium rewrite the whole content
//! stream that held it, and its writer drops per-glyph spacing (`TJ` offsets, `Tw`),
//! which ruins justified text. Worse, many PDFs (Word's export among them) split one
//! text block across several streams, with later streams positioning text relative to
//! where the earlier one stopped; rewriting one stream then shifts every stream after it.
//!
//! So instead we edit the decoded content bytes directly: find the operators that
//! produced the objects to remove and splice out exactly those, leaving every other
//! byte unchanged.
//!
//! Matching uses PDFium's own object list: PDFium creates top-level objects in the
//! order of their painting operators, so we walk the operators, pair each PDFium object
//! with the next operator of the same kind, and for text also require the same origin.
//! If the two cannot be paired, nothing is changed and an error is returned.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObjKind {
    Text,
    Path,
    Image,
    Shading,
    Form,
}

/// What PDFium reports for one top-level page object.
#[derive(Clone, Debug)]
pub struct ObjDesc {
    pub kind: ObjKind,
    /// Text objects: origin of the first glyph in page space (the matrix's e, f).
    pub origin: Option<(f32, f32)>,
}

// ---------- tokenizer ----------

#[derive(Clone, Debug)]
enum Operand {
    Num(f32),
    /// A string; `true` when it holds no bytes.
    Str(bool),
    Arr(Vec<Operand>),
    Other,
}

struct Op {
    /// Start of the first operand (or of the operator when it has none).
    start: usize,
    /// Start of the operator keyword.
    op_start: usize,
    end: usize,
    name: Vec<u8>,
    operands: Vec<Operand>,
    operand_spans: Vec<(usize, usize)>,
}

fn is_ws(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\r' | b'\n' | b'\x0c' | b'\0')
}

fn is_delim(c: u8) -> bool {
    matches!(c, b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%')
}

struct Lexer<'a> {
    s: &'a [u8],
    i: usize,
}

enum Tok {
    Operand(Operand),
    ArrEnd,
    DictEnd,
    Keyword(usize, usize),
}

impl<'a> Lexer<'a> {
    fn skip_ws(&mut self) {
        while self.i < self.s.len() {
            let c = self.s[self.i];
            if is_ws(c) {
                self.i += 1;
            } else if c == b'%' {
                while self.i < self.s.len() && !matches!(self.s[self.i], b'\r' | b'\n') {
                    self.i += 1;
                }
            } else {
                break;
            }
        }
    }

    fn literal_string(&mut self) -> Result<bool, String> {
        // At '('.
        self.i += 1;
        let start = self.i;
        let mut depth = 1;
        while self.i < self.s.len() {
            match self.s[self.i] {
                b'\\' => self.i += 2,
                b'(' => {
                    depth += 1;
                    self.i += 1;
                }
                b')' => {
                    depth -= 1;
                    self.i += 1;
                    if depth == 0 {
                        return Ok(self.i - 1 == start);
                    }
                }
                _ => self.i += 1,
            }
        }
        Err("Unterminated string in page content".into())
    }

    fn next(&mut self) -> Result<Option<(usize, Tok)>, String> {
        self.skip_ws();
        if self.i >= self.s.len() {
            return Ok(None);
        }
        let start = self.i;
        let c = self.s[self.i];
        let tok = match c {
            b'(' => Tok::Operand(Operand::Str(self.literal_string()?)),
            b'<' if self.s.get(self.i + 1) == Some(&b'<') => {
                self.i += 2;
                let mut depth = 1;
                loop {
                    match self.next()? {
                        None => return Err("Unterminated dictionary in page content".into()),
                        Some((_, Tok::DictEnd)) => {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        Some(_) => {}
                    }
                }
                Tok::Operand(Operand::Other)
            }
            b'<' => {
                self.i += 1;
                let mut empty = true;
                while self.i < self.s.len() && self.s[self.i] != b'>' {
                    if !is_ws(self.s[self.i]) {
                        empty = false;
                    }
                    self.i += 1;
                }
                self.i += 1;
                Tok::Operand(Operand::Str(empty))
            }
            b'>' if self.s.get(self.i + 1) == Some(&b'>') => {
                self.i += 2;
                Tok::DictEnd
            }
            b'[' => {
                self.i += 1;
                let mut items = Vec::new();
                loop {
                    match self.next()? {
                        None => return Err("Unterminated array in page content".into()),
                        Some((_, Tok::ArrEnd)) => break,
                        Some((_, Tok::Operand(o))) => items.push(o),
                        Some(_) => items.push(Operand::Other),
                    }
                }
                Tok::Operand(Operand::Arr(items))
            }
            b']' => {
                self.i += 1;
                Tok::ArrEnd
            }
            b'/' => {
                self.i += 1;
                while self.i < self.s.len() && !is_ws(self.s[self.i]) && !is_delim(self.s[self.i]) {
                    self.i += 1;
                }
                Tok::Operand(Operand::Other)
            }
            _ => {
                while self.i < self.s.len() && !is_ws(self.s[self.i]) && !is_delim(self.s[self.i]) {
                    self.i += 1;
                }
                if self.i == start {
                    // A stray delimiter such as ')' or '}': skip it.
                    self.i += 1;
                    return self.next();
                }
                let word = &self.s[start..self.i];
                if let Some(n) = std::str::from_utf8(word).ok().and_then(|w| w.parse::<f32>().ok()) {
                    Tok::Operand(Operand::Num(n))
                } else if matches!(word, b"true" | b"false" | b"null") {
                    Tok::Operand(Operand::Other)
                } else {
                    Tok::Keyword(start, self.i)
                }
            }
        };
        Ok(Some((start, tok)))
    }

    /// After `ID`: skip the inline image data up to and including `EI`.
    fn skip_inline_image(&mut self) -> Result<(), String> {
        self.i += 1; // the single whitespace after ID
        while self.i + 1 < self.s.len() {
            let at_ei = &self.s[self.i..self.i + 2] == b"EI"
                && self.i > 0
                && is_ws(self.s[self.i - 1])
                && self.s.get(self.i + 2).is_none_or(|&c| is_ws(c));
            if at_ei {
                self.i += 2;
                return Ok(());
            }
            self.i += 1;
        }
        Err("Unterminated inline image in page content".into())
    }
}

fn tokenize(s: &[u8]) -> Result<Vec<Op>, String> {
    let mut lx = Lexer { s, i: 0 };
    let mut ops = Vec::new();
    let mut operands = Vec::new();
    let mut spans = Vec::new();
    while let Some((start, tok)) = lx.next()? {
        match tok {
            Tok::Operand(o) => {
                operands.push(o);
                spans.push((start, lx.i));
            }
            Tok::ArrEnd | Tok::DictEnd => {}
            Tok::Keyword(a, b) => {
                let name = s[a..b].to_vec();
                let op_start = spans.first().map_or(a, |sp| sp.0);
                if name == b"BI" {
                    // Inline image: BI <dict entries> ID <data> EI is one object.
                    loop {
                        match lx.next()? {
                            None => return Err("Unterminated inline image in page content".into()),
                            Some((ka, Tok::Keyword(_, kb))) if &s[ka..kb] == b"ID" => break,
                            Some(_) => {}
                        }
                    }
                    lx.skip_inline_image()?;
                }
                ops.push(Op {
                    start: op_start,
                    op_start: a,
                    end: lx.i,
                    name,
                    operands: std::mem::take(&mut operands),
                    operand_spans: std::mem::take(&mut spans),
                });
            }
        }
    }
    Ok(ops)
}

// ---------- interpretation ----------

type M = [f32; 6];
const IDENTITY: M = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// `a` then `b`.
fn mul(a: &M, b: &M) -> M {
    [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ]
}

fn nums(op: &Op) -> Vec<f32> {
    op.operands
        .iter()
        .filter_map(|o| if let Operand::Num(n) = o { Some(*n) } else { None })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EventKind {
    Text,
    Path,
    XObject,
    InlineImage,
    Shading,
}

struct Event {
    kind: EventKind,
    op: usize,
    origin: Option<(f32, f32)>,
    /// Text render mode in effect (to restore after hiding a run).
    render_mode: i32,
}

fn shows_text(op: &Op) -> bool {
    let has_text = |o: &Operand| match o {
        Operand::Str(empty) => !empty,
        Operand::Arr(items) => items.iter().any(|i| matches!(i, Operand::Str(false))),
        _ => false,
    };
    op.operands.last().is_some_and(has_text)
}

fn interpret(ops: &[Op]) -> Vec<Event> {
    let mut events = Vec::new();
    let mut ctm = IDENTITY;
    let mut stack: Vec<(M, i32)> = Vec::new();
    let (mut tm, mut tlm) = (IDENTITY, IDENTITY);
    let mut leading = 0.0f32;
    let mut render_mode = 0;
    let mut known = true;
    let mut path_open = false;

    for (k, op) in ops.iter().enumerate() {
        let n = nums(op);
        let next_line = |tm: &mut M, tlm: &mut M, tx: f32, ty: f32| {
            *tlm = mul(&[1.0, 0.0, 0.0, 1.0, tx, ty], tlm);
            *tm = *tlm;
        };
        match op.name.as_slice() {
            b"q" => stack.push((ctm, render_mode)),
            b"Q" => {
                if let Some((c, r)) = stack.pop() {
                    ctm = c;
                    render_mode = r;
                }
            }
            b"cm" if n.len() == 6 => ctm = mul(&[n[0], n[1], n[2], n[3], n[4], n[5]], &ctm),
            b"BT" => {
                tm = IDENTITY;
                tlm = IDENTITY;
                known = true;
            }
            b"Tm" if n.len() == 6 => {
                tm = [n[0], n[1], n[2], n[3], n[4], n[5]];
                tlm = tm;
                known = true;
            }
            b"Td" if n.len() == 2 => {
                next_line(&mut tm, &mut tlm, n[0], n[1]);
                known = true;
            }
            b"TD" if n.len() == 2 => {
                leading = -n[1];
                next_line(&mut tm, &mut tlm, n[0], n[1]);
                known = true;
            }
            b"T*" => {
                next_line(&mut tm, &mut tlm, 0.0, -leading);
                known = true;
            }
            b"TL" if n.len() == 1 => leading = n[0],
            b"Tr" if n.len() == 1 => render_mode = n[0] as i32,
            b"Tj" | b"TJ" | b"'" | b"\"" => {
                if op.name != b"Tj" && op.name != b"TJ" {
                    next_line(&mut tm, &mut tlm, 0.0, -leading);
                    known = true;
                }
                if shows_text(op) {
                    let origin = known.then(|| {
                        let m = mul(&tm, &ctm);
                        (m[4], m[5])
                    });
                    events.push(Event { kind: EventKind::Text, op: k, origin, render_mode });
                }
                // The glyph advance is unknown here, so later runs on this line are too.
                known = false;
            }
            b"m" | b"l" | b"c" | b"v" | b"y" | b"h" | b"re" => path_open = true,
            b"S" | b"s" | b"f" | b"F" | b"f*" | b"B" | b"B*" | b"b" | b"b*" => {
                if path_open {
                    events.push(Event { kind: EventKind::Path, op: k, origin: None, render_mode });
                }
                path_open = false;
            }
            b"n" => path_open = false,
            b"Do" => events.push(Event { kind: EventKind::XObject, op: k, origin: None, render_mode }),
            b"BI" => events.push(Event { kind: EventKind::InlineImage, op: k, origin: None, render_mode }),
            b"sh" => events.push(Event { kind: EventKind::Shading, op: k, origin: None, render_mode }),
            _ => {}
        }
    }
    events
}

fn compatible(d: &ObjDesc, e: &Event) -> bool {
    let kind_ok = match d.kind {
        ObjKind::Text => e.kind == EventKind::Text,
        ObjKind::Path => e.kind == EventKind::Path,
        ObjKind::Image => matches!(e.kind, EventKind::XObject | EventKind::InlineImage),
        ObjKind::Form => e.kind == EventKind::XObject,
        ObjKind::Shading => e.kind == EventKind::Shading,
    };
    if !kind_ok {
        return false;
    }
    match (d.origin, e.origin) {
        (Some((dx, dy)), Some((ex, ey))) => {
            let tol = 0.6 + 0.001 * dx.abs().max(dy.abs());
            (dx - ex).abs() <= tol && (dy - ey).abs() <= tol
        }
        _ => true,
    }
}

/// Removes the objects with the given indices (into `objects`, PDFium's top-level
/// object list for this page) from the decoded page content.
pub fn remove_objects(content: &[u8], objects: &[ObjDesc], remove: &[u32]) -> Result<Vec<u8>, String> {
    if remove.is_empty() {
        return Ok(content.to_vec());
    }
    let ops = tokenize(content)?;
    let events = interpret(&ops);

    // Pair PDFium's objects with operators, in order.
    let mut map: Vec<usize> = Vec::with_capacity(objects.len());
    let mut ev = 0;
    for d in objects {
        loop {
            let Some(e) = events.get(ev) else {
                return Err("The page content could not be matched to its objects.".into());
            };
            ev += 1;
            if compatible(d, e) {
                map.push(ev - 1);
                break;
            }
        }
    }

    // Edits as (start, end, replacement), applied back to front.
    let mut edits: Vec<(usize, usize, Vec<u8>)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for &r in remove {
        let Some(&e) = map.get(r as usize) else { continue };
        if !seen.insert(e) {
            continue;
        }
        let event = &events[e];
        let op = &ops[event.op];
        match event.kind {
            EventKind::Text => edits.push(text_removal(&ops, event, content)),
            EventKind::Path => edits.push((op.op_start, op.end, b"n".to_vec())),
            EventKind::XObject | EventKind::InlineImage | EventKind::Shading => {
                edits.push((op.start, op.end, Vec::new()))
            }
        }
    }
    edits.sort_by_key(|e| std::cmp::Reverse(e.0));
    let mut out = content.to_vec();
    for (start, end, with) in edits {
        out.splice(start..end, with);
    }
    Ok(out)
}

/// How to remove one text-showing operator without moving any other text.
fn text_removal(ops: &[Op], event: &Event, content: &[u8]) -> (usize, usize, Vec<u8>) {
    let op = &ops[event.op];
    // A later run on the same line that does not reposition itself starts where this
    // run's glyphs end. We cannot compute that advance without font metrics, so in
    // that case the run is kept but made invisible (render mode 3), which keeps the
    // advance exactly.
    let mut dependent = false;
    for next in &ops[event.op + 1..] {
        match next.name.as_slice() {
            b"ET" | b"Tm" | b"Td" | b"TD" | b"T*" | b"'" | b"\"" => break,
            b"Tj" | b"TJ" if shows_text(next) => {
                dependent = true;
                break;
            }
            _ => {}
        }
    }
    let bytes = |a: usize, b: usize| content[a..b].to_vec();
    match op.name.as_slice() {
        _ if dependent => {
            let mut v = b"3 Tr ".to_vec();
            v.extend(bytes(op.start, op.end));
            v.extend(format!(" {} Tr", event.render_mode).into_bytes());
            (op.start, op.end, v)
        }
        // ' = T* then show; keep the line move.
        b"'" => (op.start, op.end, b"T*".to_vec()),
        // aw ac string " = aw Tw, ac Tc, then '; keep the spacing and the line move.
        b"\"" if op.operand_spans.len() == 3 => {
            let mut v = bytes(op.operand_spans[0].0, op.operand_spans[0].1);
            v.extend(b" Tw ");
            v.extend(bytes(op.operand_spans[1].0, op.operand_spans[1].1));
            v.extend(b" Tc T*");
            (op.start, op.end, v)
        }
        _ => (op.start, op.end, Vec::new()),
    }
}


/// PDFium's description of a page's top-level objects, for `remove_objects`.
pub fn describe_objects(page: &super::pdf::Page) -> Vec<ObjDesc> {
    let b = page.b();
    (0..page.object_count().max(0))
        .map(|i| {
            let obj = page.object(i);
            let kind = match unsafe { b.FPDFPageObj_GetType(obj) } {
                1 => ObjKind::Text,
                2 => ObjKind::Path,
                3 => ObjKind::Image,
                4 => ObjKind::Shading,
                _ => ObjKind::Form,
            };
            let origin = (kind == ObjKind::Text)
                .then(|| super::pdf::obj_matrix(b, obj).map(|m| (m.e, m.f)))
                .flatten();
            ObjDesc { kind, origin }
        })
        .collect()
}

// ---------- applying removals to a saved document ----------

/// Objects to remove from one page of a saved document.
pub struct PageRemoval {
    /// Zero-based page index in the saved document.
    pub page: usize,
    /// PDFium's top-level objects of the original page, in order.
    pub objects: Vec<ObjDesc>,
    pub remove: Vec<u32>,
}

#[derive(Debug)]
pub enum RemovalError {
    /// These pages could not be matched; nothing was changed.
    Pages(Vec<usize>),
    /// The document itself could not be processed.
    Document(String),
}

/// Most decoded content we read for one page.
const MAX_PAGE_CONTENT: usize = 256 * 1024 * 1024;

/// Replaces the content of each listed page with its content minus the removed
/// objects. Old content streams are dropped from the file, so removed text is gone
/// from the saved PDF, not just hidden.
pub fn apply_removals(pdf: &[u8], removals: &[PageRemoval]) -> Result<Vec<u8>, RemovalError> {
    use lopdf::{Dictionary, Document, LoadOptions, Object, Stream};
    let doc_err = |e: lopdf::Error| RemovalError::Document(e.to_string());

    let options = LoadOptions { max_decompressed_size: Some(MAX_PAGE_CONTENT), strict: false, ..Default::default() };
    let mut doc = Document::load_mem_with_options(pdf, options).map_err(doc_err)?;
    let page_ids = doc.get_pages();

    let mut failed = Vec::new();
    let mut replacements = Vec::new();
    for r in removals {
        let Some(&page_id) = page_ids.get(&(r.page as u32 + 1)) else {
            failed.push(r.page);
            continue;
        };
        // Concatenate the page's streams (a newline keeps tokens apart).
        let mut content = Vec::new();
        let mut ok = true;
        for id in doc.get_page_contents(page_id) {
            let remaining = MAX_PAGE_CONTENT.saturating_sub(content.len());
            match doc.get_object(id).and_then(Object::as_stream).and_then(|s| s.decompressed_content_with_limit(remaining)) {
                Ok(data) => {
                    content.extend_from_slice(&data);
                    content.push(b'\n');
                }
                Err(_) => {
                    ok = false;
                    break;
                }
            }
        }
        match remove_objects(&content, &r.objects, &r.remove) {
            Ok(new) if ok && !content.is_empty() => replacements.push((page_id, new)),
            _ => failed.push(r.page),
        }
    }
    if !failed.is_empty() {
        return Err(RemovalError::Pages(failed));
    }

    for (page_id, new) in replacements {
        let mut stream = Stream::new(Dictionary::new(), new);
        let _ = stream.compress();
        let id = doc.add_object(stream);
        doc.get_dictionary_mut(page_id).map_err(doc_err)?.set("Contents", Object::Reference(id));
    }
    // Drop the old content streams (and anything else no longer referenced).
    doc.prune_objects();
    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(|e| RemovalError::Document(e.to_string()))?;
    Ok(out)
}

#[cfg(test)]
mod tests;
