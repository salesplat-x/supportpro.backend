import { Response } from "express";

export interface ApiResponse<T = unknown> {
  status: boolean;
  message: string;
  data?: T;
}

export const sendSuccessResponse = <T = unknown>(
  res: Response,
  message: string,
  data?: T,
  statusCode = 200
): Response => {
  return res.status(statusCode).json({ status: true, message, data });
};

export const sendErrorResponse = (res: Response, message: string, statusCode = 400): Response => {
  return res.status(statusCode).json({ status: false, message });
};
