import { Request, Response } from "express";
import * as subscriptionService from "../services/subscription.js";
import { sendSuccessResponse } from "../utils/response.js";

export const fetch = async (req: Request, res: Response) => {
  const result = await subscriptionService.fetchAll();
  sendSuccessResponse(res, "Subscriptions fetched", { subs: result });
};

export const fetchOne = async (req: Request, res: Response) => {
  const result = await subscriptionService.fetchOne(req.params["id"]!);
  sendSuccessResponse(res, "Subscription fetched", { sub: result });
};

export const fetchByMatch = async (req: Request, res: Response) => {
  const result = await subscriptionService.fetchByMatch(req.body);
  sendSuccessResponse(res, "Subscription fetched", { sub: result });
};

export const enable = async (req: Request, res: Response) => {
  await subscriptionService.enable(req.params["id"]!);
  sendSuccessResponse(res, "Subscription enabled");
};

export const disable = async (req: Request, res: Response) => {
  await subscriptionService.disable(req.params["id"]!);
  sendSuccessResponse(res, "Subscription disabled");
};
