import { Request, Response } from "express";
import * as scoutService from "../services/scout.js";
import { sendSuccessResponse } from "../utils/response.js";
import { UserRole } from "../types/enums.js";

const isAdmin = (req: Request) => req.user.userRole === UserRole.Admin;

export const searchTalents = async (req: Request, res: Response) => {
  const result = await scoutService.searchTalents({
    roleId: req.query["roleId"] as string | undefined,
    experience: req.query["experience"] as string | undefined,
    workMode: req.query["workMode"] as string | undefined,
    country: req.query["country"] as string | undefined,
    state: req.query["state"] as string | undefined,
    city: req.query["city"] as string | undefined,
    limit: req.query["limit"] ? Number(req.query["limit"]) : undefined,
    offset: req.query["offset"] ? Number(req.query["offset"]) : undefined,
  });
  sendSuccessResponse(res, "Talents found", { talents: result });
};

export const fetchScoutReports = async (req: Request, res: Response) => {
  const result = await scoutService.fetchScoutReports({
    batchId: req.params["id"],
    userId: req.user.id,
    isAdmin: isAdmin(req),
    limit: req.query["limit"] as string | undefined,
    offset: req.query["offset"] as string | undefined,
  });
  sendSuccessResponse(res, "Scout reports fetched", { scoutReports: result });
};

export const fetchScoutReportsByJob = async (req: Request, res: Response) => {
  const result = await scoutService.fetchScoutReports({
    scoutJobId: req.params["id"],
    userId: req.user.id,
    isAdmin: isAdmin(req),
    limit: req.query["limit"] as string | undefined,
    offset: req.query["offset"] as string | undefined,
  });
  sendSuccessResponse(res, "Scout reports fetched", { scoutReports: result });
};

export const fetchScoutReport = async (req: Request, res: Response) => {
  const result = await scoutService.fetchScoutReport(req.params["id"]!, req.user.id, isAdmin(req));
  sendSuccessResponse(res, "Scout report fetched", { scoutReport: result });
};

export const scoutCvBatch = async (req: Request, res: Response) => {
  const files = req.files as Record<string, Express.Multer.File[]>;
  const result = await scoutService.scoutCvBatch(req.user.id, {
    scoutJobId: req.body.scoutJobId,
    cvFiles: files["cv"]!,
    coverLetterFiles: files["coverLetter"],
  });
  sendSuccessResponse(res, "CV batch scored", result);
};
