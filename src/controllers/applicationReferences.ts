import { Request, Response } from "express";
import * as references from "../services/applicationReferences.js";
import * as review from "../services/applicationReferenceReview.js";

export const addReferee = async (req: Request, res: Response) => {
  const data = await references.addReferee(req.user.id, req.params["applicationId"]!, {
    name: req.body.name,
    email: req.body.email,
    relationship: req.body.relationship,
  });
  res.status(201).json({ success: true, data });
};

export const listReferees = async (req: Request, res: Response) => {
  const data = await references.listRefereesForCandidate(req.user.id, req.params["applicationId"]!);
  res.status(200).json({ success: true, data });
};

export const readReferences = async (req: Request, res: Response) => {
  const data = await review.getReferencesForCompany(req.user.id, req.params["applicationId"]!);
  res.status(200).json({ success: true, data });
};

export const resendReference = async (req: Request, res: Response) => {
  const data = await review.resendReference(req.user.id, req.params["referenceId"]!);
  res.status(200).json({ success: true, data });
};
