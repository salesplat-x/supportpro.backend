import { Request, Response } from "express";
import * as documentCheck from "../services/documentCheck.js";
import { getClientIp } from "../utils/clientIp.js";
import { sendSuccessResponse } from "../utils/response.js";

export const checkCode = async (req: Request, res: Response) => {
  const check = await documentCheck.checkDocumentCode(
    req.body.documentId as string,
    req.body.checkCode as string,
    getClientIp(req)
  );
  sendSuccessResponse(res, "Document checked", { check });
};

export const checkFile = async (req: Request, res: Response) => {
  const check = await documentCheck.checkDocumentFile(req.file, getClientIp(req));
  sendSuccessResponse(res, "Document checked", { check });
};
