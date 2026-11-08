import { Request, Response } from "express";
import * as checkConsent from "../services/checkConsent.js";

export const agree = async (req: Request, res: Response) => {
  const { created, consent } = await checkConsent.agreeToChecks(
    req.user.id,
    req.params["applicationId"]!,
    req.body.version
  );
  res.status(created ? 201 : 200).json({ success: true, data: consent });
};

export const readConsent = async (req: Request, res: Response) => {
  const data = await checkConsent.readConsentForCompany(req.user.id, req.params["applicationId"]!);
  res.status(200).json({ success: true, data });
};
