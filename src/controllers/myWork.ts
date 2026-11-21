import { Request, Response } from "express";
import * as completion from "../services/completionRequests.js";
import * as myWork from "../services/myWork.js";
import { getClientIp } from "../utils/clientIp.js";
import { sendSuccessResponse } from "../utils/response.js";
import { sendPdf } from "./contracts.js";
import { sendEvidence } from "./performance.js";

export const overview = async (req: Request, res: Response) => {
  const records = await myWork.getMyWork(req.user.id);
  sendSuccessResponse(res, "My work fetched", { records });
};

export const pay = async (req: Request, res: Response) => {
  const result = await myWork.getMyPay(req.user, req.params["staffId"]!, getClientIp(req));
  sendSuccessResponse(res, "Pay fetched", result);
};

const asList = (value: unknown): string[] =>
  value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(String);

export const submitCompletion = async (req: Request, res: Response) => {
  const request = await completion.submitCompletionRequest(
    req.user,
    req.params["staffId"]!,
    {
      itemType: req.body.itemType as completion.CompletionItemType,
      itemId: req.body.itemId as string,
      summary: req.body.summary as string,
      links: asList(req.body.links),
    },
    (req.files as Express.Multer.File[] | undefined) ?? []
  );
  sendSuccessResponse(res, "Sent for review", { request }, 201);
};

export const withdrawCompletion = async (req: Request, res: Response) => {
  await completion.withdrawCompletionRequest(
    req.user,
    req.params["staffId"]!,
    req.params["requestId"]!
  );
  sendSuccessResponse(res, "Request withdrawn");
};

export const evidenceFile = async (req: Request, res: Response) => {
  sendEvidence(
    res,
    await completion.downloadMyEvidence(
      req.user,
      req.params["staffId"]!,
      req.params["requestId"]!,
      req.params["fileId"]!,
      getClientIp(req)
    )
  );
};

export const openDocument = async (req: Request, res: Response) => {
  const document = await myWork.openMyDocument(
    req.user,
    req.params["documentId"]!,
    getClientIp(req)
  );
  sendSuccessResponse(res, "Document fetched", { document });
};

export const downloadDocument = async (req: Request, res: Response) => {
  const { fileName, pdf } = await myWork.downloadMySignedDocument(
    req.user,
    req.params["documentId"]!,
    getClientIp(req)
  );
  sendPdf(res, fileName, pdf);
};

export const declineDocument = async (req: Request, res: Response) => {
  await myWork.declineMyDocument(req.user.id, req.params["documentId"]!, getClientIp(req));
  sendSuccessResponse(res, "Document declined", {});
};

export const signDocument = async (req: Request, res: Response) => {
  const signed = await myWork.signMyDocument(
    req.user.id,
    req.params["documentId"]!,
    req.body.fullName as string,
    getClientIp(req)
  );
  sendSuccessResponse(res, "Document signed", { signed });
};
