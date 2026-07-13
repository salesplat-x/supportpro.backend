import { Request, Response } from "express";
import * as paymentService from "../services/payment.js";
import { webhookDataValidation } from "../utils/integrations/paystack.js";
import { sendSuccessResponse } from "../utils/response.js";
import { AuthenticationError } from "../utils/errors";

export const getPaymentLink = async (req: Request, res: Response) => {
  const result = await paymentService.initiateTransaction(req.user, req.body);
  sendSuccessResponse(res, "Payment link generated", result);
};

export const getPaymentRecords = async (req: Request, res: Response) => {
  const result = await paymentService.paymentRecords(req.user.id);
  sendSuccessResponse(res, "Payment history fetched", result);
};

export const verify = async (req: Request, res: Response) => {
  await paymentService.verify(req.body);
  sendSuccessResponse(res, "Verification successful");
};

export const paystackWebhook = async (req: Request, res: Response) => {
  const isValid = webhookDataValidation(req);
  if (!isValid) throw new AuthenticationError("Invalid webhook signature");
  await paymentService.paystackWebhook(req.body);
  res.sendStatus(200);
};
