---
name: Prism Precision
colors:
  surface: '#faf8ff'
  surface-dim: '#d2d9f4'
  surface-bright: '#faf8ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f2f3ff'
  surface-container: '#eaedff'
  surface-container-high: '#e2e7ff'
  surface-container-highest: '#dae2fd'
  on-surface: '#131b2e'
  on-surface-variant: '#464555'
  inverse-surface: '#283044'
  inverse-on-surface: '#eef0ff'
  outline: '#777587'
  outline-variant: '#c7c4d8'
  surface-tint: '#4d44e3'
  primary: '#3525cd'
  on-primary: '#ffffff'
  primary-container: '#4f46e5'
  on-primary-container: '#dad7ff'
  inverse-primary: '#c3c0ff'
  secondary: '#0051d5'
  on-secondary: '#ffffff'
  secondary-container: '#316bf3'
  on-secondary-container: '#fefcff'
  tertiary: '#005338'
  on-tertiary: '#ffffff'
  tertiary-container: '#006e4c'
  on-tertiary-container: '#7df1bd'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#e2dfff'
  primary-fixed-dim: '#c3c0ff'
  on-primary-fixed: '#0f0069'
  on-primary-fixed-variant: '#3323cc'
  secondary-fixed: '#dbe1ff'
  secondary-fixed-dim: '#b4c5ff'
  on-secondary-fixed: '#00174b'
  on-secondary-fixed-variant: '#003ea8'
  tertiary-fixed: '#85f8c4'
  tertiary-fixed-dim: '#68dba9'
  on-tertiary-fixed: '#002114'
  on-tertiary-fixed-variant: '#005137'
  background: '#faf8ff'
  on-background: '#131b2e'
  surface-variant: '#dae2fd'
typography:
  display-lg:
    fontFamily: Hanken Grotesk
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
    letterSpacing: -0.02em
  display-md:
    fontFamily: Hanken Grotesk
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.015em
  headline-sm:
    fontFamily: Hanken Grotesk
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 24px
    letterSpacing: -0.01em
  title-md:
    fontFamily: Inter
    fontSize: 15px
    fontWeight: '600'
    lineHeight: 20px
    letterSpacing: -0.005em
  title-sm:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '600'
    lineHeight: 18px
    letterSpacing: 0em
  body-md:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
    letterSpacing: 0em
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
    letterSpacing: 0.005em
  label-md:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.02em
  label-sm:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 14px
    letterSpacing: 0.03em
  label-xs:
    fontFamily: JetBrains Mono
    fontSize: 10px
    fontWeight: '500'
    lineHeight: 12px
    letterSpacing: 0.04em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 0.75rem
  gutter-sm: 0.5rem
  gutter-lg: 1rem
  margin: 0.75rem
  margin-sm: 0.5rem
  margin-lg: 1.25rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 0.75rem
  space-lg: 1rem
  space-xl: 1.5rem
---

## Brand & Style

This design system is engineered for a high-performance desktop PDF reader and document manipulation suite. The interface establishes absolute document clarity, spatial rigor, and rapid cognitive scanning for knowledge workers, legal professionals, researchers, and technical editors.

The design movement combines **Precision Modernism** with **Engineered Minimalism**:
- **Canvas Primacy:** Toolbars, panes, and floating inspectors recede into structural slate-tinted chrome, ensuring the user's active document surface remains the chromatic focal point.
- **Micro-tactile Precision:** Interactive triggers, segmented modes, annotation markers, and page thumbnail grids feature surgical border definitions, sharp optical boundaries, and zero extraneous ornament.
- **Architectural Rhythm:** High typographic contrast paired with dense, deliberate information hierarchies empowers complex multi-window workflows, structural navigation, and fine vector markup without interface fatigue.

## Colors

The palette balances cool structural tones with electric precision highlights:

- **App Background & Canvases:** Surface canvas renders at `#F8FAFC` (Slate-50) with inner document viewport borders framing `#FFFFFF` document pages against a muted backdrop.
- **Chrome & Surface Panes:** Sidebars, navigation drawers, and ribbon toolbars sit at `#FFFFFF` with structural divider lines rendered at `#E2E8F0` (Slate-200). Subtle nested wells and thumbnail tracks use `#F1F5F9` (Slate-100).
- **Primary & Action Accent:** Electric Indigo (`#4F46E5`) anchors focal interactions, primary actions, selected document tabs, and active tool switches. High-visibility Cobalt Blue (`#2563EB`) governs selection bounding boxes, text carets, and active multi-page selections.
- **Utility & Annotation Hierarchy:**
  - **Emerald (`#059669`):** Verification stamps, signature validation, completed optical character recognition (OCR) states.
  - **Amber (`#D97706`):** Document sticky notes, contextual warning states, pending redline revisions.
  - **Rose (`#E11D48`):** Strike-throughs, redaction marks, structural deletion alerts.
- **Text & Foreground:** Primary headings, data values, and active document copy sit at `#0F172A` (Slate-900). Secondary metadata and inactive icon states rest at `#475569` (Slate-600) and `#94A3B8` (Slate-400).

## Typography

The typographic hierarchy prioritizes dense scannability and structural alignment:

- **Structural Headers (Hanken Grotesk):** Provides sharp, modern geometric clarity for app window headers, document meta titles, modal overlays, and workspace view toggles.
- **System & Interface Copy (Inter):** Delivers neutral legibility at compact sizes (`12px` - `15px`). Used across sidebar tree views, comment logs, context menus, and inline input states.
- **Technical Metrics & Annotation Telemetry (JetBrains Mono):** Governs zoom levels (e.g., `125%`), page indices (`04 / 88`), coordinate pointers, bounding box metrics, and cryptographic signature timestamps.
- **Spatial Tightness:** Line heights are kept compact (`1.2` to `1.35x`) to preserve vertical screen density for reading document panels.

## Layout & Spacing

The layout is built upon a **Docked Pane Multi-Grid System** optimized for high-density desktop displays:

- **App Shell Structure:**
  - **Global Header / Tab Strip:** Height fixed at `40px`. Accommodates document tabs with horizontal overflow scrolling and drag-to-split functionality.
  - **Primary Action Toolbar:** Height fixed at `44px`. Bordered at the bottom by a `1px` `#E2E8F0` divider. Houses tool groupings (Annotate, Edit, Form, Protect, Organize).
  - **Left Rail (Thumbnails, Bookmarks, Annotations):** Collapsible panel ranging between `240px` and `320px` width.
  - **Central Document Viewport:** Dynamic canvas space centering single-page, continuous, or side-by-side spread layouts with a consistent `24px` gutter around paper surfaces.
  - **Right Inspector (Properties & Metadata):** Context-aware panel (`260px` fixed width) displaying stroke, fill, opacity, text styles, or digital cert chains.
- **Desktop Breakpoints & Reflow:**
  - **Large Desktop (≥ 1440px):** Simultaneous open left navigator, dual-page document spread, and right property inspector.
  - **Compact Desktop / Laptop (1024px – 1439px):** Inspector collapses to an anchored floating popover on tool selection; left navigator drops to thumbnail icon rail.
  - **Sub-1024px Windows:** Secondary toolbars switch into scrolling carousels; sidebars become overlay drawers with backdrop scrim.

## Elevation & Depth

This system avoids heavy drop shadows, relying on **Low-Contrast Outlines & Surgical Tonal Layering**:

- **Level 0 (Workspace Base):** `#F8FAFC` viewport canvas framing document sheets.
- **Level 1 (Docked Shell Panes):** `#FFFFFF` ribbon toolbars, sidebars, and tab containers defined strictly by `1px solid #E2E8F0` hairline strokes. Zero blur shadow.
- **Level 2 (Active Document Page):** `#FFFFFF` document canvas elevated against `#F8FAFC` using a crisp dual-layer ambient shadow: `0 1px 3px 0 rgba(15, 23, 42, 0.04), 0 4px 12px 0 rgba(15, 23, 42, 0.06)`, bounded by a `1px solid #CBD5E1` boundary.
- **Level 3 (Context Menus & Floating Tool Palettes):** `#FFFFFF` surfaces with `1px solid #E2E8F0` and focused ambient shadow: `0 10px 15px -3px rgba(15, 23, 42, 0.08), 0 4px 6px -4px rgba(15, 23, 42, 0.04)`.
- **Level 4 (Modal Dialogs & Security Warnings):** Elevated modal cards using high-diffusion drop shadows (`0 20px 25px -5px rgba(15, 23, 42, 0.12)`) centered over a `rgba(15, 23, 42, 0.3)` dimmed backdrop.

## Shapes

The geometry uses a **Precision Soft** profile (`roundedness: 1`):

- **Interactive Controls & Input Wells:** Base radius of `4px` (`0.25rem`). This provides crisp, near-square desktop tool buttons, segmented toggle switches, and page-jump text inputs.
- **Cards, Floating Palettes, and Modals:** Scaled to `8px` (`0.5rem`) for cards, comment cards, and floating zoom/page pills.
- **Indicator Tags & Pill Controls:** Page-number indicator chips, annotation counter badges, and color-swatch circles retain rounded pill profiles (`9999px`) to create clear semantic contrast with structural tool containers.
- **Document Selection Rings:** Rectilinear selection boxes around vector paths, text blocks, and form fields use sharp `0px` inner corners with `2px` external sizing anchors.

## Components

### Toolbars & Segmented Controls
- **Primary Toolbar:** Contains flat icon-and-label tool triggers. Default state: transparent background, `#475569` icon. Hover: `#F1F5F9` surface with `#0F172A` icon. Active / Selected: `#EEF2FF` (Indigo-50) fill, `#4F46E5` icon and typography, with a bottom `2px` Indigo indicator line.
- **Segmented Control (Pan, Select, Annotate):** Enclosed inside a `#F1F5F9` track with `2px` inner padding. Active option sits on a `#FFFFFF` elevated pill with `0 1px 2px rgba(15, 23, 42, 0.08)` and `#0F172A` text.

### Buttons & Quick Actions
- **Primary Button:** `#4F46E5` fill, `#FFFFFF` text, `4px` border radius, `0 1px 2px rgba(79, 70, 229, 0.2)` shadow. Hover: `#4338CA`. Active: `#3730A3`.
- **Secondary Button:** `#FFFFFF` fill, `#E2E8F0` border, `#334155` text. Hover: `#F8FAFC` background with `#0F172A` text.
- **Subtle Tool Button:** `28px x 28px` square target, borderless, displaying SVG icons at `16px x 16px`. Active state triggers an Indigo border highlight.

### Document Input Fields & Spinners
- **Page Jump Input:** Monospace center-aligned text (`JetBrains Mono`), `28px` height, `#FFFFFF` surface with `1px solid #CBD5E1`. Focus ring: `2px solid #4F46E5` with zero offset.
- **Zoom Dropdown:** Segmented text input displaying current percentage with paired `+` / `-` increment buttons flanking the input container.

### Annotation Chips & Highlight Palette
- **Highlighter Picker:** Circular swatches (`18px`) featuring subtle inner borders to separate light tints (Yellow, Emerald, Cyan, Magenta) against white toolbar surfaces.
- **Comment Chips:** Threaded cards in the right sidebar featuring an indicator chip colored according to author identity, a relative timestamp in `label-xs`, and an action menu visible on hover.

### Checkboxes & Radios
- **Checkbox:** `14px x 14px` square, `3px` corner radius, `#FFFFFF` surface with `1px solid #CBD5E1`. Checked: `#4F46E5` fill with a white checkmark icon. Focus indicator: `2px` focus halo with `#EEF2FF`.
- **Radio:** `14px x 14px` round, matching the checkbox colorway with a centered `#FFFFFF` dot.

### Specialized Productivity Components
- **Floating Heads-Up Reading Pill:** Centered at the bottom of the viewport; translucent frosted glass (`rgba(255, 255, 255, 0.88)` with `backdrop-filter: blur(8px)`), housing fast page scrolling, fit-to-width, and presentation mode controls.
- **Page Thumbnail Card:** Miniature document preview surrounded by a `1px solid #E2E8F0` edge. Active page has an outline of `2px solid #4F46E5` and an indigo index tag.