import { In } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Application } from "../entities/Application.js";
import { Job } from "../entities/Job.js";
import { User } from "../entities/User.js";
import { UserRole } from "../types/enums.js";
import { NotFoundError, ValidationError } from "../utils/errors";
import { draftApplicantMessage } from "../utils/integrations/openai.js";
import { sanitizeDraft } from "./onboardingRules.js";
import { assertRecruiterJobAccess } from "./job.js";
import { loadRecommendationsByApplicationIds, overlayVerdictFromRecommendation } from "./applicationStage.js";
import logger from "../utils/logger.js";

const applicationRepo = () => AppDataSource.getRepository(Application);
const jobRepo = () => AppDataSource.getRepository(Job);

export interface ApplicantMessageDraft {
  applicationId: string;
  talentId: string;
  talentName: string;
  subject?: string;
  body?: string;
  error?: string;
}

// One AI draft per selected candidate, grounded in their own match evidence —
// never one generic message copy-pasted across recipients. A single bad LLM
// response only fails that candidate's draft, not the whole batch.
export const draftApplicantMessages = async (
  recruiterId: string,
  userRole: UserRole,
  jobId: string,
  applicationIds: string[],
  intent?: string
): Promise<ApplicantMessageDraft[]> => {
  if (applicationIds.length === 0) {
    throw new ValidationError("Select at least one candidate");
  }
  if (applicationIds.length > 50) {
    throw new ValidationError("Draft messages for at most 50 candidates at a time");
  }

  const job = await jobRepo().findOne({ where: { id: jobId }, relations: { role: true, organization: true } });
  if (!job) {
    throw new NotFoundError("Job not found");
  }
  await assertRecruiterJobAccess(recruiterId, userRole, job);

  const recruiter = await AppDataSource.getRepository(User).findOne({ where: { id: recruiterId } });
  if (!recruiter) {
    throw new NotFoundError("Recruiter not found");
  }

  const applications = await applicationRepo().find({
    where: { id: In(applicationIds), jobId },
    relations: { talent: true },
  });
  if (applications.length === 0) {
    throw new ValidationError("None of the selected candidates were found on this job");
  }

  const recommendations = await loadRecommendationsByApplicationIds(applications.map((a) => a.id));
  const withMatch = applications.map((application) =>
    overlayVerdictFromRecommendation(application, recommendations.get(application.id))
  );

  const results = await Promise.allSettled(
    withMatch.map(async (application): Promise<ApplicantMessageDraft> => {
      const talent = application.talent;
      const talentName = [talent.firstName, talent.lastName].filter(Boolean).join(" ") || "there";
      const analysis = (application as unknown as { matchAnalysis?: Record<string, unknown> })
        .matchAnalysis;

      const response = await draftApplicantMessage({
        talentFirstName: talent.firstName || "there",
        jobTitle: job.role?.name ?? "the role",
        companyName: job.organization?.name,
        recruiterFirstName: recruiter.firstName,
        intent,
        verdict: application.matchVerdict,
        overallFitScore: application.overallFitScore,
        whyHire: typeof analysis?.["whyHire"] === "string" ? (analysis["whyHire"] as string) : undefined,
        strongestQualifications: Array.isArray(analysis?.["strongestQualifications"])
          ? (analysis["strongestQualifications"] as string[])
          : (application.matchStrengths ?? undefined),
        keyEvidence: Array.isArray(analysis?.["keyEvidence"])
          ? (analysis["keyEvidence"] as string[])
          : undefined,
      });

      if (!response?.message.content) {
        throw new Error("The AI returned nothing");
      }
      const draft = sanitizeDraft(response.message.content);
      return {
        applicationId: application.id,
        talentId: talent.id,
        talentName,
        subject: draft.subject,
        body: draft.body,
      };
    })
  );

  return results.map((result, index) => {
    const application = withMatch[index]!;
    if (result.status === "fulfilled") return result.value;
    logger.error(
      `Applicant message draft failed for application ${application.id}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
    );
    return {
      applicationId: application.id,
      talentId: application.talentId,
      talentName:
        [application.talent?.firstName, application.talent?.lastName].filter(Boolean).join(" ") ||
        "there",
      error: "Couldn't draft a message for this candidate. Try again or write one by hand.",
    };
  });
};
