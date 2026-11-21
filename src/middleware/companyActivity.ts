import type { NextFunction, Request, Response } from "express";
import { WRITE_METHODS, recordCompanyActivity } from "../services/companyActivity.js";

export const companyActivityLogger = (req: Request, res: Response, next: NextFunction): void => {
  if (WRITE_METHODS.has(req.method)) {
    res.on("finish", () => recordCompanyActivity(req, res));
  }
  next();
};
