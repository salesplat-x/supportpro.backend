import { ConflictError } from "../utils/errors";
import { ScoutRunStatus } from "../types/enums.js";
import { generateScoutReportPdf, ScoutReportCandidate } from "../utils/scoutReportPdf.js";
import { fetchShortlist } from "./scoutRun.js";

/** Pulled back out of the stored insights, which are written as "Label: a; b" lines. */
const parseInsightSection = (insights: string | null, label: string): string[] => {
  if (!insights) return [];
  const line = insights
    .split("\n")
    .find((entry) => entry.toLowerCase().startsWith(`${label.toLowerCase()}:`));
  if (!line) return [];
  return line
    .slice(line.indexOf(":") + 1)
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

export interface ScoutReportFile {
  buffer: Buffer;
  fileName: string;
}

export const buildScoutRunReport = async (
  runId: string,
  userId: string,
  isAdmin: boolean
): Promise<ScoutReportFile> => {
  const { run, shortlist } = await fetchShortlist(runId, userId, isAdmin);

  // A report of a run that is still scoring would be wrong the moment it downloads.
  if (run.status === ScoutRunStatus.Processing) {
    throw new ConflictError("This run is still being scored — try again once it finishes");
  }

  const job = run.scoutJob;
  const candidates: ScoutReportCandidate[] = shortlist.map((scout, index) => ({
    rank: scout.rank ?? index + 1,
    name: scout.candidateName ?? scout.cvName ?? `Candidate ${index + 1}`,
    email: scout.candidateEmail,
    phone: scout.candidatePhone,
    location: scout.candidateAddress,
    headline: scout.candidate?.headline ?? null,
    score: scout.evaluationScore,
    recommendation: scout.recommendation,
    strengths: parseInsightSection(scout.insights, "Strengths"),
    concerns: parseInsightSection(scout.insights, "Concerns"),
    mustHavesMet: parseInsightSection(scout.insights, "Met must-haves"),
    mustHavesMissing: parseInsightSection(scout.insights, "Missing must-haves"),
  }));

  const campaignName = job?.name ?? "Scouting campaign";
  const buffer = await generateScoutReportPdf({
    campaignName,
    roleName: job?.role?.name ?? "",
    experienceLevel: job?.experienceLevel ?? null,
    jobBrief: job?.jobBrief ?? "",
    recruiterGuide: job?.recruiterGuide ?? "",
    runDate: run.completedAt ?? run.createdAt,
    totalCvs: run.totalCvs,
    shortlistSummary: run.shortlistSummary,
    candidates,
  });

  const slug =
    campaignName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "scouting";

  return { buffer, fileName: `${slug}-shortlist.pdf` };
};
