import { body, query, param } from "express-validator";
import { paginationRules, idParam } from "./shared.js";
import {
  ExperienceLevel,
  WorkMode,
  JobStatus,
  ApplicationType,
  ApplicationStatus,
  CompensationPeriod,
  MatchVerdict,
} from "../types/enums.js";
import { workModeNeedsLocation } from "../utils/workMode.js";

export const generateJobContentValidator = [
  body("role").optional().isString().trim(),
  body("prompt")
    .optional()
    .isString()
    .trim()
    .isLength({ max: 4000 })
    .withMessage("Description must be at most 4000 characters"),
  body("sourceText")
    .optional()
    .isString()
    .trim()
    .isLength({ max: 30000 })
    .withMessage("Job description must be at most 30000 characters"),
  body("experienceLevel").optional().isString(),
  body("keywords").optional().isArray(),
  body("keywords.*").optional().isString(),
  body("richText").optional().isBoolean().withMessage("richText must be a boolean").toBoolean(),
  body().custom((value) => {
    if (!value?.role && !value?.prompt && !value?.sourceText) {
      throw new Error("Provide a role, a description of the job, or an existing job description");
    }
    return true;
  }),
];

const JOB_TEXT_FIELDS = ["jobBrief", "requirements", "recruiterGuide"];
const JOB_LIST_FIELDS = ["skills", "goals"];

export const generateJobFieldValidator = [
  body("field")
    .isIn([...JOB_TEXT_FIELDS, ...JOB_LIST_FIELDS])
    .withMessage(`field must be one of: ${[...JOB_TEXT_FIELDS, ...JOB_LIST_FIELDS].join(", ")}`),
  body("action")
    .optional()
    .isIn(["regenerate", "shorter", "detailed", "friendlier"])
    .withMessage("action must be one of: regenerate, shorter, detailed, friendlier"),
  body("currentText").optional().isString().isLength({ max: 30000 }),
  body("richText").optional().isBoolean().withMessage("richText must be a boolean").toBoolean(),
  body("job").optional().isObject(),
  body("job.role").optional().isString(),
  body("job.experienceLevel").optional().isString(),
  body("job.jobBrief").optional().isString().isLength({ max: 30000 }),
  body("job.requirements").optional().isString().isLength({ max: 30000 }),
  body("job.skills").optional().isArray(),
  body("job.skills.*").optional().isString(),
  body("job.goals").optional().isArray(),
  body("job.goals.*").optional().isString(),
  body().custom((value) => {
    if (!value?.job?.role && !value?.job?.jobBrief) {
      throw new Error("Give the AI a role or a job brief to work from");
    }
    return true;
  }),
];

export const createJobValidator = [
  body("role").notEmpty().trim().withMessage("Role is required"),
  body("aiConfig").optional().isString(),
  body("jobBrief").notEmpty().withMessage("Job brief is required"),
  body("experienceLevel")
    .isIn(Object.values(ExperienceLevel))
    .withMessage(`experienceLevel must be one of: ${Object.values(ExperienceLevel).join(", ")}`),
  body("maxSalary")
    .optional()
    .isFloat({ min: 0, max: 100000000 })
    .toFloat()
    .withMessage("Valid maxSalary required"),
  body("minSalary")
    .isFloat({ min: 0, max: 100000000 })
    .toFloat()
    .withMessage("Valid minSalary required")
    .custom((value, { req }) => {
      if (req.body.maxSalary !== undefined && value >= req.body.maxSalary) {
        throw new Error("minSalary must be less than maxSalary");
      }
      return true;
    }),
  body("compensationPeriod")
    .isIn(Object.values(CompensationPeriod))
    .withMessage(
      `compensationPeriod must be one of: ${Object.values(CompensationPeriod).join(", ")}`
    ),
  body("locationState").optional().trim(),
  body("locationCity").optional().trim(),
  body("workMode").isArray({ min: 1 }).withMessage("workMode must be a non-empty array"),
  body("workMode.*")
    .isIn(Object.values(WorkMode))
    .withMessage(`workMode items must be one of: ${Object.values(WorkMode).join(", ")}`),
  body("locationCountry").custom((value, { req }) => {
    const modes = Array.isArray(req.body.workMode) ? req.body.workMode : [];
    if (workModeNeedsLocation(modes) && (!value || String(value).trim() === "")) {
      throw new Error("locationCountry is required for hybrid or on-site jobs");
    }
    return true;
  }),
  body("currency").optional().isString(),
  body("requirements").optional().isString(),
  body("skills").optional().isArray(),
  body("skills.*").optional().isString(),
  body("goals").optional().isArray(),
  body("goals.*").optional().isString(),
];

export const updateJobValidator = [
  param("_id").notEmpty().withMessage("Job ID is required"),
  body("aiConfig").optional().isString(),
  body("jobBrief").optional().isString(),
  body("experienceLevel")
    .optional()
    .isIn(Object.values(ExperienceLevel))
    .withMessage(`experienceLevel must be one of: ${Object.values(ExperienceLevel).join(", ")}`),
  body("status")
    .optional()
    .isIn(Object.values(JobStatus))
    .withMessage(`status must be one of: ${Object.values(JobStatus).join(", ")}`),
  body("maxSalary").optional().isFloat({ min: 0, max: 100000000 }).toFloat(),
  body("minSalary")
    .optional()
    .isFloat({ min: 0, max: 100000000 })
    .toFloat()
    .custom((value, { req }) => {
      if (req.body.maxSalary !== undefined && value >= req.body.maxSalary) {
        throw new Error("minSalary must be less than maxSalary");
      }
      return true;
    }),
  body("compensationPeriod")
    .optional()
    .isIn(Object.values(CompensationPeriod))
    .withMessage(
      `compensationPeriod must be one of: ${Object.values(CompensationPeriod).join(", ")}`
    ),
  body("locationState").optional().trim(),
  body("locationCountry")
    .optional({ values: "falsy" })
    .trim()
    .custom((value, { req }) => {
      const modes = Array.isArray(req.body.workMode) ? req.body.workMode : undefined;
      if (modes && workModeNeedsLocation(modes) && (!value || String(value).trim() === "")) {
        throw new Error("locationCountry is required for hybrid or on-site jobs");
      }
      return true;
    }),
  body("locationCity").optional().trim(),
  body("workMode").optional().isArray({ min: 1 }),
  body("workMode.*")
    .optional()
    .isIn(Object.values(WorkMode))
    .withMessage(`workMode items must be one of: ${Object.values(WorkMode).join(", ")}`),
  body("currency").optional().isString(),
  body("requirements").optional().isString(),
  body("skills").optional().isArray(),
  body("goals").optional().isArray(),
];

export const allJobsQueryValidator = [
  ...paginationRules,
  query("roleId").optional().isString(),
  query("experienceLevel")
    .optional()
    .isIn(Object.values(ExperienceLevel))
    .withMessage("Invalid experienceLevel"),
  query("city").optional().isString(),
  query("state").optional().isString(),
  query("country").optional().isString(),
  query("workMode").optional().isString(),
  query("postedBy").optional().isString(),
  query("q")
    .optional()
    .not()
    .isArray()
    .withMessage("q must be text")
    .isString()
    .withMessage("q must be text")
    .trim()
    .isLength({ max: 100 })
    .withMessage("q must be at most 100 characters"),
];

export const topTalentsValidator = [
  param("jobId").notEmpty().withMessage("Job ID is required"),
  query("percentage").optional().isFloat({ min: 0, max: 100 }).toFloat(),
  query("limit").optional().isInt({ min: 1 }).toInt(),
];

export const matchJobValidator = [
  idParam("_id"),
  query("incomplete").optional().isBoolean().toBoolean(),
];

export const applyValidator = [
  param("jobId").notEmpty().withMessage("Job ID is required"),
  body("source").optional().isString().isLength({ min: 1, max: 50 }),
];

export const retryVerdictsValidator = [
  param("jobId").notEmpty().withMessage("Job ID is required"),
  body("applicationIds").optional().isArray().withMessage("applicationIds must be an array"),
  body("applicationIds.*").optional().isUUID().withMessage("Invalid applicationId"),
];

export const draftApplicantMessagesValidator = [
  param("jobId").notEmpty().withMessage("Job ID is required"),
  body("applicationIds").isArray({ min: 1 }).withMessage("Select at least one candidate"),
  body("applicationIds.*").isUUID().withMessage("Invalid applicationId"),
  body("intent").optional().isString().isLength({ max: 500 }),
];

export const singleFitReportValidator = [
  param("jobId").notEmpty().withMessage("Job ID is required"),
  param("applicationId").isUUID().withMessage("Invalid applicationId"),
];

export const retryCvScoreValidator = [
  param("jobId").notEmpty().withMessage("Job ID is required"),
  param("applicationId").isUUID().withMessage("Invalid applicationId"),
];

export const bulkFitReportValidator = [
  param("jobId").notEmpty().withMessage("Job ID is required"),
  body("applicationIds").isArray({ min: 1 }).withMessage("Select at least one candidate"),
  body("applicationIds.*").isUUID().withMessage("Invalid applicationId"),
];

export const jobApplicationsQueryValidator = [
  param("jobId").notEmpty().withMessage("Job ID is required"),
  query("experience").optional().isString(),
  query("minCvSimilarityScore").optional().isFloat({ min: 0, max: 100 }).toFloat(),
  query("minPersonalizedScore").optional().isFloat({ min: 0, max: 100 }).toFloat(),
  query("minMatchScore").optional().isFloat({ min: 0, max: 100 }).toFloat(),
  query("matchVerdict")
    .optional()
    .isIn(Object.values(MatchVerdict))
    .withMessage("Invalid matchVerdict"),
  query("sort")
    .optional()
    .isIn(["aiMatch", "dateApplied", "cvSimilarity"])
    .withMessage("Invalid sort"),
  query("applicationType")
    .optional()
    .isIn(Object.values(ApplicationType))
    .withMessage("Invalid applicationType"),
  query("applicationStatus")
    .optional()
    .isIn(Object.values(ApplicationStatus))
    .withMessage("Invalid applicationStatus"),
  query("maxSalary").optional().isFloat().toFloat(),
  query("source").optional().isString().isLength({ min: 1, max: 50 }),
  query("offset").optional().isInt({ min: 0 }).toInt(),
  query("skip").optional().isInt({ min: 0 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 200 }).toInt(),
];
