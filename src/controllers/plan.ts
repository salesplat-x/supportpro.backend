import { Request, Response } from "express";
import * as planService from "../services/plan.js";
import { sendSuccessResponse } from "../utils/response.js";

export const create = async (req: Request, res: Response) => {
  const result = await planService.create(req.body);
  sendSuccessResponse(res, "Plan added successfully", { plan: result }, 201);
};

export const fetch = async (req: Request, res: Response) => {
  const result = await planService.fetch(req.query);
  sendSuccessResponse(res, "Plans fetched successfully", { plans: result });
};

export const fetchOne = async (req: Request, res: Response) => {
  const result = await planService.fetchOne(req.params["id"]!);
  sendSuccessResponse(res, "Plan fetched successfully", { plan: result });
};

export const update = async (req: Request, res: Response) => {
  const result = await planService.update(req.params["_id"]!, req.body);
  sendSuccessResponse(res, "Plan updated successfully", { plan: result });
};

export const deleteItem = async (req: Request, res: Response) => {
  await planService.deleteItem(req.params["id"]!);
  sendSuccessResponse(res, "Plan deleted successfully");
};
