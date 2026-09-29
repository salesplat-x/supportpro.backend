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

const PAGE_MARGIN = 54;
const INK = "#101828";
const BODY = "#344054";
const MUTED = "#667085";
const VERDICT_COLORS: Record<string, string> = {
  high: "#1b7b44",
  medium: "#b54708",
  low: "#c4320a",
};
const FALLBACK_COLOR = "#3c6fd4";

// Same plain-English framing as the dossier panel's top banner — a recruiter
// should get the recommendation from this one sentence, evidence below is
// the "why".
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

const verdictLabel = (verdict: string | null): string => {
  if (verdict === "high") return "Strong fit";
  if (verdict === "medium") return "Potential fit";
  if (verdict === "low") return "Poor fit";
  return "Not yet scored";
};

function drawList(
  doc: PDFKit.PDFDocument,
  title: string,
  items: string[],
  color: string,
  contentWidth: number
): void {
  if (items.length === 0) return;
  doc.moveDown(0.6);
  doc.fillColor(color).font("Helvetica-Bold").fontSize(11).text(title, { width: contentWidth });
  doc.moveDown(0.2);
  doc.fillColor(BODY).font("Helvetica").fontSize(10);
  for (const item of items) {
    doc.text(`•  ${item}`, { width: contentWidth, lineGap: 2 });
  }
}

function drawCandidate(
  doc: PDFKit.PDFDocument,
  candidate: FitReportCandidate,
  contentWidth: number
): void {
  const accent =
    (candidate.verdict ? VERDICT_COLORS[candidate.verdict] : undefined) ?? FALLBACK_COLOR;

  doc.fillColor(INK).font("Helvetica-Bold").fontSize(20).text(candidate.talentName, {
    width: contentWidth,
  });
  const subtitleBits = [
    candidate.jobTitle,
    candidate.companyName ?? undefined,
    candidate.talentEmail ?? undefined,
  ].filter(Boolean);
  doc.moveDown(0.2);
  doc.fillColor(MUTED).font("Helvetica").fontSize(10).text(subtitleBits.join("  ·  "), {
    width: contentWidth,
  });

  doc.moveDown(0.8);
  doc.roundedRect(PAGE_MARGIN, doc.y, contentWidth, 68, 6).fill("#f7f8fb");
  const boxTop = doc.y - 68;
  doc
    .fillColor(accent)
    .font("Helvetica-Bold")
    .fontSize(13)
    .text(verdictLabel(candidate.verdict), PAGE_MARGIN + 16, boxTop + 14, {
      width: contentWidth - 140,
    });
  doc
    .fillColor(BODY)
    .font("Helvetica")
    .fontSize(10)
    .text(verdictSentence(candidate), PAGE_MARGIN + 16, boxTop + 34, {
      width: contentWidth - 140,
      lineGap: 2,
    });
  if (candidate.overallFitScore != null) {
    doc
      .fillColor(accent)
      .font("Helvetica-Bold")
      .fontSize(24)
      .text(
        `${Math.round(candidate.overallFitScore)}`,
        PAGE_MARGIN + contentWidth - 110,
        boxTop + 16,
        {
          width: 90,
          align: "right",
        }
      );
    doc
      .fillColor(MUTED)
      .font("Helvetica")
      .fontSize(8)
      .text("OVERALL FIT SCORE", PAGE_MARGIN + contentWidth - 110, boxTop + 44, {
        width: 90,
        align: "right",
      });
  }
  doc.y = boxTop + 68 + 14;

  if (candidate.whyHire || candidate.whyFit) {
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text("Why this candidate fits", {
      width: contentWidth,
    });
    doc.moveDown(0.2);
    doc
      .fillColor(BODY)
      .font("Helvetica")
      .fontSize(10)
      .text(candidate.whyHire || candidate.whyFit || "", { width: contentWidth, lineGap: 2 });
  }

  drawList(doc, "Strengths", candidate.strengths, "#1b7b44", contentWidth);
  drawList(
    doc,
    "Gaps against requirements",
    candidate.missingRequirements,
    "#b54708",
    contentWidth
  );
  drawList(
    doc,
    "Conflicting or inconsistent answers",
    candidate.conflictingRequirements,
    "#c4320a",
    contentWidth
  );
  drawList(doc, "Risks to weigh", candidate.risks, "#c4320a", contentWidth);
  drawList(doc, "Evidence cited", candidate.keyEvidence, "#3c6fd4", contentWidth);

  if (candidate.questionFeedback.length > 0) {
    doc.moveDown(0.6);
    doc
      .fillColor(INK)
      .font("Helvetica-Bold")
      .fontSize(11)
      .text("Screening question feedback", { width: contentWidth });
    for (const qa of candidate.questionFeedback) {
      doc.moveDown(0.3);
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(9.5).text(qa.question, {
        width: contentWidth,
      });
      doc
        .fillColor(BODY)
        .font("Helvetica")
        .fontSize(9.5)
        .text(`Answered: ${qa.whatTheyAnswered}`, { width: contentWidth, lineGap: 1 });
      if (qa.whatItDemonstrates) {
        doc
          .fillColor(MUTED)
          .font("Helvetica-Oblique")
          .fontSize(9.5)
          .text(`Demonstrates: ${qa.whatItDemonstrates}`, { width: contentWidth, lineGap: 1 });
      }
    }
  }
}

/**
 * Evidence-based fit report(s), one section per candidate, using the same
 * AI match analysis the dossier panel shows. Single-candidate downloads pass
 * one entry; a shortlisted-set download passes several.
 */
export async function generateFitReportPdf(candidates: FitReportCandidate[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: PAGE_MARGIN,
      bufferPages: true,
      info: {
        Title:
          candidates.length === 1
            ? `${candidates[0]!.talentName} — Fit report`
            : `Candidate fit report (${candidates.length})`,
        Author: "Auxhr",
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const contentWidth = doc.page.width - PAGE_MARGIN * 2;

    candidates.forEach((candidate, index) => {
      if (index > 0) doc.addPage();
      drawCandidate(doc, candidate, contentWidth);
    });

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc
        .fontSize(8)
        .fillColor(MUTED)
        .text(
          `Generated by Auxhr AI — ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}`,
          PAGE_MARGIN,
          doc.page.height - 36,
          { width: contentWidth, align: "left", lineBreak: false }
        );
    }

    doc.end();
  });
}
