import { query } from "express-validator";
import { ExperienceLevel, JobStatus } from "../types/enums.js";
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

export const adminJobsQueryValidator = [
  ...paginationRules,
  query("search").optional().trim().isLength({ max: 200 }),
  query("status")
    .optional()
    .isIn(Object.values(JobStatus))
    .withMessage(`status must be one of: ${Object.values(JobStatus).join(", ")}`),
  query("roleId").optional().isUUID().withMessage("roleId must be a valid UUID"),
];

export const adminIdParamValidator = [idParam("_id")];
