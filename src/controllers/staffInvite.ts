import { Request, Response } from "express";
import * as staffInvites from "../services/staffInvite.js";
import { sendSuccessResponse } from "../utils/response.js";

export const preview = async (req: Request, res: Response) => {
  const invite = await staffInvites.previewStaffInvite(req.params["token"]!);
  sendSuccessResponse(res, "Invite fetched", { invite });
};

export const mine = async (req: Request, res: Response) => {
  const invites = await staffInvites.listMyStaffInvites(req.user.id);
  sendSuccessResponse(res, "Invites fetched", { invites });
};

export const acceptMine = async (req: Request, res: Response) => {
  const joined = await staffInvites.acceptMyStaffInvite(req.user.id, req.params["staffId"]!);
  sendSuccessResponse(res, "You've joined the company", { joined });
};

export const accept = async (req: Request, res: Response) => {
  const joined = await staffInvites.acceptStaffInvite(req.user.id, req.params["token"]!);
  sendSuccessResponse(res, "You've joined the company", { joined });
};

export const joinWithPassword = async (req: Request, res: Response) => {
  const { user, token, joined } = await staffInvites.joinWithPassword(
    req.params["token"]!,
    req.body.password
  );
  sendSuccessResponse(res, "You've joined the company", { user, token, joined }, 201);
};
