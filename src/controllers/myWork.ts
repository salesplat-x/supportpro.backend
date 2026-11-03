import { Request, Response } from "express";
import * as myWork from "../services/myWork.js";
import { getClientIp } from "../utils/clientIp.js";
import { sendSuccessResponse } from "../utils/response.js";

export const overview = async (req: Request, res: Response) => {
  const records = await myWork.getMyWork(req.user.id);
  sendSuccessResponse(res, "My work fetched", { records });
};

export const pay = async (req: Request, res: Response) => {
  const result = await myWork.getMyPay(req.user, req.params["staffId"]!, getClientIp(req));
  sendSuccessResponse(res, "Pay fetched", result);
};

export const setTaskDone = async (req: Request, res: Response) => {
  const task = await myWork.setMyTaskDone(
    req.user.id,
    req.params["taskId"]!,
    req.body.done as boolean
  );
  sendSuccessResponse(res, "Task updated", { task });
};

export const openDocument = async (req: Request, res: Response) => {
  const document = await myWork.openMyDocument(
    req.user,
    req.params["documentId"]!,
    getClientIp(req)
  );
  sendSuccessResponse(res, "Document fetched", { document });
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
