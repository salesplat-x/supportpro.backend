import { query } from "express-validator";
import { ExperienceLevel, JobStatus, OrganizationStatus } from "../types/enums.js";
import { idParam, paginationRules } from "./shared.js";

export const adminTalentsQueryValidator = [
  ...paginationRules,
  query("search").optional().trim().isLength({ max: 200 }),
  query("experience")
    .optional()
    .isIn(Object.values(ExperienceLevel))
    .withMessage(`experience must be one of: ${Object.values(ExperienceLevel).join(", ")}`),
  query("roleId").optional().isUUID().withMessage("roleId must be a valid UUID"),
];

export const adminRecruitersQueryValidator = [
  ...paginationRules,
  query("search").optional().trim().isLength({ max: 200 }),
];

export const adminJobsQueryValidator = [
  ...paginationRules,
  query("search").optional().trim().isLength({ max: 200 }),
  query("status")
    .optional()
    .isIn(Object.values(JobStatus))
    .withMessage(`status must be one of: ${Object.values(JobStatus).join(", ")}`),
  query("roleId").optional().isUUID().withMessage("roleId must be a valid UUID"),
  query("organizationId").optional().isUUID().withMessage("organizationId must be a valid UUID"),
];

export const adminIdParamValidator = [idParam("_id")];

export const adminOrganizationsQueryValidator = [
  ...paginationRules,
  query("search").optional().trim().isLength({ max: 200 }),
  query("status")
    .optional()
    .isIn(Object.values(OrganizationStatus))
    .withMessage(`status must be one of: ${Object.values(OrganizationStatus).join(", ")}`),
];
