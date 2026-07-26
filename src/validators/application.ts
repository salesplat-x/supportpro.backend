import { body, param, query } from "express-validator";
import { paginationRules, idParam } from "./shared.js";
import { ApplicationStatus, ApplicationType, ExperienceLevel } from "../types/enums.js";

export const getApplicationsQueryValidator = [
  ...paginationRules,
  query("roleId").optional().isString(),
  query("experienceLevel")
    .optional()
    .isIn(Object.values(ExperienceLevel))
    .withMessage("Invalid experienceLevel"),
  query("job").optional().isString(),
  query("applicationType")
    .optional()
    .isIn(Object.values(ApplicationType))
    .withMessage("Invalid applicationType"),
  query("applicationStatus")
    .optional()
    .isIn(Object.values(ApplicationStatus))
    .withMessage("Invalid applicationStatus"),
];

export const applicationIdParamValidator = [idParam("_id")];

export const updateApplicationStatusValidator = [
  param("_id").notEmpty().withMessage("Application ID is required"),
  body("status")
    .isIn([ApplicationStatus.Rejected, ApplicationStatus.Shortlisted])
    .withMessage(
      `status must be one of: ${ApplicationStatus.Rejected}, ${ApplicationStatus.Shortlisted}`
    ),
];

export const bulkUpdateApplicationStatusValidator = [
  body("applicationIds")
    .isArray({ min: 1 })
    .withMessage("applicationIds must be a non-empty array"),
  body("applicationIds.*").isString(),
  body("status")
    .isIn([ApplicationStatus.Rejected, ApplicationStatus.Shortlisted])
    .withMessage(
      `status must be one of: ${ApplicationStatus.Rejected}, ${ApplicationStatus.Shortlisted}`
    ),
];
