import { Request, Response } from "express";
import * as applicationChecks from "../services/applicationChecks.js";
import type { CheckType } from "../types/checks.js";

export const orderCheck = async (req: Request, res: Response) => {
  const data = await applicationChecks.orderCheck(
    req.user.id,
    req.params["applicationId"]!,
    req.body.type as CheckType
  );
  res.status(201).json({ success: true, data });
};

export const listChecks = async (req: Request, res: Response) => {
  const data = await applicationChecks.listChecksForCompany(
    req.user.id,
    req.params["applicationId"]!
  );
  res.status(200).json({ success: true, data });
};

export const saveResult = async (req: Request, res: Response) => {
  const data = await applicationChecks.saveCheckResult(
    req.user.id,
    req.params["checkId"]!,
    req.body
  );
  res.status(200).json({ success: true, data });
};

export const history = async (req: Request, res: Response) => {
  const data = await applicationChecks.listCheckHistory(req.user.id, req.params["checkId"]!);
  res.status(200).json({ success: true, data });
};

export const idNumber = async (req: Request, res: Response) => {
  const data = await applicationChecks.readIdNumber(req.user.id, req.params["checkId"]!);
  res.status(200).json({ success: true, data });
};
