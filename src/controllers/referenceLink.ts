import { Request, Response } from "express";
import * as answers from "../services/applicationReferenceAnswers.js";

export const openLink = async (req: Request, res: Response) => {
  const data = await answers.openReferenceLink(req.params["token"]!);
  res.status(200).json({ success: true, data });
};

export const submitAnswers = async (req: Request, res: Response) => {
  const data = await answers.submitReferenceAnswers(req.params["token"]!, req.body?.answers);
  res.status(200).json({ success: true, data });
};
