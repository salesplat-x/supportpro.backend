import { Request, Response } from "express";
import { loadPricingCatalog } from "../config/pricingCatalog.js";
import { sendSuccessResponse } from "../utils/response.js";

export const getPricingCatalog = async (_req: Request, res: Response) => {
  sendSuccessResponse(res, "Pricing catalog fetched", loadPricingCatalog());
};
