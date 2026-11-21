import { Request, Response } from "express";
import { listCompanyActivity } from "../services/companyActivity.js";
import { sendSuccessResponse } from "../utils/response.js";

const DEFAULT_LIMIT = 25;

const text = (req: Request, key: string) => {
  const value = req.query[key];
  return typeof value === "string" && value ? value : undefined;
};

export const list = async (req: Request, res: Response) => {
  const result = await listCompanyActivity(req.user.id, req.params["_id"]!, {
    actorId: text(req, "actorId"),
    search: text(req, "search"),
    from: text(req, "from"),
    to: text(req, "to"),
    limit: Number(req.query["limit"] ?? DEFAULT_LIMIT),
    offset: Number(req.query["offset"] ?? 0),
  });
  sendSuccessResponse(res, "Company activity fetched", result);
};
