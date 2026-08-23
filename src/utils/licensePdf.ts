import { jsPDF } from "jspdf";

// --- License Summary PDF ---------------------------------------------------
// Purely additive companion to License.txt inside the export ZIP. Produces a
// short, readable, professionally laid-out PDF that explains — in plain
// English — who made the font and what the chosen license does and doesn't
// allow. It is a human-readable summary, not a substitute for a full legal
// license text.

export interface LicensePdfInfo {
  fontName: string;
  familyName: string;
  designerName: string;
  foundry: string;
  website: string;
  copyright: string;
  version: string;
  licenseType: string;
  licenseOwner: string;
  permission: string;
  restriction: string;
  note: string;
}

const PAGE_WIDTH = 210; // A4, mm
const PAGE_HEIGHT = 297;
const MARGIN_X = 22;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;

// Brand accent used throughout the app UI (see --accent in app.css).
const ACCENT: [number, number, number] = [198, 242, 78];
const INK: [number, number, number] = [23, 26, 24];
const DIM: [number, number, number] = [110, 118, 112];
const LINE: [number, number, number] = [226, 230, 226];

function licenseParagraphs(info: LicensePdfInfo): string[] {
  const attribution = info.foundry
    ? `${info.fontName} is an original typeface designed by ${info.designerName}, released through ${info.foundry}.`
    : `${info.fontName} is an original typeface designed by ${info.designerName}.`;

  const intro = `${attribution} It was built with FontSeru, a browser-based type design studio, and is made available under a ${info.licenseType || "custom"} License as set out by the designer below. This document is a plain-language summary of that license; the terms here reflect what the designer has authorized for this font.`;

  const isCommercial = info.licenseType.toLowerCase() === "commercial";
  const scope = isCommercial
    ? `Under this Commercial License, ${info.fontName} may be used in revenue-generating and commercial work, including branding, packaging, advertising, publications, apps, and merchandise, subject to any additional terms noted below. The font may be embedded in finished documents and digital products for distribution to end users. Reselling, sublicensing, or redistributing the font files themselves — modified or unmodified — as a standalone product is not permitted without the designer's prior written consent.`
    : `Under this Personal License, ${info.fontName} may be used for non-commercial purposes such as personal projects, hobby work, and school assignments — that is, uses that do not generate revenue or serve a commercial or promotional purpose. For commercial use, please contact the designer to obtain a Commercial License. Reselling, sublicensing, or redistributing the font files themselves, modified or unmodified, is not permitted without the designer's prior written consent.`;

  const extraClauses = [info.permission.trim(), info.restriction.trim(), info.note.trim()]
    .filter(Boolean)
    .join(" ");
  const scopeFull = extraClauses ? `${scope} ${extraClauses}` : scope;

  const closing = `This summary does not constitute a complete legal agreement. For questions about licensing, extended usage rights, or commercial arrangements${info.website ? `, reach out to the designer at ${info.website}` : ", please contact the designer directly"}. ${info.copyright || `Copyright © ${new Date().getFullYear()} ${info.designerName}`}. All rights reserved unless otherwise granted under this license.`;

  return [intro, scopeFull, closing];
}

function drawFooter(doc: jsPDF, pageNum: number): void {
  const y = PAGE_HEIGHT - 14;
  doc.setDrawColor(...LINE);
  doc.setLineWidth(0.3);
  doc.line(MARGIN_X, y, PAGE_WIDTH - MARGIN_X, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(...DIM);
  doc.text("Generated with FontSeru \u2014 fontseru.app", MARGIN_X, y + 6);
  doc.text(String(pageNum), PAGE_WIDTH - MARGIN_X, y + 6, { align: "right" });
}

function labelValueRow(doc: jsPDF, x: number, y: number, label: string, value: string): void {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(...DIM);
  doc.text(label.toUpperCase(), x, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.setTextColor(...INK);
  doc.text(value || "\u2014", x, y + 6);
}

/**
 * Builds the "License Summary.pdf" bundled into the export ZIP alongside
 * License.txt. Returns a Blob ready to hand to the zip writer.
 */
export function generateLicensePdf(info: LicensePdfInfo): Blob {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  let page = 1;

  // --- Header band ---------------------------------------------------
  doc.setFillColor(...INK);
  doc.rect(0, 0, PAGE_WIDTH, 40, "F");
  doc.setFillColor(...ACCENT);
  doc.rect(0, 38, PAGE_WIDTH, 2, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...ACCENT);
  doc.text("FONTSERU", MARGIN_X, 15);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(235, 238, 235);
  doc.text("License Summary", PAGE_WIDTH - MARGIN_X, 15, { align: "right" });

  doc.setFont("helvetica", "bold");
  doc.setFontSize(22);
  doc.setTextColor(255, 255, 255);
  doc.text(info.fontName || "Untitled Font", MARGIN_X, 30);

  let y = 56;

  // --- Metadata block --------------------------------------------------
  const colGap = CONTENT_WIDTH / 2;
  labelValueRow(doc, MARGIN_X, y, "Designer", info.designerName);
  labelValueRow(doc, MARGIN_X + colGap, y, "License Type", info.licenseType || "\u2014");
  y += 16;
  labelValueRow(doc, MARGIN_X, y, "Foundry", info.foundry || "\u2014");
  labelValueRow(doc, MARGIN_X + colGap, y, "Version", info.version || "\u2014");
  y += 16;
  labelValueRow(doc, MARGIN_X, y, "Designer URL", info.website || "\u2014");
  labelValueRow(doc, MARGIN_X + colGap, y, "Date", new Date().toISOString().slice(0, 10));
  y += 14;

  doc.setDrawColor(...LINE);
  doc.setLineWidth(0.3);
  doc.line(MARGIN_X, y, PAGE_WIDTH - MARGIN_X, y);
  y += 12;

  // --- Body paragraphs ---------------------------------------------------
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(...INK);
  doc.text("About this license", MARGIN_X, y);
  y += 9;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10.5);
  doc.setTextColor(...INK);

  const paragraphs = licenseParagraphs(info);
  const lineHeight = 5.6;
  const paragraphGap = 5;

  for (const paragraph of paragraphs) {
    const lines = doc.splitTextToSize(paragraph, CONTENT_WIDTH) as string[];
    for (const line of lines) {
      if (y > PAGE_HEIGHT - 28) {
        drawFooter(doc, page);
        doc.addPage();
        page += 1;
        y = 24;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(10.5);
        doc.setTextColor(...INK);
      }
      doc.text(line, MARGIN_X, y);
      y += lineHeight;
    }
    y += paragraphGap;
  }

  drawFooter(doc, page);

  return doc.output("blob");
}
