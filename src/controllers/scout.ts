import { Request, Response } from "express";
import * as scoutService from "../services/scout.js";
import { sendSuccessResponse } from "../utils/response.js";

export const scoutTalents = async (req: Request, res: Response) => {
  const result = await scoutService.scoutTalents({
    scoutJobId: req.params["scoutJobId"]!,
    roleId: req.query["roleId"] as string | undefined,
    experience: req.query["experience"] as string | undefined,
    workMode: req.query["workMode"] as string | undefined,
    country: req.query["country"] as string | undefined,
    state: req.query["state"] as string | undefined,
    city: req.query["city"] as string | undefined,
    limit: req.query["limit"] ? Number(req.query["limit"]) : undefined,
    offset: req.query["offset"] ? Number(req.query["offset"]) : undefined,
  });
  sendSuccessResponse(res, "Talents scouted", { talents: result });
};

export const fetchScoutReports = async (req: Request, res: Response) => {
  const result = await scoutService.fetchScoutReports(req.params["id"]);
  sendSuccessResponse(res, "Scout reports fetched", { scoutReports: result });
};

export const fetchScoutReport = async (req: Request, res: Response) => {
  const result = await scoutService.fetchScoutReport(req.params["id"]!);
  sendSuccessResponse(res, "Scout report fetched", { scoutReport: result });
};

export const scoutCvAndCl = async (req: Request, res: Response) => {
  const result = await scoutService.scoutCvAndCl(req.user.id, {
    scoutJobId: req.body.scoutJobId,
    batchId: req.body.batchId,
    files: req.files as Record<string, Express.Multer.File[]>,
  });
  sendSuccessResponse(res, "CV and cover letter assessed", result);
};

export const scoutCv = async (req: Request, res: Response) => {
  const result = await scoutService.scoutCv(req.user.id, {
    scoutJobId: req.body.scoutJobId,
    batchId: req.body.batchId,
    file: req.file as Express.Multer.File,
  });
  sendSuccessResponse(res, "CV assessed", result);
};
