import { body, param } from "express-validator";
import { idParam } from "./shared.js";

export const createScoutJobValidator = [
  body("role").notEmpty().trim().withMessage("Role is required"),
  body("jobBrief").notEmpty().withMessage("Job brief is required"),
  body("name").notEmpty().withMessage("Name is required"),
  body("recruiterGuide").notEmpty().withMessage("Recruiter guide is required"),
];

export const updateScoutJobValidator = [
  param("_id").notEmpty().withMessage("Scout job ID is required"),
  body("role").optional().trim(),
  body("jobBrief").optional().isString(),
  body("name").optional().isString(),
  body("recruiterGuide").optional().isString(),
];

export const scoutJobIdParamValidator = [idParam("_id")];
