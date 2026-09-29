/**
 * Pure unit tests for the pdfkit fit-report generator — no DB needed.
 */

import { generateFitReportPdf, type FitReportCandidate } from "../src/utils/fitReportPdf.js";

const baseCandidate: FitReportCandidate = {
  talentName: "Ada Lovelace",
  talentEmail: "ada@example.com",
  jobTitle: "Backend Engineer",
  companyName: "Acme Corp",
  appliedAt: new Date(),
  verdict: "high",
  overallFitScore: 88,
  recommendation: "hire",
  whyHire: "Shipped three production Kubernetes migrations solo.",
  whyFit: "Deep backend and infra experience.",
  strengths: ["Kubernetes migrations", "On-call leadership"],
  missingRequirements: ["No people-management experience"],
  conflictingRequirements: ["Claims 5 years but CV shows 3"],
  risks: ["May need ramp-up on our specific stack"],
  keyEvidence: ["CV: 'Led migration of payments service to Kubernetes'"],
  questionFeedback: [
    {
      question: "How do you handle a failed production deploy?",
      whatTheyAnswered: "Freeze deploys, isolate the canary, run a blameless review.",
      whatItDemonstrates: "Structured incident judgment under pressure.",
    },
  ],
};

describe("generateFitReportPdf", () => {
  it("produces a valid, non-trivial PDF for a single scored candidate", async () => {
    const buffer = await generateFitReportPdf([baseCandidate]);

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(500);
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("produces one combined PDF for several candidates (larger than a single one)", async () => {
    const single = await generateFitReportPdf([baseCandidate]);
    const multi = await generateFitReportPdf([
      baseCandidate,
      { ...baseCandidate, talentName: "Bola Adeyemi", verdict: "low", overallFitScore: 22 },
      { ...baseCandidate, talentName: "Chidi Okafor", verdict: "medium", overallFitScore: 55 },
    ]);

    expect(multi.subarray(0, 4).toString()).toBe("%PDF");
    expect(multi.length).toBeGreaterThan(single.length);
  });

  it("does not throw for a candidate with no verdict at all (pipeline not finished)", async () => {
    const noVerdict: FitReportCandidate = {
      ...baseCandidate,
      verdict: null,
      overallFitScore: null,
      recommendation: null,
      whyHire: null,
      whyFit: null,
      strengths: [],
      missingRequirements: [],
      conflictingRequirements: [],
      risks: [],
      keyEvidence: [],
      questionFeedback: [],
    };

    const buffer = await generateFitReportPdf([noVerdict]);

    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("does not throw when every evidence field is empty (a candidate with nothing recorded)", async () => {
    const empty: FitReportCandidate = {
      talentName: "",
      talentEmail: null,
      jobTitle: "Some Role",
      companyName: null,
      appliedAt: null,
      verdict: null,
      overallFitScore: null,
      recommendation: null,
      whyHire: null,
      whyFit: null,
      strengths: [],
      missingRequirements: [],
      conflictingRequirements: [],
      risks: [],
      keyEvidence: [],
      questionFeedback: [],
    };

    const buffer = await generateFitReportPdf([empty]);

    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("rejects rather than hangs when given zero candidates (empty page range is still a valid, tiny PDF)", async () => {
    const buffer = await generateFitReportPdf([]);
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("does not let an XSS-style talent name break the PDF generation (pdfkit renders text, not markup)", async () => {
    const buffer = await generateFitReportPdf([
      { ...baseCandidate, talentName: '<script>alert("x")</script>' },
    ]);
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
  });
});
