import { In } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Application } from "../entities/Application.js";
import { Job } from "../entities/Job.js";
import { UserRole } from "../types/enums.js";
import { NotFoundError, ValidationError } from "../utils/errors";
import { generateFitReportPdf, type FitReportCandidate } from "../utils/fitReportPdf.js";
import { assertRecruiterJobAccess } from "./job.js";
import { loadRecommendationsByApplicationIds, overlayVerdictFromRecommendation } from "./applicationStage.js";
import type { MatchAnalysis } from "../utils/matchAnalysis.js";

const applicationRepo = () => AppDataSource.getRepository(Application);
const jobRepo = () => AppDataSource.getRepository(Job);

const MAX_CANDIDATES_PER_REPORT = 50;

const toCandidate = (
  application: Application & { matchAnalysis?: MatchAnalysis | null },
  jobTitle: string,
  companyName?: string | null
): FitReportCandidate => {
  const analysis = application.matchAnalysis ?? null;
  const talent = application.talent;
  return {
    talentName: [talent.firstName, talent.lastName].filter(Boolean).join(" ") || "Candidate",
    talentEmail: talent.email,
    jobTitle,
    companyName,
    appliedAt: application.createdAt,
    verdict: application.matchVerdict,
    overallFitScore: application.overallFitScore,
    recommendation: application.matchRecommendation,
    whyHire: analysis?.whyHire || application.matchVerdictReasoning,
    whyFit: analysis?.whyFit,
    strengths: analysis?.strongestQualifications?.length
      ? analysis.strongestQualifications
      : (application.matchStrengths ?? []),
    missingRequirements: analysis?.missingRequirements?.length
      ? analysis.missingRequirements
      : (application.matchWeaknesses ?? []),
    conflictingRequirements: analysis?.conflictingRequirements ?? [],
    risks: application.matchRisks ?? [],
    keyEvidence: analysis?.keyEvidence ?? [],
    questionFeedback: (analysis?.questionFeedback ?? []).map((q) => ({
      question: q.question,
      whatTheyAnswered: q.whatTheyAnswered,
      whatItDemonstrates: q.whatItDemonstrates,
    })),
  };
};

const loadCandidates = async (
  userId: string,
  userRole: UserRole,
  jobId: string,
  applicationIds: string[]
): Promise<{ candidates: FitReportCandidate[]; job: Job }> => {
  const job = await jobRepo().findOne({ where: { id: jobId }, relations: { role: true, organization: true } });
  if (!job) {
    throw new NotFoundError("Job not found");
  }
  await assertRecruiterJobAccess(userId, userRole, job);

  const applications = await applicationRepo().find({
    where: { id: In(applicationIds), jobId },
    relations: { talent: true },
  });
  if (applications.length === 0) {
    throw new NotFoundError("No matching candidates found on this job");
  }

  const recommendations = await loadRecommendationsByApplicationIds(applications.map((a) => a.id));
  const withMatch = applications.map((application) =>
    overlayVerdictFromRecommendation(application, recommendations.get(application.id))
  );

  const jobTitle = job.role?.name ?? "the role";
  const companyName = job.organization?.name;
  return {
    job,
    candidates: withMatch.map((application) => toCandidate(application, jobTitle, companyName)),
  };
};

export interface FitReportResult {
  buffer: Buffer;
  fileName: string;
}

export const generateSingleFitReport = async (
  userId: string,
  userRole: UserRole,
  jobId: string,
  applicationId: string
): Promise<FitReportResult> => {
  const { candidates } = await loadCandidates(userId, userRole, jobId, [applicationId]);
  const buffer = await generateFitReportPdf(candidates);
  const safeName = candidates[0]!.talentName.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return { buffer, fileName: `fit-report-${safeName}.pdf` };
};

export const generateBulkFitReport = async (
  userId: string,
  userRole: UserRole,
  jobId: string,
  applicationIds: string[]
): Promise<FitReportResult> => {
  if (applicationIds.length === 0) {
    throw new ValidationError("Select at least one candidate");
  }
  if (applicationIds.length > MAX_CANDIDATES_PER_REPORT) {
    throw new ValidationError(`Reports are limited to ${MAX_CANDIDATES_PER_REPORT} candidates at a time`);
  }
  const { candidates, job } = await loadCandidates(userId, userRole, jobId, applicationIds);
  const buffer = await generateFitReportPdf(candidates);
  const safeName = (job.role?.name ?? "job").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return { buffer, fileName: `fit-report-${safeName}-${candidates.length}-candidates.pdf` };
};
