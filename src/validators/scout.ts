import { body, param, query } from "express-validator";
import { Request, Response, NextFunction } from "express";
import { paginationRules } from "./shared.js";
import { ExperienceLevel, WorkMode } from "../types/enums.js";
import { MAX_BATCH_SIZE } from "../config/scout.js";
import { ValidationError } from "../utils/errors";

const ALLOWED_DOC_MIMETYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

export { MAX_BATCH_SIZE };

export const searchTalentsValidator = [
  body("description")
    .isString()
    .trim()
    .isLength({ min: 20, max: 2000 })
    .withMessage("Describe who you're looking for in between 20 and 2000 characters"),
  body("roleId").optional({ values: "null" }).isUUID().withMessage("roleId must be a valid UUID"),
  body("experienceLevel")
    .optional({ values: "null" })
    .isIn(Object.values(ExperienceLevel))
    .withMessage(`experienceLevel must be one of: ${Object.values(ExperienceLevel).join(", ")}`),
  body("workMode")
    .optional({ values: "null" })
    .isIn(Object.values(WorkMode))
    .withMessage(`workMode must be one of: ${Object.values(WorkMode).join(", ")}`),
  body("country").optional({ values: "null" }).isString().trim(),
  body("state").optional({ values: "null" }).isString().trim(),
  body("city").optional({ values: "null" }).isString().trim(),
  body("limit").optional().isInt({ min: 1, max: 50 }).toInt(),
  body("offset").optional().isInt({ min: 0 }).toInt(),
];

export const scoutJobScoutsParamValidator = [
  param("id").isUUID().withMessage("Scout job ID must be a valid UUID"),
  ...paginationRules,
];

export const scoutRunIdParamValidator = [
  param("runId").isUUID().withMessage("Run ID must be a valid UUID"),
];

export const scoutIdParamValidator = [
  param("scoutId").isUUID().withMessage("Scout ID must be a valid UUID"),
];

export const scoutCandidateIdParamValidator = [
  param("candidateId").isUUID().withMessage("Candidate ID must be a valid UUID"),
];

export const startScoutRunValidator = [
  param("id").isUUID().withMessage("Scout campaign ID must be a valid UUID"),
  body("idempotencyKey")
    .isString()
    .trim()
    .isLength({ min: 8, max: 100 })
    .withMessage("idempotencyKey is required so a retried upload can't start a second run"),
];

export const runsListQueryValidator = [
  param("id").isUUID().withMessage("Scout campaign ID must be a valid UUID"),
  ...paginationRules,
];

export const addScoutToPipelineValidator = [
  param("scoutId").isUUID().withMessage("Scout ID must be a valid UUID"),
  body("jobId").isUUID().withMessage("jobId must be a valid UUID"),
  body("talentEmail").isEmail().withMessage("talentEmail must be a valid email address"),
];

export const messageCandidateValidator = [
  param("candidateId").isUUID().withMessage("Candidate ID must be a valid UUID"),
  body("content")
    .isString()
    .trim()
    .isLength({ min: 1, max: 5000 })
    .withMessage("A message is required"),
];

/**
 * File-level checks multer can't express. Throws so the shared error handler shapes
 * the response — the previous version wrote `{ status, message }` straight to `res`,
 * which bypassed the handler and produced a different envelope from every other
 * validation failure on the API.
 */
export const validateScoutCvFiles = (req: Request, _res: Response, next: NextFunction) => {
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const cvFiles = files?.["cv"] ?? [];

  if (cvFiles.length === 0) {
    throw new ValidationError("Add at least one CV to start scouting");
  }
  if (cvFiles.length > MAX_BATCH_SIZE) {
    throw new ValidationError(`You can upload at most ${MAX_BATCH_SIZE} CVs at a time`);
  }
  const invalidFile = cvFiles.find((file) => !ALLOWED_DOC_MIMETYPES.includes(file.mimetype));
  if (invalidFile) {
    throw new ValidationError(
      `${invalidFile.originalname} isn't a PDF or Word file. Upload CVs as PDF, DOC or DOCX.`
    );
  }
  next();
};

export const talentSearchQueryValidator = [
  query("limit").optional().isInt({ min: 1, max: 50 }).toInt(),
  query("offset").optional().isInt({ min: 0 }).toInt(),
];
