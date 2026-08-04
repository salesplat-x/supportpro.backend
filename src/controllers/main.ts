import { Request, Response } from "express";
import { sendSuccessResponse } from "../utils/response.js";

export const baseEndpoint = (_req: Request, res: Response) => {
  sendSuccessResponse(res, "Welcome to Auxhr API v1");
};
