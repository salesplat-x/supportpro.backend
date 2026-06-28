import { Request, Response } from "express";
import * as aiConfigService from "../services/aiConfig.js";
import { sendSuccessResponse } from "../utils/response.js";

export const createAIConfig = async (req: Request, res: Response) => {
  const result = await aiConfigService.createAIConfig(req.user.id, req.body);
  sendSuccessResponse(res, "AI Config created", { aiConfig: result }, 201);
};

export const update = async (req: Request, res: Response) => {
  const result = await aiConfigService.updateAIConfig(req.user.id, req.user.userRole, req.params["_id"]!, req.body);
  sendSuccessResponse(res, "AI Config updated", { aiConfig: result });
};

export const allAIConfig = async (req: Request, res: Response) => {
  const result = await aiConfigService.allAIConfig(req.user.id);
  sendSuccessResponse(res, "AI Configs fetched", { aiConfigs: result });
};

export const fetchAIConfig = async (req: Request, res: Response) => {
  const result = await aiConfigService.fetchAIConfig(req.user.id, req.params["_id"]!);
  sendSuccessResponse(res, "AI Config fetched", { aiConfig: result });
};

export const deleteAIConfig = async (req: Request, res: Response) => {
  await aiConfigService.deleteAIConfig(req.user.id, req.params["_id"]!);
  sendSuccessResponse(res, "AI Config deleted");
};
