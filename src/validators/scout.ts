import { param, query } from "express-validator";
import { Request, Response, NextFunction } from "express";
import { paginationRules } from "./shared.js";
import { ExperienceLevel, WorkMode } from "../types/enums.js";

const ALLOWED_DOC_MIMETYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

export const scoutTalentsValidator = [
  param("scoutJobId").notEmpty().withMessage("Scout job ID is required"),
  query("roleId").notEmpty().withMessage("roleId is required"),
  query("experience")
    .isIn(Object.values(ExperienceLevel))
    .withMessage(`experience must be one of: ${Object.values(ExperienceLevel).join(", ")}`),
  query("workMode").optional().isIn(Object.values(WorkMode)).withMessage("Invalid workMode"),
  query("country").optional().isString(),
  query("state").optional().isString(),
  query("city").optional().isString(),
  ...paginationRules,
];

export const scoutBatchIdParamValidator = [param("id").notEmpty().withMessage("ID is required")];

export const validateCvAndCoverLetter = (req: Request, res: Response, next: NextFunction) => {
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const cvFile = files?.["cv"]?.[0];
  const coverLetterFile = files?.["coverLetter"]?.[0];
  if (!cvFile || !coverLetterFile) {
    res.status(400).json({ status: false, message: "CV and Cover Letter are required" });
    return;
  }
  if (
    !ALLOWED_DOC_MIMETYPES.includes(cvFile.mimetype) ||
    !ALLOWED_DOC_MIMETYPES.includes(coverLetterFile.mimetype)
  ) {
    res.status(400).json({ status: false, message: "Files must be in PDF or Word format" });
    return;
  }
  next();
};

export const validateCv = (req: Request, res: Response, next: NextFunction) => {
  const cvFile = req.file;
  if (!cvFile) {
    res.status(400).json({ status: false, message: "CV is required" });
    return;
  }
  if (!ALLOWED_DOC_MIMETYPES.includes(cvFile.mimetype)) {
    res.status(400).json({ status: false, message: "File must be in PDF or Word format" });
    return;
  }
  next();
};
