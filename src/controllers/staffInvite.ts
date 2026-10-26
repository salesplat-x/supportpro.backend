import { Request, Response } from "express";
import * as staffInvites from "../services/staffInvite.js";
import { sendSuccessResponse } from "../utils/response.js";

export const preview = async (req: Request, res: Response) => {
  const invite = await staffInvites.previewStaffInvite(req.params["token"]!);
  sendSuccessResponse(res, "Invite fetched", { invite });
};

export const accept = async (req: Request, res: Response) => {
  const joined = await staffInvites.acceptStaffInvite(req.user.id, req.params["token"]!);
  sendSuccessResponse(res, "You've joined the company", { joined });
};
