import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";

export interface FitReportQuestionFeedback {
  question: string;
  whatTheyAnswered: string;
  whatItDemonstrates: string;
}

export interface FitReportCandidate {
  talentName: string;
  talentEmail?: string | null;
  jobTitle: string;
  companyName?: string | null;
  appliedAt?: Date | null;
  verdict: "high" | "medium" | "low" | null;
  overallFitScore: number | null;
  recommendation: "hire" | "interview_further" | "no_hire" | null;
  whyHire?: string | null;
  whyFit?: string | null;
  strengths: string[];
  missingRequirements: string[];
  conflictingRequirements: string[];
  risks: string[];
  keyEvidence: string[];
  questionFeedback: FitReportQuestionFeedback[];
}

type Doc = PDFKit.PDFDocument;

const SIDE = 48;
const TOP = 92;
const BOTTOM = 64;
const HEADER_RULE_Y = 66;

const INK = "#101828";
const BODY = "#344054";
const MUTED = "#667085";
const LINE = "#e4e7ec";
const SURFACE = "#f8f9fc";
const BRAND = "#1527be";
const BRAND_TINT = "#eaf2ff";

const TONES = {
  high: { color: "#1b7b44", tint: "#e8f5ee" },
  medium: { color: "#b54708", tint: "#fdf3e7" },
  low: { color: "#c4320a", tint: "#fdeee9" },
  none: { color: MUTED, tint: "#f2f4f7" },
} as const;

const LOGO_PATH = path.join(process.cwd(), "templates", "auxhr-logo.png");
const LOGO_HEIGHT = 24;
const LOGO_WIDTH = (LOGO_HEIGHT * 950) / 404;

const formatDate = (date: Date): string =>
  date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

// The same plain-English framing as the dossier panel's banner: the recruiter gets the
// recommendation from one sentence, and the evidence below is the "why".
const verdictSentence = (candidate: FitReportCandidate): string => {
  const { verdict, recommendation, jobTitle } = candidate;
  if (!verdict) {
    return `AI recommendation pending for ${jobTitle} — the screening pipeline hasn't finished yet.`;
  }
  if (verdict === "high" || recommendation === "hire") {
    return `We'd shortlist this candidate for ${jobTitle} — strong evidence of fit against the role's requirements.`;
  }
  if (verdict === "low" || recommendation === "no_hire") {
    return `We wouldn't shortlist this candidate for ${jobTitle} — notable gaps against the role's requirements.`;
  }
  return `Worth a closer look for ${jobTitle} — some strong signals alongside open questions.`;
};

const verdictLabel = (verdict: FitReportCandidate["verdict"]): string => {
  if (verdict === "high") return "Strong fit";
  if (verdict === "medium") return "Potential fit";
  if (verdict === "low") return "Poor fit";
  return "Not yet scored";
};

const contentWidth = (doc: Doc): number => doc.page.width - SIDE * 2;
const pageBottom = (doc: Doc): number => doc.page.height - BOTTOM;

/** Starts a new page when the next block wouldn't fit, so titles and cards never split. */
const ensureSpace = (doc: Doc, needed: number): void => {
  if (doc.y + needed > pageBottom(doc)) {
    doc.addPage();
  }
};

const eyebrow = (doc: Doc, text: string, x: number, y: number, color: string): void => {
  doc
    .font("Helvetica-Bold")
    .fontSize(7.5)
    .fillColor(color)
    .text(text.toUpperCase(), x, y, { characterSpacing: 1.1, lineBreak: false });
};

function drawCandidateHeader(doc: Doc, candidate: FitReportCandidate): void {
  const width = contentWidth(doc);
  const top = doc.y;
  eyebrow(doc, "Candidate", SIDE, top, BRAND);
  doc
    .font("Helvetica-Bold")
    .fontSize(22)
    .fillColor(INK)
    .text(candidate.talentName || "Candidate", SIDE, top + 15, { width });
  doc.moveDown(0.15);
  const role = [candidate.jobTitle, candidate.companyName].filter(Boolean).join(" at ");
  doc.font("Helvetica").fontSize(11).fillColor(BODY).text(role, { width });
  const details = [
    candidate.talentEmail,
    candidate.appliedAt ? `Applied ${formatDate(candidate.appliedAt)}` : null,
  ].filter(Boolean);
  if (details.length > 0) {
    doc.moveDown(0.25);
    doc.fontSize(9).fillColor(MUTED).text(details.join("   ·   "), { width });
  }
  doc.moveDown(1.1);
}

function drawScoreCard(doc: Doc, candidate: FitReportCandidate): void {
  const width = contentWidth(doc);
  const tone = TONES[candidate.verdict ?? "none"];
  const scoreWidth = 132;
  const textWidth = width - scoreWidth - 44;
  const sentence = verdictSentence(candidate);

  doc.font("Helvetica").fontSize(10.5);
  const sentenceHeight = doc.heightOfString(sentence, { width: textWidth, lineGap: 2 });
  const height = Math.max(92, 52 + sentenceHeight);
  ensureSpace(doc, height + 20);
  const top = doc.y;

  doc.roundedRect(SIDE, top, width, height, 8).lineWidth(0.75).fillAndStroke(SURFACE, LINE);
  doc.rect(SIDE, top + 8, 3, height - 16).fill(tone.color);

  const label = verdictLabel(candidate.verdict).toUpperCase();
  doc.font("Helvetica-Bold").fontSize(8);
  const pillWidth = doc.widthOfString(label, { characterSpacing: 0.8 }) + 18;
  doc.roundedRect(SIDE + 20, top + 16, pillWidth, 18, 9).fill(tone.tint);
  doc
    .fillColor(tone.color)
    .text(label, SIDE + 29, top + 21.5, { characterSpacing: 0.8, lineBreak: false });
  doc
    .font("Helvetica")
    .fontSize(10.5)
    .fillColor(BODY)
    .text(sentence, SIDE + 20, top + 44, { width: textWidth, lineGap: 2 });

  const scoreX = SIDE + width - scoreWidth - 20;
  eyebrow(doc, "Overall fit", scoreX, top + 18, MUTED);
  const score = candidate.overallFitScore;
  if (score == null) {
    doc
      .font("Helvetica-Bold")
      .fontSize(26)
      .fillColor(MUTED)
      .text("—", scoreX, top + 32);
  } else {
    const value = `${Math.round(score)}`;
    doc.font("Helvetica-Bold").fontSize(28).fillColor(tone.color);
    const valueWidth = doc.widthOfString(value);
    doc.text(value, scoreX, top + 30, { lineBreak: false });
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(MUTED)
      .text("/100", scoreX + valueWidth + 3, top + 44, { lineBreak: false });
    const barTop = top + 68;
    const filled = Math.max(0, Math.min(1, score / 100)) * scoreWidth;
    doc.roundedRect(scoreX, barTop, scoreWidth, 6, 3).fill(LINE);
    if (filled > 0) doc.roundedRect(scoreX, barTop, Math.max(filled, 6), 6, 3).fill(tone.color);
  }

  doc.y = top + height + 22;
  doc.x = SIDE;
}

const SECTION_TITLE_HEIGHT = 24;

function drawSectionTitle(doc: Doc, title: string, color: string): void {
  const top = doc.y;
  doc.rect(SIDE, top + 1, 3, 12).fill(color);
  doc
    .font("Helvetica-Bold")
    .fontSize(11.5)
    .fillColor(INK)
    .text(title, SIDE + 11, top, { width: contentWidth(doc) - 11 });
  doc.y = top + SECTION_TITLE_HEIGHT - 4;
}

function drawParagraphSection(doc: Doc, title: string, text: string, color: string): void {
  const width = contentWidth(doc) - 11;
  doc.font("Helvetica").fontSize(10.5);
  const firstLines = Math.min(doc.heightOfString(text, { width, lineGap: 3 }), 60);
  ensureSpace(doc, SECTION_TITLE_HEIGHT + firstLines);
  drawSectionTitle(doc, title, color);
  doc
    .font("Helvetica")
    .fontSize(10.5)
    .fillColor(BODY)
    .text(text, SIDE + 11, doc.y, { width, lineGap: 3 });
  doc.y += 18;
}

function drawListSection(doc: Doc, title: string, items: string[], color: string): void {
  if (items.length === 0) return;
  const textX = SIDE + 24;
  const width = contentWidth(doc) - 24;
  const itemHeight = (item: string) => {
    doc.font("Helvetica").fontSize(10);
    return doc.heightOfString(item, { width, lineGap: 2.5 }) + 6;
  };

  ensureSpace(doc, SECTION_TITLE_HEIGHT + itemHeight(items[0]!));
  drawSectionTitle(doc, title, color);
  for (const item of items) {
    ensureSpace(doc, itemHeight(item));
    const top = doc.y;
    doc.circle(SIDE + 14, top + 5.5, 2.2).fill(color);
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(BODY)
      .text(item, textX, top, { width, lineGap: 2.5 });
    doc.y += 6;
  }
  doc.y += 12;
}

function drawQuestionCards(doc: Doc, feedback: FitReportQuestionFeedback[]): void {
  if (feedback.length === 0) return;
  const width = contentWidth(doc);
  const inner = width - 32;

  const measure = (qa: FitReportQuestionFeedback) => {
    doc.font("Helvetica-Bold").fontSize(10);
    const question = doc.heightOfString(qa.question, { width: inner, lineGap: 2 });
    doc.font("Helvetica").fontSize(9.5);
    const answer = doc.heightOfString(qa.whatTheyAnswered, { width: inner, lineGap: 2 });
    doc.font("Helvetica-Oblique").fontSize(9.5);
    const shows = qa.whatItDemonstrates
      ? doc.heightOfString(qa.whatItDemonstrates, { width: inner, lineGap: 2 })
      : 0;
    return { question, answer, shows };
  };
  const cardHeight = (m: ReturnType<typeof measure>) =>
    14 + m.question + 10 + 12 + m.answer + (m.shows ? 10 + 12 + m.shows : 0) + 14;

  ensureSpace(doc, SECTION_TITLE_HEIGHT + cardHeight(measure(feedback[0]!)));
  drawSectionTitle(doc, "Screening question feedback", BRAND);

  for (const qa of feedback) {
    const m = measure(qa);
    const height = cardHeight(m);
    ensureSpace(doc, height + 10);
    const top = doc.y;
    const x = SIDE + 16;
    doc.roundedRect(SIDE, top, width, height, 6).lineWidth(0.75).fillAndStroke("#ffffff", LINE);

    let y = top + 14;
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor(INK)
      .text(qa.question, x, y, { width: inner, lineGap: 2 });
    y += m.question + 10;
    eyebrow(doc, "What they answered", x, y, MUTED);
    y += 12;
    doc
      .font("Helvetica")
      .fontSize(9.5)
      .fillColor(BODY)
      .text(qa.whatTheyAnswered, x, y, { width: inner, lineGap: 2 });
    y += m.answer;
    if (qa.whatItDemonstrates) {
      y += 10;
      eyebrow(doc, "What it shows", x, y, BRAND);
      y += 12;
      doc
        .font("Helvetica-Oblique")
        .fontSize(9.5)
        .fillColor(BODY)
        .text(qa.whatItDemonstrates, x, y, { width: inner, lineGap: 2 });
    }
    doc.y = top + height + 10;
  }
  doc.x = SIDE;
}

function drawCandidate(doc: Doc, candidate: FitReportCandidate): void {
  drawCandidateHeader(doc, candidate);
  drawScoreCard(doc, candidate);

  const why = candidate.whyHire || candidate.whyFit;
  if (why) drawParagraphSection(doc, "Why this candidate fits", why, BRAND);
  drawListSection(doc, "Strengths", candidate.strengths, TONES.high.color);
  drawListSection(
    doc,
    "Gaps against requirements",
    candidate.missingRequirements,
    TONES.medium.color
  );
  drawListSection(
    doc,
    "Conflicting or inconsistent answers",
    candidate.conflictingRequirements,
    TONES.low.color
  );
  drawListSection(doc, "Risks to weigh", candidate.risks, TONES.low.color);
  drawListSection(doc, "Evidence cited", candidate.keyEvidence, BRAND);
  drawQuestionCards(doc, candidate.questionFeedback);
}

/** The logo, title and rule at the top of every page, and the date and page number at the bottom. */
function drawPageFrames(doc: Doc, generatedOn: string, hasLogo: boolean): void {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const width = contentWidth(doc);
    const margins = { ...doc.page.margins };
    doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 };

    if (hasLogo) {
      doc.image(LOGO_PATH, SIDE, 30, { height: LOGO_HEIGHT });
    } else {
      doc.font("Helvetica-Bold").fontSize(16).fillColor(BRAND).text("AuxHR", SIDE, 33);
    }
    doc
      .font("Helvetica-Bold")
      .fontSize(7.5)
      .fillColor(MUTED)
      .text("CANDIDATE FIT REPORT", SIDE, 37, {
        width,
        align: "right",
        characterSpacing: 1.1,
        lineBreak: false,
      });
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(MUTED)
      .text(generatedOn, SIDE, 49, { width, align: "right", lineBreak: false });
    doc
      .moveTo(SIDE, HEADER_RULE_Y)
      .lineTo(SIDE + width, HEADER_RULE_Y)
      .lineWidth(1.25)
      .strokeColor(BRAND)
      .stroke();

    const footerY = doc.page.height - 40;
    doc
      .moveTo(SIDE, footerY - 8)
      .lineTo(SIDE + width, footerY - 8)
      .lineWidth(0.5)
      .strokeColor(LINE)
      .stroke();
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(MUTED)
      .text("AuxHR  ·  Confidential, prepared for the hiring team", SIDE, footerY, {
        lineBreak: false,
      });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, SIDE, footerY, {
      width,
      align: "right",
      lineBreak: false,
    });

    doc.page.margins = margins;
  }
}

/**
 * Evidence-based fit report(s), one section per candidate, using the same AI match analysis
 * the dossier panel shows. Single-candidate downloads pass one entry; a shortlisted-set
 * download passes several, each starting on a new page.
 */
export async function generateFitReportPdf(candidates: FitReportCandidate[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: TOP, bottom: BOTTOM, left: SIDE, right: SIDE },
      bufferPages: true,
      info: {
        Title:
          candidates.length === 1
            ? `${candidates[0]!.talentName} — Fit report`
            : `Candidate fit report (${candidates.length})`,
        Author: "AuxHR",
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    candidates.forEach((candidate, index) => {
      if (index > 0) doc.addPage();
      drawCandidate(doc, candidate);
    });

    drawPageFrames(doc, `Generated ${formatDate(new Date())}`, fs.existsSync(LOGO_PATH));
    doc.end();
  });
}
