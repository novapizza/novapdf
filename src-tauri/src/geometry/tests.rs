//! Unit tests for `geometry.rs`. Kept in their own file so coverage reports can exclude test code.

use super::*;

fn close(a: (f32, f32), b: (f32, f32)) -> bool {
    (a.0 - b.0).abs() < 1e-3 && (a.1 - b.1).abs() < 1e-3
}

#[test]
fn display_corners_follow_rotation() {
    // Letter page, origin offset to test crop boxes.
    let (l, b, r, t) = (10.0, 20.0, 622.0, 812.0);
    let top_left = (l, t);
    let m0 = Matrix::page_to_display(l, b, r, t, 0);
    assert!(close(m0.apply(top_left.0, top_left.1), (0.0, 0.0)));
    let m1 = Matrix::page_to_display(l, b, r, t, 1);
    // Rotated 90° clockwise: the old top-left lands at the top-right.
    assert!(close(m1.apply(top_left.0, top_left.1), (792.0, 0.0)));
    let m2 = Matrix::page_to_display(l, b, r, t, 2);
    assert!(close(m2.apply(top_left.0, top_left.1), (612.0, 792.0)));
    let m3 = Matrix::page_to_display(l, b, r, t, 3);
    assert!(close(m3.apply(top_left.0, top_left.1), (0.0, 612.0)));
}

#[test]
fn invert_round_trips() {
    let m = Matrix::page_to_display(0.0, 0.0, 612.0, 792.0, 1)
        .then(&Matrix::new(2.0, 0.5, -0.3, 1.5, 7.0, -3.0));
    let inv = m.invert().unwrap();
    let p = m.apply(123.0, 456.0);
    assert!(close(inv.apply(p.0, p.1), (123.0, 456.0)));
}

#[test]
fn upright_glyphs_have_y_down() {
    let g = Matrix::glyph_to_display(100.0, 200.0, 0.0);
    // A point one unit above the baseline in glyph space is one unit up on screen.
    assert!(close(g.apply(0.0, 1.0), (100.0, 199.0)));
    let g45 = Matrix::glyph_to_display(0.0, 0.0, 90.0);
    // Text rotated 90° CCW runs upward on screen.
    assert!(close(g45.apply(1.0, 0.0), (0.0, -1.0)));
}

mod more_tests {
    use super::super::*;

    fn approx(a: &Matrix, b: &Matrix) -> bool {
        [(a.a, b.a), (a.b, b.b), (a.c, b.c), (a.d, b.d), (a.e, b.e), (a.f, b.f)]
            .iter()
            .all(|(x, y)| (x - y).abs() < 1e-3)
    }

    #[test]
    fn identity_is_neutral() {
        let m = Matrix::new(2.0, 0.5, -0.3, 1.5, 7.0, -3.0);
        assert_eq!(m.then(&Matrix::IDENTITY), m);
        assert_eq!(Matrix::IDENTITY.then(&m), m);
        assert_eq!(Matrix::IDENTITY.apply(3.0, 4.0), (3.0, 4.0));
    }

    #[test]
    fn then_applies_self_first() {
        let scale = Matrix::new(2.0, 0.0, 0.0, 2.0, 0.0, 0.0);
        let shift = Matrix::new(1.0, 0.0, 0.0, 1.0, 10.0, 0.0);
        // Scale then shift: (1,1) -> (2,2) -> (12,2).
        assert_eq!(scale.then(&shift).apply(1.0, 1.0), (12.0, 2.0));
        // Shift then scale: (1,1) -> (11,1) -> (22,2).
        assert_eq!(shift.then(&scale).apply(1.0, 1.0), (22.0, 2.0));
    }

    #[test]
    fn then_is_associative() {
        let a = Matrix::new(2.0, 0.5, -0.3, 1.5, 7.0, -3.0);
        let b = Matrix::page_to_display(10.0, 20.0, 600.0, 800.0, 3);
        let c = Matrix::glyph_to_display(5.0, 6.0, 30.0);
        assert!(approx(&a.then(&b).then(&c), &a.then(&b.then(&c))));
        // Composition matches applying one after the other.
        let (x, y) = b.apply(a.apply(9.0, -4.0).0, a.apply(9.0, -4.0).1);
        let (cx, cy) = a.then(&b).apply(9.0, -4.0);
        assert!((x - cx).abs() < 1e-3 && (y - cy).abs() < 1e-3);
    }

    #[test]
    fn invert_rejects_singular_and_non_finite_matrices() {
        assert!(Matrix::new(0.0, 0.0, 0.0, 0.0, 1.0, 1.0).invert().is_none());
        // Rows are multiples of each other: determinant 0.
        assert!(Matrix::new(1.0, 2.0, 2.0, 4.0, 0.0, 0.0).invert().is_none());
        assert!(Matrix::new(1e-6, 0.0, 0.0, 1e-6, 0.0, 0.0).invert().is_none());
        assert!(Matrix::new(f32::NAN, 0.0, 0.0, 1.0, 0.0, 0.0).invert().is_none());
        assert!(Matrix::new(f32::INFINITY, 0.0, 0.0, 1.0, 0.0, 0.0).invert().is_none());
        // Small but invertible is fine.
        assert!(Matrix::new(1e-3, 0.0, 0.0, 1e-3, 0.0, 0.0).invert().is_some());
    }

    #[test]
    fn inverse_composes_to_identity() {
        let m = Matrix::new(0.0, 1.0, -1.0, 0.0, 100.0, 50.0);
        let inv = m.invert().unwrap();
        assert!(approx(&m.then(&inv), &Matrix::IDENTITY));
        assert!(approx(&inv.then(&m), &Matrix::IDENTITY));
    }

    #[test]
    fn apply_rect_returns_ordered_bounds() {
        assert_eq!(Matrix::IDENTITY.apply_rect(1.0, 2.0, 3.0, 4.0), (1.0, 2.0, 3.0, 4.0));
        // A y flip swaps top and bottom but bounds stay ordered.
        let flip = Matrix::page_to_display(0.0, 0.0, 612.0, 792.0, 0);
        assert_eq!(flip.apply_rect(72.0, 700.0, 172.0, 712.0), (72.0, 80.0, 172.0, 92.0));
        // 90° rotation turns a wide box into a tall one.
        let rot = Matrix::new(0.0, 1.0, -1.0, 0.0, 0.0, 0.0);
        let (x0, y0, x1, y1) = rot.apply_rect(0.0, 0.0, 10.0, 2.0);
        assert_eq!((x1 - x0, y1 - y0), (2.0, 10.0));
        // A 45° rotation of a unit square grows its bounds to the diagonal.
        let g = Matrix::glyph_to_display(0.0, 0.0, 45.0);
        let (x0, y0, x1, y1) = g.apply_rect(0.0, 0.0, 1.0, 1.0);
        assert!(((x1 - x0) - 2f32.sqrt()).abs() < 1e-4 && ((y1 - y0) - 2f32.sqrt()).abs() < 1e-4);
    }

    #[test]
    fn page_to_display_normalises_quarter_turns() {
        let (l, b, r, t) = (0.0, 0.0, 612.0, 792.0);
        assert_eq!(Matrix::page_to_display(l, b, r, t, 4), Matrix::page_to_display(l, b, r, t, 0));
        assert_eq!(Matrix::page_to_display(l, b, r, t, -1), Matrix::page_to_display(l, b, r, t, 3));
        assert_eq!(Matrix::page_to_display(l, b, r, t, 5), Matrix::page_to_display(l, b, r, t, 1));
        // The bottom-right page corner always lands on the far display corner.
        let m = Matrix::page_to_display(l, b, r, t, 1);
        let (x, y) = m.apply(r, b);
        assert!((x - 0.0).abs() < 1e-3 && (y - 612.0).abs() < 1e-3);
    }

    #[test]
    fn converts_to_and_from_fs_matrix() {
        let m = Matrix::new(1.0, 2.0, 3.0, 4.0, 5.0, 6.0);
        let fs: FS_MATRIX = m.into();
        assert_eq!((fs.a, fs.b, fs.c, fs.d, fs.e, fs.f), (1.0, 2.0, 3.0, 4.0, 5.0, 6.0));
        assert_eq!(Matrix::from(fs), m);
    }
}
