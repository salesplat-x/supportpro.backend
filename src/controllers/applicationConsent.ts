import { Request, Response } from "express";
import * as checkConsent from "../services/checkConsent.js";

export const agree = async (req: Request, res: Response) => {
  const { created, consent } = await checkConsent.agreeToChecks(
    req.user.id,
    req.params["applicationId"]!,
    {
      version: req.body.version,
      idKind: req.body.idKind,
      idNumber: req.body.idNumber,
    }
  );
  res.status(created ? 201 : 200).json({ success: true, data: consent });
};

export const decline = async (req: Request, res: Response) => {
  const data = await checkConsent.declineChecks(req.user.id, req.params["applicationId"]!);
  res.status(200).json({ success: true, data });
};

export const readMine = async (req: Request, res: Response) => {
  const data = await checkConsent.readConsentForCandidate(
    req.user.id,
    req.params["applicationId"]!
  );
  res.status(200).json({ success: true, data });
};

export const readConsent = async (req: Request, res: Response) => {
  const data = await checkConsent.readConsentForCompany(req.user.id, req.params["applicationId"]!);
  res.status(200).json({ success: true, data });
};

export const requestConsent = async (req: Request, res: Response) => {
  const { created, consent } = await checkConsent.requestConsentForCompany(
    req.user.id,
    req.params["applicationId"]!
  );
  res.status(created ? 201 : 200).json({ success: true, data: consent });
};
