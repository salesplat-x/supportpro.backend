import { Request, Response } from "express";
import * as scoutJobService from "../services/scoutJob.js";
import { sendSuccessResponse } from "../utils/response.js";
import { UserRole } from "../types/enums.js";

export const create = async (req: Request, res: Response) => {
  const result = await scoutJobService.createJob(req.user.id, req.body);
  sendSuccessResponse(res, "Scout job created", { scoutJob: result }, 201);
};

export const update = async (req: Request, res: Response) => {
  const result = await scoutJobService.updateJob(req.user.id, {
    id: req.params["_id"]!,
    ...req.body,
  });
  sendSuccessResponse(res, "Scout job updated", { scoutJob: result });
};

export const fetch = async (req: Request, res: Response) => {
  const result = await scoutJobService.fetchJob(
    req.params["_id"]!,
    req.user.id,
    req.user.userRole === UserRole.Admin
  );
  sendSuccessResponse(res, "Scout job fetched", { scoutJob: result });
};

export const remove = async (req: Request, res: Response) => {
  await scoutJobService.deleteJob(req.user.id, req.params["_id"]!);
  sendSuccessResponse(res, "Scout job deleted", {});
};

export const list = async (req: Request, res: Response) => {
  const result = await scoutJobService.fetchJobs({
    userId: req.user.id,
    limit: req.query["limit"] as string | undefined,
    offset: req.query["offset"] as string | undefined,
  });
  sendSuccessResponse(res, "Scout jobs fetched", { scoutJobs: result });
};
