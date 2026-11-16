import {
  compareJobPay,
  compareSalaries,
  type SalaryComparisonQuery,
} from "../services/salaryComparison.js";
import { Request, Response } from "express";
import * as savedJobsService from "../services/savedJobs.js";
import * as jobService from "../services/job.js";
import * as paymentService from "../services/payment.js";
import { draftApplicantMessages } from "../services/applicantMessaging.js";
import { generateSingleFitReport, generateBulkFitReport } from "../services/fitReport.js";
import { JobStatus, UserRole } from "../types/enums.js";
import { sendSuccessResponse } from "../utils/response.js";
import { hideAssessmentResultsFromCandidate } from "../services/application.js";
import { getJobSummary } from "../services/jobSummary.js";

export const create = async (req: Request, res: Response) => {
  const result = await jobService.createJob(req.user.id, req.body);
  sendSuccessResponse(res, "Job created", { job: result }, 201);
};

export const generateContent = async (req: Request, res: Response) => {
  const result = await jobService.generateJobContent(req.body);
  sendSuccessResponse(res, "Job content generated", { content: result });
};

export const generateContentFromFile = async (req: Request, res: Response) => {
  const result = await jobService.generateJobContentFromFile(req.file, {
    richText: req.body?.richText === "true",
  });
  sendSuccessResponse(res, "Job content generated", { content: result });
};

export const generateField = async (req: Request, res: Response) => {
  const result = await jobService.generateJobField({ ...req.body, job: req.body.job ?? {} });
  sendSuccessResponse(res, "Job field generated", result);
};

export const update = async (req: Request, res: Response) => {
  const result = await jobService.updateJob(req.user.id, req.user.userRole, {
    id: req.params["_id"]!,
    ...req.body,
  });
  sendSuccessResponse(res, "Job updated", { job: result });
};

export const remove = async (req: Request, res: Response) => {
  await jobService.deleteJob(req.user.id, req.params["_id"]!);
  sendSuccessResponse(res, "Job deleted", {});
};

export const fetchAll = async (req: Request, res: Response) => {
  const talentId = req.user?.userRole === UserRole.Talent ? req.user.id : undefined;
  const result = await jobService.fetchAllJobs({
    ...req.query,
    status: JobStatus.Active,
    talentId,
  });
  sendSuccessResponse(res, "Jobs fetched", result);
};

export const jobsPosted = async (req: Request, res: Response) => {
  const result = await jobService.fetchRecruiterJobs(req.user.id, req.query);
  sendSuccessResponse(res, "Jobs fetched", result);
};

export const fetch = async (req: Request, res: Response) => {
  const viewer = req.user ? { id: req.user.id, role: req.user.userRole } : undefined;
  const result = await jobService.fetchJob(req.params["_id"]!, viewer);
  sendSuccessResponse(res, "Job fetched", { job: result });
};

export const matchJob = async (req: Request, res: Response) => {
  const result = await jobService.matchJob(req.user.id, req.user.userRole, {
    id: req.params["_id"]!,
    ...(req.query as Record<string, string>),
  });
  sendSuccessResponse(res, "Talents matched", { talents: result });
};

export const topTalents = async (req: Request, res: Response) => {
  const result = await jobService.topTalents(req.user.id, req.user.userRole, {
    jobId: req.params["jobId"]!,
    percentage: req.query["percentage"] ? Number(req.query["percentage"]) : undefined,
    limit: req.query["limit"] ? Number(req.query["limit"]) : undefined,
  });
  sendSuccessResponse(res, "Top talents fetched", result);
};

export const applications = async (req: Request, res: Response) => {
  const result = await jobService.jobApplications(req.user.id, req.user.userRole, {
    jobId: req.params["jobId"]!,
    ...(req.query as Record<string, string | number>),
  });
  sendSuccessResponse(res, "Applications fetched", result);
};

export const summary = async (req: Request, res: Response) => {
  const result = await getJobSummary(req.user.id, req.user.userRole, req.params["jobId"]!);
  sendSuccessResponse(res, "Job summary fetched", result);
};

export const draftApplicantMessagesController = async (req: Request, res: Response) => {
  const drafts = await draftApplicantMessages(
    req.user.id,
    req.user.userRole,
    req.params["jobId"]!,
    req.body.applicationIds,
    req.body.intent
  );
  sendSuccessResponse(res, "Drafted applicant messages", { drafts });
};

export const singleFitReport = async (req: Request, res: Response) => {
  const { buffer, fileName } = await generateSingleFitReport(
    req.user.id,
    req.user.userRole,
    req.params["jobId"]!,
    req.params["applicationId"]!
  );
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.setHeader("Content-Length", String(buffer.length));
  res.send(buffer);
};

export const bulkFitReport = async (req: Request, res: Response) => {
  const { buffer, fileName } = await generateBulkFitReport(
    req.user.id,
    req.user.userRole,
    req.params["jobId"]!,
    req.body.applicationIds
  );
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.setHeader("Content-Length", String(buffer.length));
  res.send(buffer);
};

export const retryVerdicts = async (req: Request, res: Response) => {
  const result = await jobService.retryMissingVerdicts(
    req.user.id,
    req.params["jobId"]!,
    req.body?.applicationIds
  );
  sendSuccessResponse(res, "Retried missing AI matches", result);
};

export const retryCvScore = async (req: Request, res: Response) => {
  const application = await jobService.retryCvSimilarityScore(
    req.user.id,
    req.params["jobId"]!,
    req.params["applicationId"]!
  );
  sendSuccessResponse(res, "CV match score calculated", { application });
};

export const apply = async (req: Request, res: Response) => {
  const result = hideAssessmentResultsFromCandidate(
    await jobService.apply(req.user, { jobId: req.params["jobId"]!, source: req.body.source })
  );
  sendSuccessResponse(res, "Application submitted", { application: result }, 201);
};

export const activatePayment = async (req: Request, res: Response) => {
  const result = await paymentService.initiateJobPayment(req.user, req.params["jobId"]!);
  sendSuccessResponse(res, "Payment link generated", result);
};

export const checkPrescreening = async (req: Request, res: Response) => {
  const result = hideAssessmentResultsFromCandidate(
    await jobService.checkPrescreeningAdvance(req.user.id, req.params["jobId"]!)
  );
  sendSuccessResponse(res, "Prescreening stage checked", { application: result });
};

export const salaryComparison = async (req: Request, res: Response) => {
  const result = await compareSalaries(req.query as unknown as SalaryComparisonQuery);
  sendSuccessResponse(res, "Salary comparison fetched", result);
};

export const saveJob = async (req: Request, res: Response) => {
  const result = await savedJobsService.saveJob(req.user.id, req.params["jobId"]!);
  sendSuccessResponse(res, "Job saved", result);
};

export const unsaveJob = async (req: Request, res: Response) => {
  const result = await savedJobsService.unsaveJob(req.user.id, req.params["jobId"]!);
  sendSuccessResponse(res, "Job removed from saved", result);
};

export const payComparison = async (req: Request, res: Response) => {
  const result = await compareJobPay(req.params["jobId"]!);
  sendSuccessResponse(res, "Pay comparison fetched", result);
};
