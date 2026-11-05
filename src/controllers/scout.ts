import { Request, Response } from "express";
import * as scoutRunService from "../services/scoutRun.js";
import * as talentSearchService from "../services/talentSearch.js";
import * as scoutReportService from "../services/scoutReport.js";
import * as jobService from "../services/job.js";
import * as messageService from "../services/message.js";
import { sendSuccessResponse } from "../utils/response.js";
import { ExperienceLevel, UserRole, WorkMode } from "../types/enums.js";
import { AppDataSource } from "../database/dataSource.js";
import { Organization } from "../entities/Organization.js";
import { User } from "../entities/User.js";
import { assertMonthlyHeadroom, recordUsage, assertWithinLimit } from "../services/entitlements.js";
import { requireActiveOrganizationId } from "../services/organizationScope.js";
import { NotFoundError, ValidationError } from "../utils/errors";

const isAdmin = (req: Request) => req.user.userRole === UserRole.Admin;

const CV_SCAN_FEATURE = "scout_cv_scans";
const TALENT_SEARCH_FEATURE = "talent_searches";

const activeOrganization = async (userId: string, action: string): Promise<Organization> => {
  const organizationId = await requireActiveOrganizationId(userId, action);
  const organization = await AppDataSource.getRepository(Organization).findOne({
    where: { id: organizationId },
  });
  if (!organization) {
    throw new NotFoundError("Company not found");
  }
  return organization;
};

export const startRun = async (req: Request, res: Response) => {
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const cvFiles = files?.["cv"] ?? [];

  // Charged for the whole batch up front: checking "am I at the limit" one CV at a
  // time would let a 50-CV upload sail past a quota with 5 left.
  const organization = await activeOrganization(req.user.id, "Create or switch to a company first");
  await assertMonthlyHeadroom(organization, CV_SCAN_FEATURE, cvFiles.length);

  const result = await scoutRunService.startScoutRun(req.user.id, {
    scoutJobId: req.params["id"]!,
    idempotencyKey: req.body.idempotencyKey,
    files: cvFiles,
  });

  // Only a genuinely new run consumes allowance, so a retried submit is free.
  if (!result.deduplicated) {
    await recordUsage(organization, CV_SCAN_FEATURE, cvFiles.length);
  }

  sendSuccessResponse(
    res,
    result.deduplicated ? "This upload is already being scored" : "Scouting started",
    { run: result.run },
    result.deduplicated ? 200 : 202
  );
};

export const fetchRun = async (req: Request, res: Response) => {
  const result = await scoutRunService.fetchRun(req.params["runId"]!, req.user.id, isAdmin(req));
  sendSuccessResponse(res, "Scout run fetched", result);
};

export const fetchShortlist = async (req: Request, res: Response) => {
  const result = await scoutRunService.fetchShortlist(
    req.params["runId"]!,
    req.user.id,
    isAdmin(req)
  );
  sendSuccessResponse(res, "Shortlist fetched", result);
};

export const listRuns = async (req: Request, res: Response) => {
  const result = await scoutRunService.fetchRunsForJob(
    req.params["id"]!,
    req.user.id,
    isAdmin(req),
    {
      limit: req.query["limit"] as string | undefined,
      offset: req.query["offset"] as string | undefined,
    }
  );
  sendSuccessResponse(res, "Scout runs fetched", result);
};

export const retryCv = async (req: Request, res: Response) => {
  const result = await scoutRunService.retryScoutCv(req.user.id, req.params["scoutId"]!);
  sendSuccessResponse(res, "Retrying this CV", { scout: result });
};

export const downloadReport = async (req: Request, res: Response) => {
  const { buffer, fileName } = await scoutReportService.buildScoutRunReport(
    req.params["runId"]!,
    req.user.id,
    isAdmin(req)
  );
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.setHeader("Content-Length", buffer.length);
  res.end(buffer);
};

export const searchTalents = async (req: Request, res: Response) => {
  const organization = await activeOrganization(req.user.id, "Create or switch to a company first");
  await assertWithinLimit(organization, TALENT_SEARCH_FEATURE);

  const result = await talentSearchService.searchTalents({
    description: req.body.description,
    roleId: req.body.roleId ?? null,
    experienceLevel: (req.body.experienceLevel as ExperienceLevel | undefined) ?? null,
    workMode: (req.body.workMode as WorkMode | undefined) ?? null,
    country: req.body.country ?? null,
    state: req.body.state ?? null,
    city: req.body.city ?? null,
    limit: req.body.limit as number | undefined,
    offset: req.body.offset as number | undefined,
  });

  await recordUsage(organization, TALENT_SEARCH_FEATURE);

  sendSuccessResponse(res, "Talents found", result);
};

/**
 * Streams a stored CV through the API rather than handing out the Spaces URL —
 * scouted CVs are uploaded private precisely so they can't be read by anyone who
 * guesses the link.
 */
export const downloadCandidateCv = async (req: Request, res: Response) => {
  const { buffer, fileName } = await talentSearchService.getCandidateCvPdf(
    req.params["candidateId"]!
  );

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
  res.setHeader("Content-Length", buffer.length);
  res.end(buffer);
};

/**
 * Opens a conversation with a sourced candidate. Only possible once that person has
 * a talent account — there is nobody to deliver an in-app message to otherwise, so
 * the response points the recruiter at their email instead.
 */
export const messageCandidate = async (req: Request, res: Response) => {
  const candidate = await talentSearchService.fetchCandidate(req.params["candidateId"]!);
  if (!candidate.emailNormalized) {
    throw new ValidationError("We don't have an email address for this candidate");
  }

  const talent = await AppDataSource.getRepository(User).findOne({
    where: { email: candidate.emailNormalized, userRole: UserRole.Talent },
  });
  if (!talent) {
    throw new ValidationError(
      `${candidate.fullName ?? "This candidate"} doesn't have a SalesPlat account yet, so they can't be messaged in the app. Invite them by email at ${candidate.emailNormalized}.`
    );
  }

  const result = await messageService.sendMessage(req.user.id, {
    content: req.body.content,
    recipient: talent.id,
  });
  sendSuccessResponse(res, "Message sent", { message: result });
};

export const addScoutToPipeline = async (req: Request, res: Response) => {
  const result = await jobService.addScoutToJobPipeline(req.user.id, {
    scoutId: req.params["scoutId"]!,
    jobId: req.body.jobId,
    talentEmail: req.body.talentEmail,
  });
  sendSuccessResponse(res, "Added to job pipeline", { application: result });
};
