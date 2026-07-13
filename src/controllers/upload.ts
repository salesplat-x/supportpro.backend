import { Request, Response } from "express";
import * as uploadService from "../services/upload.js";
import { ValidationError } from "../utils/errors";
import { sendSuccessResponse } from "../utils/response.js";

export const uploadCloudinary = async (req: Request, res: Response) => {
  const result = await uploadService.uploadCloudinary(req.file);
  sendSuccessResponse(res, "File uploaded", result);
};

export const uploadLocal = async (req: Request, res: Response) => {
  if (!req.file) throw new ValidationError("No file uploaded");
  sendSuccessResponse(res, "File uploaded locally", {
    filename: req.file.filename,
    path: req.file.path,
  });
};
