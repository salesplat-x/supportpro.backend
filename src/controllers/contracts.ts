import { Request, Response } from "express";
import type { DocumentTemplate } from "../entities/StaffDocument.js";
import * as contracts from "../services/contracts.js";
import { getClientIp } from "../utils/clientIp.js";
import { sendSuccessResponse } from "../utils/response.js";

const orgId = (req: Request) => req.params["_id"]!;
const staffId = (req: Request) => req.params["staffId"]!;
const documentId = (req: Request) => req.params["documentId"]!;

export const sendPdf = (res: Response, fileName: string, pdf: Buffer) => {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.setHeader("Content-Length", String(pdf.length));
  res.send(pdf);
};

export const list = async (req: Request, res: Response) => {
  const documents = await contracts.listDocuments(
    req.user,
    orgId(req),
    staffId(req),
    getClientIp(req)
  );
  sendSuccessResponse(res, "Documents fetched", { documents });
};

export const preview = async (req: Request, res: Response) => {
  const preview = await contracts.previewDocument(
    req.user,
    orgId(req),
    staffId(req),
    req.query["template"] as DocumentTemplate,
    getClientIp(req)
  );
  sendSuccessResponse(res, "Document preview ready", { preview });
};

export const send = async (req: Request, res: Response) => {
  const result = await contracts.sendDocument(
    req.user,
    orgId(req),
    staffId(req),
    req.body.template as DocumentTemplate
  );
  sendSuccessResponse(res, "Document sent for signing", result, 201);
};

export const resend = async (req: Request, res: Response) => {
  const result = await contracts.resendDocument(
    req.user,
    orgId(req),
    staffId(req),
    documentId(req)
  );
  sendSuccessResponse(res, "Document sent again", result);
};

export const download = async (req: Request, res: Response) => {
  const { fileName, pdf } = await contracts.downloadDocument(
    req.user,
    orgId(req),
    staffId(req),
    documentId(req),
    getClientIp(req)
  );
  sendPdf(res, fileName, pdf);
};

export const openLink = async (req: Request, res: Response) => {
  const document = await contracts.openSigningLink(req.params["token"]!, getClientIp(req));
  sendSuccessResponse(res, "Document fetched", { document });
};

export const signWithLink = async (req: Request, res: Response) => {
  const signed = await contracts.signWithToken(
    req.params["token"]!,
    req.body.fullName as string,
    getClientIp(req)
  );
  sendSuccessResponse(res, "Document signed", { signed });
};

export const retryFinalization = async (req: Request, res: Response) => {
  const document = await contracts.retryFinalization(
    req.user,
    orgId(req),
    staffId(req),
    documentId(req)
  );
  sendSuccessResponse(res, "Tried finishing the signed copy again", { document });
};

export const setNotarization = async (req: Request, res: Response) => {
  const document = await contracts.setNeedsNotarization(
    req.user,
    orgId(req),
    staffId(req),
    documentId(req),
    req.body.needsNotarization as boolean
  );
  sendSuccessResponse(res, "Document updated", { document });
};

export const uploadNotarizedScan = async (req: Request, res: Response) => {
  const document = await contracts.uploadNotarizedScan(
    req.user,
    orgId(req),
    staffId(req),
    documentId(req),
    req.file
  );
  sendSuccessResponse(res, "Notarized copy attached", { document });
};

export const downloadNotarizedScan = async (req: Request, res: Response) => {
  const { fileName, contentType, file } = await contracts.downloadNotarizedScan(
    req.user,
    orgId(req),
    staffId(req),
    documentId(req),
    getClientIp(req)
  );
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.setHeader("Content-Length", String(file.length));
  res.send(file);
};
