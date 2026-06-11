import { Request, Response, NextFunction } from "express";
import Joi from "joi";
import { ExperienceLevel } from "../../../typings/customs";
import { WorkMode } from "../../../typings/job";

export const scoutTalents = Joi.object({
  query: Joi.object({
    roleId: Joi.string().required(),
    experience: Joi.string()
      .valid(...Object.values(ExperienceLevel))
      .required(),
    workMode: Joi.string()
      .valid(...Object.values(WorkMode))
      .optional(),
    country: Joi.string(),
    state: Joi.string(),
    city: Joi.string(),

    limit: Joi.number(),
    offset: Joi.number(),
    sort: Joi.string().valid("asc", "desc"),
  }),
  params: Joi.object({
    scoutJobId: Joi.string().required(),
  }),
});

export const getScoutReports = Joi.object({
  params: Joi.object({
    id: Joi.string().required(),
  }),
});

const schema = Joi.object({
  batchId: Joi.string().optional(),
  scoutJobId: Joi.string().required(),
});

export const validateCvAndCoverLetter = (req: Request, res: Response, next: NextFunction) => {
  const { error } = schema.validate(req.body);
  if (error) {
    return res.status(400).json({ error: error.details[0]?.message });
  }

  // Custom validation for files
  //@ts-expect-error - req.files shape from multer fields() is not typed by default
  const cvFile = req.files?.["cv"]?.[0];
  //@ts-expect-error - req.files shape from multer fields() is not typed by default
  const coverLetterFile = req.files?.["coverLetter"]?.[0];

  if (!cvFile || !coverLetterFile) {
    return res.status(400).json({ error: "CV and Cover Letter are required" });
  }

  if (
    (cvFile.mimetype ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      cvFile.mimetype === "application/msword" ||
      cvFile.mimetype === "application/pdf") &&
    (coverLetterFile.mimetype ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      coverLetterFile.mimetype === "application/msword" ||
      coverLetterFile.mimetype === "application/pdf")
  ) {
    return next();
  }

  return res.status(400).json({ error: "Files must be in PDF or Word format" });
};

export const validateCv = (req: Request, res: Response, next: NextFunction) => {
  const { error } = schema.validate(req.body);
  if (error) {
    return res.status(400).json({ error: error.details[0]?.message });
  }

  // Custom validation for files
  const cvFile = req.file;

  if (!cvFile) {
    return res.status(400).json({ error: "CV is required" });
  }

  if (
    cvFile.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    cvFile.mimetype === "application/msword" ||
    cvFile.mimetype === "application/pdf"
  ) {
    return next();
  }

  return res.status(400).json({ error: "File must be in PDF or Word format" });
};
