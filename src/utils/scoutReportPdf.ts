import PDFDocument from "pdfkit";

export interface ScoutReportCandidate {
  rank: number;
  name: string;
  email?: string | null;
  phone?: string | null;
  location?: string | null;
  headline?: string | null;
  score: number | null;
  /** The plain-English reason this candidate was shortlisted. */
  recommendation?: string | null;
  strengths: string[];
  concerns: string[];
  mustHavesMet: string[];
  mustHavesMissing: string[];
}

export interface ScoutReportInput {
  campaignName: string;
  roleName: string;
  experienceLevel?: string | null;
  jobBrief: string;
  recruiterGuide: string;
  runDate: Date;
  totalCvs: number;
  shortlistSummary?: string | null;
  candidates: ScoutReportCandidate[];
}

const PAGE_MARGIN = 54;
const INK = "#101828";
const BODY = "#344054";
const MUTED = "#667085";
const ACCENT = "#3c6fd4";
const SUCCESS = "#1b7b44";
const WARNING = "#b54708";

const scoreColor = (score: number | null): string => {
  if (score == null) return MUTED;
  if (score >= 75) return SUCCESS;
  if (score >= 50) return WARNING;
  return "#c4320a";
};

const formatDate = (date: Date): string =>
  date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

function drawList(
  doc: PDFKit.PDFDocument,
  title: string,
  items: string[],
  color: string,
  contentWidth: number
): void {
  if (items.length === 0) return;
  doc.moveDown(0.5);
  doc.fillColor(color).font("Helvetica-Bold").fontSize(10.5).text(title, { width: contentWidth });
  doc.moveDown(0.15);
  doc.fillColor(BODY).font("Helvetica").fontSize(10);
  for (const item of items) {
    doc.text(`•  ${item}`, { width: contentWidth, lineGap: 2 });
  }
}

/**
 * Cover page. The brief and the AI instructions are reproduced verbatim so the
 * report still explains itself months later, when nobody remembers what the
 * campaign asked for.
 */
function drawCover(doc: PDFKit.PDFDocument, input: ScoutReportInput, contentWidth: number): void {
  doc
    .fillColor(ACCENT)
    .font("Helvetica-Bold")
    .fontSize(11)
    .text("AI SCOUTING SHORTLIST", { width: contentWidth, characterSpacing: 1.2 });

  doc.moveDown(0.4);
  doc
    .fillColor(INK)
    .font("Helvetica-Bold")
    .fontSize(24)
    .text(input.campaignName, { width: contentWidth });

  doc.moveDown(0.3);
  const metaBits = [
    input.roleName,
    input.experienceLevel ?? undefined,
    formatDate(input.runDate),
  ].filter(Boolean);
  doc
    .fillColor(MUTED)
    .font("Helvetica")
    .fontSize(10.5)
    .text(metaBits.join("  ·  "), { width: contentWidth });

  doc.moveDown(0.9);
  const headline =
    input.candidates.length === 0
      ? `No candidates were shortlisted from ${input.totalCvs} CVs reviewed.`
      : `Top ${input.candidates.length} of ${input.totalCvs} CVs reviewed.`;
  doc.roundedRect(PAGE_MARGIN, doc.y, contentWidth, 44, 6).fill("#f7f8fb");
  const boxTop = doc.y - 44;
  doc
    .fillColor(INK)
    .font("Helvetica-Bold")
    .fontSize(13)
    .text(headline, PAGE_MARGIN + 16, boxTop + 15, { width: contentWidth - 32 });
  doc.y = boxTop + 44;

  if (input.shortlistSummary) {
    doc.moveDown(0.9);
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text("In summary");
    doc.moveDown(0.2);
    doc
      .fillColor(BODY)
      .font("Helvetica")
      .fontSize(10.5)
      .text(input.shortlistSummary, { width: contentWidth, lineGap: 2 });
  }

  doc.moveDown(0.9);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text("The role");
  doc.moveDown(0.2);
  doc
    .fillColor(BODY)
    .font("Helvetica")
    .fontSize(10)
    .text(input.jobBrief, { width: contentWidth, lineGap: 2 });

  doc.moveDown(0.8);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text("How the AI was told to choose");
  doc.moveDown(0.2);
  doc
    .fillColor(BODY)
    .font("Helvetica")
    .fontSize(10)
    .text(input.recruiterGuide, { width: contentWidth, lineGap: 2 });
}

function drawCandidate(
  doc: PDFKit.PDFDocument,
  candidate: ScoutReportCandidate,
  contentWidth: number
): void {
  const accent = scoreColor(candidate.score);

  doc
    .fillColor(MUTED)
    .font("Helvetica-Bold")
    .fontSize(11)
    .text(`RANK ${candidate.rank}`, { width: contentWidth, characterSpacing: 1 });

  doc.moveDown(0.2);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(19).text(candidate.name, {
    width: contentWidth,
  });

  const subtitle = [candidate.headline, candidate.location].filter(Boolean).join("  ·  ");
  if (subtitle) {
    doc.moveDown(0.15);
    doc.fillColor(MUTED).font("Helvetica").fontSize(10).text(subtitle, { width: contentWidth });
  }

  const contact = [candidate.email, candidate.phone].filter(Boolean).join("  ·  ");
  if (contact) {
    doc.moveDown(0.15);
    doc.fillColor(BODY).font("Helvetica").fontSize(10).text(contact, { width: contentWidth });
  }

  doc.moveDown(0.7);
  doc.roundedRect(PAGE_MARGIN, doc.y, contentWidth, 40, 6).fill("#f7f8fb");
  const boxTop = doc.y - 40;
  doc
    .fillColor(accent)
    .font("Helvetica-Bold")
    .fontSize(15)
    .text(
      candidate.score == null ? "Not scored" : `${candidate.score}% match`,
      PAGE_MARGIN + 16,
      boxTop + 12,
      { width: contentWidth - 32 }
    );
  doc.y = boxTop + 40;

  if (candidate.recommendation) {
    doc.moveDown(0.7);
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text("Why this candidate");
    doc.moveDown(0.2);
    doc
      .fillColor(BODY)
      .font("Helvetica")
      .fontSize(10.5)
      .text(candidate.recommendation, { width: contentWidth, lineGap: 2 });
  }

  drawList(doc, "Strengths", candidate.strengths, SUCCESS, contentWidth);
  drawList(doc, "Things to check", candidate.concerns, WARNING, contentWidth);
  drawList(doc, "Must-have skills met", candidate.mustHavesMet, SUCCESS, contentWidth);
  drawList(doc, "Must-have skills missing", candidate.mustHavesMissing, "#c4320a", contentWidth);
}

export async function generateScoutReportPdf(input: ScoutReportInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: PAGE_MARGIN,
      bufferPages: true,
      info: {
        Title: `${input.campaignName} — AI scouting shortlist`,
        Author: "Auxhr",
        Subject: `Top ${input.candidates.length} of ${input.totalCvs} CVs`,
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const contentWidth = doc.page.width - PAGE_MARGIN * 2;

    drawCover(doc, input, contentWidth);
    for (const candidate of input.candidates) {
      doc.addPage();
      drawCandidate(doc, candidate, contentWidth);
    }

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc
        .fontSize(8)
        .fillColor(MUTED)
        .text(
          `${input.campaignName} — generated by Auxhr AI on ${formatDate(new Date())}   ·   page ${
            i - range.start + 1
          } of ${range.count}`,
          PAGE_MARGIN,
          doc.page.height - 36,
          { width: contentWidth, align: "left", lineBreak: false }
        );
    }

    doc.end();
  });
}
