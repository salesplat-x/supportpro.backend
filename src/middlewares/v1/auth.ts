import { makeResponse, sendErrorResponse } from "../../helpers/response";
import { Request, Response, NextFunction, RequestHandler } from "express";
import { verifyToken } from "../../helpers/utils";
import env from "../../config/env";
import { findUserAuthById, findProfileById } from "../../repository/v1/user";
import { MakeResponse, Roles } from "../../typings/customs";

export const loginRequired = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<Response | void> => {
  const validated = await checkUser(req, res);
  if (!validated.status) {
    return sendErrorResponse(res, validated.message, 401);
  }
  return next();
};

export const validateAccess = (roles: string[]): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction): Promise<Response | void> => {
    const validated = await checkUser(req, res);
    if (!validated.status) {
      return sendErrorResponse(res, validated.message, 401);
    }
    // emailVerified defaults to true and nothing currently gates on it (see docs/auth-fixes.md)
    if (!roles.includes(req.user.userRole)) {
      return sendErrorResponse(res, "You are not authorized to perform this action", 403);
    }
    return next();
  };
};

export const requireCompletedProfile: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<Response | void> => {
  if (req.user.userRole !== Roles.Talent) {
    return next();
  }
  const profile = req.user.profile
    ? await findProfileById(req.user.profile as string)
    : null;
  if (!profile?.canProceedToPlatform) {
    return sendErrorResponse(res, "Please complete your profile before proceeding", 403);
  }
  return next();
};

const checkUser = async (req: Request, _res: Response): Promise<MakeResponse> => {
  const token = req.headers.authorization;
  if (!token) {
    return makeResponse(false, "LOGIN_REQUIRED");
  }
  if (!token.split(" ")[1]) {
    return makeResponse(false, "LOGIN_REQUIRED");
  }
  const verified = await verifyToken(token.split(" ")[1]!, env.jwt_secret!, findUserAuthById);
  if (!verified.status || !verified.data) {
    return makeResponse(false, verified.message, {}, verified.statusCode || 401);
  }
  req.user = verified.data;
  return makeResponse(true, "");
};
