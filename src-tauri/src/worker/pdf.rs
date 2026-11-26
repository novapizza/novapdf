//! Thin RAII layer over the raw PDFium C API.
//!
//! Every handle is closed in `Drop`, and handles borrow their parent (`Page` borrows
//! `Doc`, `Doc` borrows `Lib`) so a page can never outlive its document.

use std::ffi::{c_int, c_uint, c_ulong, c_void};
use std::marker::PhantomData;
use std::path::Path;
use std::ptr;

use pdfium_render::prelude::{
    FPDF_DOCUMENT, FPDF_DWORD, FPDF_FILEWRITE, FPDF_FONT, FPDF_PAGE, FPDF_PAGEOBJECT,
    FPDF_TEXTPAGE, FPDF_WCHAR, FS_MATRIX, FS_RECTF, FS_SIZEF, Pdfium, PdfiumLibraryBindings,
};

use crate::geometry::Matrix;
use crate::shared::Backing;

// Constants from the PDFium headers (not re-exported by pdfium-render).
pub const FPDF_ANNOT: c_int = 0x01;
pub const FPDF_REVERSE_BYTE_ORDER: c_int = 0x10;
pub const FPDF_BITMAP_BGRA: c_int = 4;
pub const FPDF_NO_INCREMENTAL: FPDF_DWORD = 2;
pub const FPDF_PAGEOBJ_TEXT: c_int = 1;
pub const FPDF_FONT_TRUETYPE: c_int = 2;
pub const FPDF_TEXTRENDERMODE_INVISIBLE: c_int = 3;
pub const FPDF_ANNOT_LINK: c_int = 2;
pub const FPDF_ANNOT_FILEATTACHMENT: c_int = 17;
pub const FPDF_ANNOT_SOUND: c_int = 18;
pub const FPDF_ANNOT_MOVIE: c_int = 19;
pub const FPDF_ANNOT_SCREEN: c_int = 21;
pub const FPDF_ANNOT_WATERMARK: c_int = 24;
pub const FPDF_ANNOT_THREED: c_int = 25;
pub const FPDF_ANNOT_RICHMEDIA: c_int = 26;
pub const PDFACTION_GOTO: c_ulong = 1;
pub const PDFACTION_URI: c_ulong = 3;

/// Largest string we will read back from PDFium, in bytes.
const MAX_STRING_BYTES: usize = 4 * 1024 * 1024;
/// Largest PDF we will serialise.
const MAX_OUTPUT_BYTES: usize = 1500 * 1024 * 1024;

pub struct Lib {
    b: Box<dyn PdfiumLibraryBindings>,
}

impl Lib {
    pub fn load(dir: Option<&Path>) -> Result<Self, String> {
        let bundled = dir
            .map(Pdfium::pdfium_platform_library_name_at_path)
            .filter(|p| p.exists());
        let b = match bundled {
            Some(path) => Pdfium::bind_to_library(&path)
                .map_err(|e| format!("Could not load PDFium from {}: {e:?}", path.display()))?,
            None => Pdfium::bind_to_system_library()
                .map_err(|e| format!("PDFium library not found: {e:?}"))?,
        };
        unsafe { b.FPDF_InitLibrary() };
        Ok(Self { b })
    }

    #[inline]
    pub fn b(&self) -> &dyn PdfiumLibraryBindings {
        self.b.as_ref()
    }

    fn last_error(&self) -> String {
        match unsafe { self.b.FPDF_GetLastError() } {
            2 => "The file could not be read.".into(),
            3 => "This file is not a valid PDF or is damaged.".into(),
            4 => "This PDF is password-protected. Password-protected files are not supported yet."
                .into(),
            5 => "This PDF uses an unsupported security handler.".into(),
            6 => "A page could not be loaded.".into(),
            _ => "PDFium could not process this document.".into(),
        }
    }
}

impl Drop for Lib {
    fn drop(&mut self) {
        unsafe { self.b.FPDF_DestroyLibrary() };
    }
}

pub struct Doc<'l> {
    pub lib: &'l Lib,
    pub h: FPDF_DOCUMENT,
    /// PDFium reads lazily from this buffer, so it must live as long as the document.
    /// Declared after `h` is irrelevant: `Drop::drop` closes the document first.
    _bytes: Option<Backing>,
}

impl<'l> Doc<'l> {
    pub fn load(lib: &'l Lib, bytes: Vec<u8>) -> Result<Self, String> {
        Self::load_from(lib, Backing::Owned(bytes))
    }

    /// Loads from owned bytes or a read-only shared-memory view. Moving the backing
    /// into `Self` does not move the bytes themselves, so PDFium's pointer stays valid.
    pub fn load_from(lib: &'l Lib, bytes: Backing) -> Result<Self, String> {
        let h = unsafe { lib.b().FPDF_LoadMemDocument64(bytes.bytes(), None) };
        if h.is_null() {
            return Err(lib.last_error());
        }
        Ok(Self { lib, h, _bytes: Some(bytes) })
    }

    pub fn new_empty(lib: &'l Lib) -> Result<Self, String> {
        let h = unsafe { lib.b().FPDF_CreateNewDocument() };
        if h.is_null() {
            return Err("Could not create a PDF document".into());
        }
        Ok(Self { lib, h, _bytes: None })
    }

    /// Appends a blank page (used by tests and future "insert page" support).
    pub fn new_page(&self, width: f32, height: f32) -> Result<Page<'_>, String> {
        let at = self.page_count();
        let h = unsafe { self.lib.b().FPDFPage_New(self.h, at, width as f64, height as f64) };
        if h.is_null() {
            return Err("Could not create a page".into());
        }
        Ok(Page { lib: self.lib, h, _doc: PhantomData })
    }

    pub fn page_count(&self) -> i32 {
        unsafe { self.lib.b().FPDF_GetPageCount(self.h) }
    }

    pub fn page_size(&self, index: i32) -> Option<(f32, f32)> {
        let mut s = FS_SIZEF { width: 0.0, height: 0.0 };
        let ok = unsafe { self.lib.b().FPDF_GetPageSizeByIndexF(self.h, index, &mut s) };
        (ok != 0).then_some((s.width, s.height))
    }

    pub fn page(&self, index: i32) -> Result<Page<'_>, String> {
        if index < 0 || index >= self.page_count() {
            return Err(format!("Page {} does not exist", index + 1));
        }
        let h = unsafe { self.lib.b().FPDF_LoadPage(self.h, index) };
        if h.is_null() {
            return Err(format!("Page {} could not be loaded", index + 1));
        }
        Ok(Page { lib: self.lib, h, _doc: PhantomData })
    }

    /// Appends pages from `src` (in the given order) to the end of this document.
    pub fn import_pages(&self, src: &Doc, indices: &[i32]) -> Result<(), String> {
        let count = src.page_count();
        if indices.iter().any(|&i| i < 0 || i >= count) {
            return Err("Page index out of range".into());
        }
        let at = self.page_count();
        let ok = unsafe {
            self.lib.b().FPDF_ImportPagesByIndex(
                self.h,
                src.h,
                indices.as_ptr(),
                indices.len() as c_ulong,
                at,
            )
        };
        if ok == 0 {
            return Err("Could not copy pages".into());
        }
        Ok(())
    }

    pub fn save(&self) -> Result<Vec<u8>, String> {
        #[repr(C)]
        struct Writer {
            base: FPDF_FILEWRITE,
            out: Vec<u8>,
            overflow: bool,
        }

        unsafe extern "C" fn write_block(
            this: *mut FPDF_FILEWRITE,
            data: *const c_void,
            size: c_ulong,
        ) -> c_int {
            // SAFETY: `this` points at `Writer::base`, the first field of a #[repr(C)] Writer.
            let w = unsafe { &mut *(this as *mut Writer) };
            let size = size as usize;
            if size == 0 {
                return 1;
            }
            if data.is_null() || w.out.len() + size > MAX_OUTPUT_BYTES {
                w.overflow = true;
                return 0;
            }
            let slice = unsafe { std::slice::from_raw_parts(data as *const u8, size) };
            w.out.extend_from_slice(slice);
            1
        }

        let mut writer = Writer {
            base: FPDF_FILEWRITE { version: 1, WriteBlock: Some(write_block) },
            out: Vec::new(),
            overflow: false,
        };
        let ok = unsafe {
            self.lib
                .b()
                .FPDF_SaveAsCopy(self.h, &mut writer.base, FPDF_NO_INCREMENTAL)
        };
        if writer.overflow {
            return Err("The output PDF is too large".into());
        }
        if ok == 0 {
            return Err("PDFium could not write the document".into());
        }
        Ok(writer.out)
    }
}

impl Drop for Doc<'_> {
    fn drop(&mut self) {
        unsafe { self.lib.b().FPDF_CloseDocument(self.h) };
    }
}

pub struct Page<'d> {
    pub lib: &'d Lib,
    pub h: FPDF_PAGE,
    _doc: PhantomData<&'d ()>,
}

impl<'d> Page<'d> {
    pub fn b(&self) -> &dyn PdfiumLibraryBindings {
        self.lib.b()
    }

    pub fn size(&self) -> (f32, f32) {
        unsafe {
            (
                self.b().FPDF_GetPageWidthF(self.h),
                self.b().FPDF_GetPageHeightF(self.h),
            )
        }
    }

    /// Page rotation in quarter turns (0–3).
    pub fn rotation(&self) -> i32 {
        unsafe { self.b().FPDFPage_GetRotation(self.h) }.rem_euclid(4)
    }

    pub fn set_rotation(&self, quarter_turns: i32) {
        unsafe { self.b().FPDFPage_SetRotation(self.h, quarter_turns.rem_euclid(4)) };
    }

    /// Matrix from page space (PDF points, y up) to display space (points, origin at
    /// the top-left of the page as shown, y down).
    pub fn display_matrix(&self) -> Matrix {
        let (l, b, rt, t) = self.visible_box();
        Matrix::page_to_display(l, b, rt, t, self.rotation())
    }

    /// Size of the page as shown, in display-space points (width, height).
    pub fn display_size(&self) -> (f32, f32) {
        let (l, b, rt, t) = self.visible_box();
        if self.rotation() % 2 == 1 { (t - b, rt - l) } else { (rt - l, t - b) }
    }

    /// The visible box (left, bottom, right, top) in page space.
    fn visible_box(&self) -> (f32, f32, f32, f32) {
        let mut r = FS_RECTF { left: 0.0, top: 0.0, right: 0.0, bottom: 0.0 };
        let ok = unsafe { self.b().FPDF_GetPageBoundingBox(self.h, &mut r) };
        if ok != 0 {
            (r.left.min(r.right), r.bottom.min(r.top), r.left.max(r.right), r.bottom.max(r.top))
        } else {
            let (w, h) = self.size();
            (0.0, 0.0, w, h)
        }
    }

    pub fn object_count(&self) -> i32 {
        unsafe { self.b().FPDFPage_CountObjects(self.h) }
    }

    pub fn object(&self, index: i32) -> FPDF_PAGEOBJECT {
        unsafe { self.b().FPDFPage_GetObject(self.h, index) }
    }

    pub fn text_page(&self) -> Result<TextPage<'_>, String> {
        let h = unsafe { self.b().FPDFText_LoadPage(self.h) };
        if h.is_null() {
            return Err("Could not read the page text".into());
        }
        Ok(TextPage { lib: self.lib, h, _page: PhantomData })
    }

    /// Renders to RGBA at the given pixel size. `rotate` is extra quarter turns.
    pub fn render_rgba(&self, width: i32, height: i32, rotate: i32) -> Result<Vec<u8>, String> {
        let stride = width.checked_mul(4).ok_or("Render size too large")?;
        let len = (stride as usize)
            .checked_mul(height as usize)
            .ok_or("Render size too large")?;
        let mut buf = vec![0u8; len];
        unsafe {
            let bmp = self.b().FPDFBitmap_CreateEx(
                width,
                height,
                FPDF_BITMAP_BGRA,
                buf.as_mut_ptr() as *mut c_void,
                stride,
            );
            if bmp.is_null() {
                return Err("Could not allocate a render bitmap".into());
            }
            self.b()
                .FPDFBitmap_FillRect(bmp, 0, 0, width, height, 0xFFFF_FFFFu32 as FPDF_DWORD);
            self.b().FPDF_RenderPageBitmap(
                bmp,
                self.h,
                0,
                0,
                width,
                height,
                rotate.rem_euclid(4),
                FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER,
            );
            self.b().FPDFBitmap_Destroy(bmp);
        }
        Ok(buf)
    }

    /// Makes PDFium write appearance streams (`/AP`) for annotations that have none,
    /// such as the ones the app creates. PDFium generates them while building the
    /// page's annotation list for rendering, so a 1×1 render is enough.
    pub fn generate_annot_appearances(&self) -> Result<(), String> {
        self.render_rgba(1, 1, 0).map(|_| ())
    }

    pub fn generate_content(&self) -> Result<(), String> {
        let ok = unsafe { self.b().FPDFPage_GenerateContent(self.h) };
        if ok == 0 {
            return Err("Could not write the page content".into());
        }
        Ok(())
    }
}

impl Drop for Page<'_> {
    fn drop(&mut self) {
        unsafe { self.lib.b().FPDF_ClosePage(self.h) };
    }
}

pub struct TextPage<'p> {
    lib: &'p Lib,
    pub h: FPDF_TEXTPAGE,
    _page: PhantomData<&'p ()>,
}

impl Drop for TextPage<'_> {
    fn drop(&mut self) {
        unsafe { self.lib.b().FPDFText_ClosePage(self.h) };
    }
}

/// Fonts loaded into one output document. PDFium keeps its own reference once a
/// text object uses the font, so the handles are released when this cache drops.
pub struct FontCache<'l> {
    lib: &'l Lib,
    fonts: Vec<(String, FPDF_FONT)>,
}

impl<'l> FontCache<'l> {
    pub fn new(lib: &'l Lib) -> Self {
        Self { lib, fonts: Vec::new() }
    }

    pub fn get_or_load(
        &mut self,
        key: &str,
        load: impl FnOnce() -> FPDF_FONT,
    ) -> Result<FPDF_FONT, String> {
        if let Some((_, f)) = self.fonts.iter().find(|(k, _)| k == key) {
            return Ok(*f);
        }
        let f = load();
        if f.is_null() {
            return Err(format!("Could not load font {key}"));
        }
        self.fonts.push((key.to_string(), f));
        Ok(f)
    }
}

impl Drop for FontCache<'_> {
    fn drop(&mut self) {
        for (_, f) in self.fonts.drain(..) {
            unsafe { self.lib.b().FPDFFont_Close(f) };
        }
    }
}

// ---------- small helpers ----------

/// Reads a UTF-16 string from a PDFium "call twice" API that reports its size in bytes.
pub fn read_utf16(mut call: impl FnMut(*mut FPDF_WCHAR, c_ulong) -> c_ulong) -> String {
    let needed = call(ptr::null_mut(), 0) as usize;
    if needed <= 2 || needed > MAX_STRING_BYTES {
        return String::new();
    }
    let mut buf = vec![0u16; needed.div_ceil(2)];
    let got = call(buf.as_mut_ptr(), (buf.len() * 2) as c_ulong) as usize;
    let n = (got.min(needed) / 2).min(buf.len());
    let mut s = &buf[..n];
    while let [rest @ .., 0] = s {
        s = rest;
    }
    String::from_utf16_lossy(s)
}

/// Same as [`read_utf16`] for APIs with a separate out-length parameter.
pub fn read_utf16_out(
    mut call: impl FnMut(*mut FPDF_WCHAR, c_ulong, *mut c_ulong) -> bool,
) -> Option<String> {
    let mut needed: c_ulong = 0;
    if !call(ptr::null_mut(), 0, &mut needed) {
        return None;
    }
    let needed = needed as usize;
    if needed <= 2 || needed > MAX_STRING_BYTES {
        return Some(String::new());
    }
    let mut buf = vec![0u16; needed.div_ceil(2)];
    let mut out: c_ulong = 0;
    if !call(buf.as_mut_ptr(), (buf.len() * 2) as c_ulong, &mut out) {
        return None;
    }
    let n = ((out as usize).min(needed) / 2).min(buf.len());
    let mut s = &buf[..n];
    while let [rest @ .., 0] = s {
        s = rest;
    }
    Some(String::from_utf16_lossy(s))
}

/// Reads a UTF-8/Latin-1 C string from a PDFium "call twice" API.
pub fn read_cstr(mut call: impl FnMut(*mut std::ffi::c_char, usize) -> usize) -> String {
    let needed = call(ptr::null_mut(), 0);
    if needed <= 1 || needed > MAX_STRING_BYTES {
        return String::new();
    }
    let mut buf = vec![0u8; needed];
    call(buf.as_mut_ptr() as *mut std::ffi::c_char, needed);
    while buf.last() == Some(&0) {
        buf.pop();
    }
    String::from_utf8_lossy(&buf).into_owned()
}

pub fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub(crate) fn obj_matrix(b: &dyn PdfiumLibraryBindings, obj: FPDF_PAGEOBJECT) -> Option<Matrix> {
    let mut m = FS_MATRIX { a: 0.0, b: 0.0, c: 0.0, d: 0.0, e: 0.0, f: 0.0 };
    let ok = unsafe { b.FPDFPageObj_GetMatrix(obj, &mut m) };
    (ok != 0).then(|| Matrix::from(m))
}

/// Object bounds in page space: (left, bottom, right, top).
pub(crate) fn obj_bounds(b: &dyn PdfiumLibraryBindings, obj: FPDF_PAGEOBJECT) -> Option<[f32; 4]> {
    let (mut l, mut bt, mut r, mut t) = (0f32, 0f32, 0f32, 0f32);
    let ok = unsafe { b.FPDFPageObj_GetBounds(obj, &mut l, &mut bt, &mut r, &mut t) };
    (ok != 0).then_some([l, bt, r, t])
}

pub(crate) fn obj_fill(b: &dyn PdfiumLibraryBindings, obj: FPDF_PAGEOBJECT) -> [u8; 4] {
    let (mut r, mut g, mut bl, mut a): (c_uint, c_uint, c_uint, c_uint) = (0, 0, 0, 255);
    unsafe { b.FPDFPageObj_GetFillColor(obj, &mut r, &mut g, &mut bl, &mut a) };
    [r.min(255) as u8, g.min(255) as u8, bl.min(255) as u8, a.min(255) as u8]
}

#[cfg(test)]
mod tests;
