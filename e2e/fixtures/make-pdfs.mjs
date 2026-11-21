// Writes the PDFs the E2E tests open. No dependencies: the files are written by hand
// so every byte the app sees is known.
//
//   node e2e/fixtures/make-pdfs.mjs <outDir>
//
// sample.pdf  3 Letter pages. Page 1: a heading and two wrapped paragraphs. Every page
//             carries a watermark tagged as NovaPDF writes it (/Artifact /Subtype (Watermark)).
// second.pdf  2 A4 pages with one line each (for merging).
// spec-watermark.pdf  1 page, watermark tagged with a name /Subtype /Watermark.
// not-a.pdf   Text with a .pdf name (must be rejected).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);

/** Builds a PDF from page content streams. Fonts: F1 Helvetica, F2 Helvetica-Bold. */
export function buildPdf(pages, { width = 612, height = 792 } = {}) {
  const objs = []; // index i → object number i + 1
  const add = (body) => objs.push(body) && objs.length;

  const catalog = add(null); // filled in below
  const pagesObj = add(null);
  const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const gs = add("<< /Type /ExtGState /ca 0.3 /CA 0.3 >>");
  const kids = pages.map((content) => {
    const stream = add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
    return add(
      `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${width} ${height}] ` +
        `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> /ExtGState << /GS1 ${gs} 0 R >> >> ` +
        `/Contents ${stream} 0 R >>`,
    );
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

  let out = "%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** Left-aligned lines of 12 pt Helvetica, 15 pt apart, starting at (x, y) in PDF space. */
const paragraph = (x, y, lines, font = "F1", size = 12, leading = 15) =>
  `BT /${font} ${size} Tf ${leading} TL ${x} ${y} Td ${lines.map((l, i) => `${i ? "T* " : ""}(${esc(l)}) Tj`).join(" ")} ET`;

/** A rotated, 30% watermark in an /Artifact marked-content section. `subtype` is the
 *  raw PDF value: "(Watermark)" (a string, as NovaPDF writes it) or "/Watermark" (a
 *  name, as the PDF spec and Acrobat write it). */
const watermark = (text, subtype = "(Watermark)") =>
  `/Artifact << /Type /Pagination /Subtype ${subtype} >> BDC q /GS1 gs 0.75 0.1 0.1 rg ` +
  `BT /F2 72 Tf 0.7071 0.7071 -0.7071 0.7071 170 250 Tm (${esc(text)}) Tj ET Q EMC`;

export const SAMPLE = {
  heading: "Quarterly Field Report",
  para1: [
    "The survey team visited eleven sites along the northern",
    "ridge during the spring season and recorded soil samples",
    "at each location for later laboratory analysis.",
  ],
  para2: ["Results will be shared with the regional office", "before the end of the next quarter."],
  watermark: "SAMPLE",
};

export function writeFixtures(dir) {
  mkdirSync(dir, { recursive: true });
  const page1 = [
    paragraph(72, 720, [SAMPLE.heading], "F2", 20, 24),
    paragraph(72, 680, SAMPLE.para1),
    paragraph(72, 600, SAMPLE.para2),
    watermark(SAMPLE.watermark),
  ].join("\n");
  const page = (n) => [paragraph(72, 720, [`This is page ${n} of the sample.`]), watermark(SAMPLE.watermark)].join("\n");
  writeFileSync(join(dir, "sample.pdf"), buildPdf([page1, page(2), page(3)]));
  writeFileSync(
    join(dir, "second.pdf"),
    buildPdf([1, 2].map((n) => paragraph(72, 760, [`Second document, page ${n}.`])), { width: 595, height: 842 }),
  );
  writeFileSync(
    join(dir, "spec-watermark.pdf"),
    buildPdf([[paragraph(72, 720, ["Watermark tagged the way the PDF spec does."]), watermark("SPEC", "/Watermark")].join("\n")]),
  );
  writeFileSync(join(dir, "not-a.pdf"), "This is plain text pretending to be a PDF.\n");
  return {
    sample: join(dir, "sample.pdf"),
    second: join(dir, "second.pdf"),
    notPdf: join(dir, "not-a.pdf"),
    specWatermark: join(dir, "spec-watermark.pdf"),
  };
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  console.log(writeFixtures(process.argv[2] ?? "e2e/.out/fixtures"));
}
