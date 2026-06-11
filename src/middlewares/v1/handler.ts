import { Response, Request, NextFunction } from "express";
import logger from "../../config/logger";
import { sendErrorResponse, sendSuccessResponse } from "../../helpers/response";
import { MakeResponse } from "../../typings/customs";
import errorLogger from "../../services/errorLogger";
import { AxiosError } from "axios";

export const asyncHandler = (cb: Function) => async (req: Request, res: Response) => {
  try {
    await cb(req, res);
  } catch (error: any) {
    let metadata = {};
    if (error instanceof AxiosError) {
      metadata = error.response?.data;
    }
    const requestId = await errorLogger.logError(error, req, res, {
      tags: ["async-handler"],
      metadata,
    });

    return res.status(500).json({
      status: false,
      error: "Something Went Wrong, Please Try Again Later",
      requestId,
    });
  }
};

export const responseHandler = async (res: Response, response: MakeResponse) => {
  if (response.status) {
    return sendSuccessResponse(res, response.message, response.data, response.statusCode);
  }
  return sendErrorResponse(res, response.message, {}, response.statusCode || 400);
};
