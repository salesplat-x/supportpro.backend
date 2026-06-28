import { body, query, param } from "express-validator";
import { paginationRules, idParam } from "./shared.js";
import { ExperienceLevel, WorkMode, JobStatus, ApplicationType, ApplicationStatus } from "../types/enums.js";

export const createJobValidator = [
  body("role").notEmpty().trim().withMessage("Role is required"),
  body("aiConfig").optional().isString(),
  body("jobBrief").notEmpty().withMessage("Job brief is required"),
  body("experienceLevel")
    .isIn(Object.values(ExperienceLevel))
    .withMessage(`experienceLevel must be one of: ${Object.values(ExperienceLevel).join(", ")}`),
  body("maxSalary").isFloat({ min: 0, max: 100000000 }).toFloat().withMessage("Valid maxSalary required"),
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
  body("location").optional().isObject(),
  body("location.city").optional().trim(),
  body("location.state").optional().trim(),
  body("location.country").optional().trim(),
  body("workMode")
    .isArray({ min: 1 })
    .withMessage("workMode must be a non-empty array"),
  body("workMode.*")
    .isIn(Object.values(WorkMode))
    .withMessage(`workMode items must be one of: ${Object.values(WorkMode).join(", ")}`),
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
  body("location").optional().isObject(),
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

export const applyValidator = [param("jobId").notEmpty().withMessage("Job ID is required")];

export const jobApplicationsQueryValidator = [
  param("jobId").notEmpty().withMessage("Job ID is required"),
  query("experience").optional().isString(),
  query("minCvSimilarityScore").optional().isFloat({ min: 0, max: 100 }).toFloat(),
  query("minPersonalizedScore").optional().isFloat({ min: 0, max: 100 }).toFloat(),
  query("applicationType")
    .optional()
    .isIn(Object.values(ApplicationType))
    .withMessage("Invalid applicationType"),
  query("applicationStatus")
    .optional()
    .isIn(Object.values(ApplicationStatus))
    .withMessage("Invalid applicationStatus"),
  query("maxSalary").optional().isFloat().toFloat(),
  query("offset").optional().isInt({ min: 0 }).toInt(),
  query("skip").optional().isInt({ min: 0 }).toInt(),
];
