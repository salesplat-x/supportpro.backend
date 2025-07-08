import { MakeResponse } from "../typings/customs";
import { Response } from "express";
import { ValidationError } from "joi";

export const makeResponse = <T = Record<string, any>>(
  status: boolean,
  message: string,
  data?: T,
  statusCode?: number
): MakeResponse<T> => {
  return {
    status,
    message,
    data,
    statusCode,
  };
};

export const sendSuccessResponse = (
  res: Response,
  message: string,
  data?: Record<string, any>,
  statusCode: number = 200
): Response => {
  return res.status(statusCode).json({
    status: true,
    message,
    data: data,
  });
};

export const sendErrorResponse = (
  res: Response,
  message: string,
  data: Record<string, any>,
  statusCode: number = 400
): Response => {
  return res.status(statusCode).json({
    status: false,
    message,
  });
};

export const handleValidationError = (
  validateErrorData: ValidationError,
  res: Response
): Response => {
  const message = validateErrorData.details[0]!.message;
  return sendErrorResponse(res, message, {}, 400);
};

// Newly added line as regards to Voice integration for consistent audio streaming
export const sendAudioResponse = (
  res: Response,
  buffer: Buffer,
  filename = "response.mp3"
) => {
  res.set({
    "Content-Type": "audio/mpeg",
    "Content-Disposition": `inline; filename=${filename}`,
    "Content-Length": buffer.length,
  });
  return res.send(buffer);
};
