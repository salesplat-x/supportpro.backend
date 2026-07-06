import { Request, Response } from "express";
import * as scoutJobService from "../services/scoutJob.js";
import { sendSuccessResponse } from "../utils/response.js";

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
  const result = await scoutJobService.fetchJob(req.params["_id"]!);
  sendSuccessResponse(res, "Scout job fetched", { scoutJob: result });
};
