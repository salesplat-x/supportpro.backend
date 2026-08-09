import PDFDocument from "pdfkit";

export interface CvPdfInput {
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  location?: string | null;
  fileName?: string | null;
  cvText: string;
}

const PAGE_MARGIN = 54;
const ACCENT = "#1f4b7a";
const MUTED = "#5c6b7a";
const BODY = "#1a1f24";

function buildLocation(location?: string | null): string {
  return location?.trim() || "";
}

/**
 * Regenerates a clean, branded PDF from stored CV text.
 * Layout is intentional Salesplat styling — not a pixel copy of the upload.
 */
export async function generateCvPdf(input: CvPdfInput): Promise<Buffer> {
  const fullName = `${input.firstName} ${input.lastName}`.trim() || "Candidate";
  const contactBits = [input.email, input.phone, buildLocation(input.location)].filter(
    Boolean
  ) as string[];

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: PAGE_MARGIN,
      bufferPages: true,
      info: {
        Title: `${fullName} — CV`,
        Author: fullName,
        Subject: input.fileName ?? "CV",
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const contentWidth = doc.page.width - PAGE_MARGIN * 2;

    doc
      .fillColor(ACCENT)
      .font("Helvetica-Bold")
      .fontSize(22)
      .text(fullName, { width: contentWidth });

    if (contactBits.length > 0) {
      doc.moveDown(0.35);
      doc
        .fillColor(MUTED)
        .font("Helvetica")
        .fontSize(10)
        .text(contactBits.join("  ·  "), { width: contentWidth });
    }

    doc.moveDown(0.7);
    doc
      .strokeColor(ACCENT)
      .lineWidth(1.5)
      .moveTo(PAGE_MARGIN, doc.y)
      .lineTo(PAGE_MARGIN + contentWidth, doc.y)
      .stroke();

    doc.moveDown(1);
    doc.fillColor(BODY).font("Helvetica").fontSize(11);

    const body = input.cvText.replace(/\r\n/g, "\n").trim();
    const paragraphs = body
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);

    if (paragraphs.length === 0) {
      doc.fillColor(MUTED).text("No CV content available.");
    } else {
      for (const paragraph of paragraphs) {
        // Preserve single newlines within a block as soft breaks.
        const lines = paragraph
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        doc.text(lines.join("\n"), {
          width: contentWidth,
          align: "left",
          lineGap: 2,
        });
        doc.moveDown(0.75);
      }
    }

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc
        .fontSize(8)
        .fillColor(MUTED)
        .text(
          `Generated from ${input.fileName ?? "uploaded CV"}`,
          PAGE_MARGIN,
          doc.page.height - 36,
          { width: contentWidth, align: "left", lineBreak: false }
        );
    }

    doc.end();
  });
}
