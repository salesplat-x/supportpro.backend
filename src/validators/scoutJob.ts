import { body, param } from "express-validator";
import { paginationRules } from "./shared.js";

export const createScoutJobValidator = [
  body("role").notEmpty().isUUID().withMessage("A valid role is required"),
  body("jobBrief").notEmpty().withMessage("Job brief is required"),
  body("name").notEmpty().withMessage("Name is required"),
  body("recruiterGuide").notEmpty().withMessage("Recruiter guide is required"),
];

export const updateScoutJobValidator = [
  param("_id").isUUID().withMessage("Scout job ID must be a valid UUID"),
  body("role").optional().isUUID().withMessage("role must be a valid UUID"),
  body("jobBrief").optional().isString(),
  body("name").optional().isString(),
  body("recruiterGuide").optional().isString(),
];

export const scoutJobIdParamValidator = [
  param("_id").isUUID().withMessage("Scout job ID must be a valid UUID"),
];

export const scoutJobsListQueryValidator = [...paginationRules];
