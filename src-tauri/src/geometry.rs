//! 2D affine matrices in PDF convention: [a b c d e f] maps (x, y) to
//! (a·x + c·y + e, b·x + d·y + f).

use pdfium_render::prelude::FS_MATRIX;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Matrix {
    pub a: f32,
    pub b: f32,
    pub c: f32,
    pub d: f32,
    pub e: f32,
    pub f: f32,
}

impl From<FS_MATRIX> for Matrix {
    fn from(m: FS_MATRIX) -> Self {
        Self { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f }
    }
}

impl From<Matrix> for FS_MATRIX {
    fn from(m: Matrix) -> Self {
        FS_MATRIX { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f }
    }
}

impl Matrix {
    pub const IDENTITY: Matrix = Matrix { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: 0.0, f: 0.0 };

    pub fn new(a: f32, b: f32, c: f32, d: f32, e: f32, f: f32) -> Self {
        Self { a, b, c, d, e, f }
    }

    /// `self` first, then `next`.
    pub fn then(&self, next: &Matrix) -> Matrix {
        Matrix {
            a: self.a * next.a + self.b * next.c,
            b: self.a * next.b + self.b * next.d,
            c: self.c * next.a + self.d * next.c,
            d: self.c * next.b + self.d * next.d,
            e: self.e * next.a + self.f * next.c + next.e,
            f: self.e * next.b + self.f * next.d + next.f,
        }
    }

    pub fn invert(&self) -> Option<Matrix> {
        let det = self.a * self.d - self.b * self.c;
        if det.abs() < 1e-9 || !det.is_finite() {
            return None;
        }
        Some(Matrix {
            a: self.d / det,
            b: -self.b / det,
            c: -self.c / det,
            d: self.a / det,
            e: (self.c * self.f - self.d * self.e) / det,
            f: (self.b * self.e - self.a * self.f) / det,
        })
    }

    pub fn apply(&self, x: f32, y: f32) -> (f32, f32) {
        (self.a * x + self.c * y + self.e, self.b * x + self.d * y + self.f)
    }

    /// Axis-aligned bounds of a page-space rectangle after transforming it.
    pub fn apply_rect(&self, l: f32, b: f32, r: f32, t: f32) -> (f32, f32, f32, f32) {
        let pts = [self.apply(l, b), self.apply(r, b), self.apply(l, t), self.apply(r, t)];
        let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for (x, y) in pts {
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        }
        (x0, y0, x1, y1)
    }

    /// Page space → display space for a page whose visible box is (l, b, r, t) and
    /// which is rotated clockwise by `quarter_turns` × 90°.
    pub fn page_to_display(l: f32, b: f32, r: f32, t: f32, quarter_turns: i32) -> Matrix {
        let w = r - l;
        let h = t - b;
        // Flip y and move the top-left corner to the origin.
        let unrotated = Matrix::new(1.0, 0.0, 0.0, -1.0, -l, t);
        let rot = match quarter_turns.rem_euclid(4) {
            1 => Matrix::new(0.0, 1.0, -1.0, 0.0, h, 0.0),
            2 => Matrix::new(-1.0, 0.0, 0.0, -1.0, w, h),
            3 => Matrix::new(0.0, -1.0, 1.0, 0.0, 0.0, w),
            _ => Matrix::IDENTITY,
        };
        unrotated.then(&rot)
    }

    /// Glyph space (y up) → display space (y down) for text whose baseline starts at
    /// (x, y) and runs at `angle_deg` counter-clockwise on screen.
    pub fn glyph_to_display(x: f32, y: f32, angle_deg: f32) -> Matrix {
        let (s, c) = angle_deg.to_radians().sin_cos();
        Matrix::new(c, -s, -s, -c, x, y)
    }
}

#[cfg(test)]
mod tests;
