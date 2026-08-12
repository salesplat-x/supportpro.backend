import { body, param, query } from "express-validator";
import { Request, Response, NextFunction } from "express";
import { paginationRules } from "./shared.js";
import { ExperienceLevel, WorkMode } from "../types/enums.js";

const ALLOWED_DOC_MIMETYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

export const MAX_BATCH_SIZE = 15;

export const searchTalentsValidator = [
  query("roleId").optional().isUUID().withMessage("roleId must be a valid UUID"),
  query("experience")
    .optional()
    .isIn(Object.values(ExperienceLevel))
    .withMessage(`experience must be one of: ${Object.values(ExperienceLevel).join(", ")}`),
  query("workMode").optional().isIn(Object.values(WorkMode)).withMessage("Invalid workMode"),
  query("country").optional().isString(),
  query("state").optional().isString(),
  query("city").optional().isString(),
  query("jobId").optional().isUUID().withMessage("jobId must be a valid UUID"),
  query("percentage").optional().isFloat({ min: 0, max: 100 }).toFloat(),
  ...paginationRules,
];

export const scoutBatchIdParamValidator = [
  param("id").isUUID().withMessage("ID must be a valid UUID"),
  ...paginationRules,
];

export const scoutJobScoutsParamValidator = [
  param("id").isUUID().withMessage("Scout job ID must be a valid UUID"),
  ...paginationRules,
];

export const scoutCvBatchValidator = [
  body("scoutJobId").isUUID().withMessage("Scout job ID must be a valid UUID"),
];

export const addScoutToPipelineValidator = [
  param("scoutId").isUUID().withMessage("Scout ID must be a valid UUID"),
  body("jobId").isUUID().withMessage("jobId must be a valid UUID"),
  body("talentEmail").isEmail().withMessage("talentEmail must be a valid email address"),
];

export const validateScoutCvBatchFiles = (req: Request, res: Response, next: NextFunction) => {
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const cvFiles = files?.["cv"] ?? [];
  const coverLetterFiles = files?.["coverLetter"] ?? [];

  if (cvFiles.length === 0) {
    res.status(400).json({ status: false, message: "At least one CV is required" });
    return;
  }
  if (cvFiles.length > MAX_BATCH_SIZE) {
    res
      .status(400)
      .json({ status: false, message: `You can upload at most ${MAX_BATCH_SIZE} CVs at a time` });
    return;
  }
  if (coverLetterFiles.length > 0 && coverLetterFiles.length !== cvFiles.length) {
    res.status(400).json({
      status: false,
      message: "If attaching cover letters, provide one for every CV in the batch",
    });
    return;
  }
  const invalidFile = [...cvFiles, ...coverLetterFiles].find(
    (f) => !ALLOWED_DOC_MIMETYPES.includes(f.mimetype)
  );
  if (invalidFile) {
    res.status(400).json({ status: false, message: "Files must be in PDF or Word format" });
    return;
  }
  next();
};
