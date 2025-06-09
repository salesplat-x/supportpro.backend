import { Response, Request } from "express";
import * as logic from "../../logics/v1/payment";
import { responseHandler } from "../../middlewares/v1/handler";
import { webhookDataValidation } from "../../services/v1/paystack";
import { makeResponse } from "../../helpers/response";

export const getPaymentLink = async (req: Request, res: Response) => {
    const response = await logic.initiateTransaction(req.user, req.body);
    return responseHandler(res, response);
};

export const verify = async (req: Request, res: Response) => {
    const response = await logic.verify(req.params as any);
    return responseHandler(res, response);
};

export const paystackWebhook = async (req: Request, res: Response) => {
    const status = webhookDataValidation(req);
    if (!status) {
        return responseHandler(res, makeResponse(status, "", {}, 401));
    }
    const response = await logic.paystackWebhook(req.body);
    //return responseHandler(res, response);
    res.sendStatus(200);
};