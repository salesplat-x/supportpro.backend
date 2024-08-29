import { Request, Response, NextFunction } from "express";
import Joi from "joi";

const schema = Joi.object({
  batchId: Joi.string().optional(),
  talentName: Joi.string().required(),
  recruiterGuide: Joi.string().optional(),
  jobId: Joi.string().required(),
});

export const validateCvAndCoverLetter = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { error } = schema.validate(req.body);
  if (error) {
    return res.status(400).json({ error: error.details[0]?.message });
  }

  // Custom validation for files
  //@ts-ignore
  const cvFile = req.files?.["cv"]?.[0];
  //@ts-ignore
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
