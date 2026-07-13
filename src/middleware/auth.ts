import { Request, Response, NextFunction, RequestHandler } from "express";
import { AppDataSource } from "../database/dataSource.js";
import { User } from "../entities";
import { UserRole } from "../types/enums.js";
import { decodeToken, JwtPayload } from "../utils/crypto.js";
import { asyncHandler } from "./asyncHandler.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user: User;
    }
  }
}

async function resolveUser(req: Request, res: Response): Promise<User | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res
      .status(401)
      .json({ success: false, error: { code: "AUTHENTICATION_ERROR", message: "Login required" } });
    return null;
  }
  const token = authHeader.split(" ")[1];
  if (!token) {
    res
      .status(401)
      .json({ success: false, error: { code: "AUTHENTICATION_ERROR", message: "Login required" } });
    return null;
  }
  try {
    const payload = decodeToken(token);
    const user = await AppDataSource.getRepository(User)
      .createQueryBuilder("user")
      .leftJoinAndSelect("user.userRoles", "userRoles")
      .where("user.id = :id", { id: payload.id })
      .getOne();

    if (!user) {
      res.status(401).json({
        success: false,
        error: { code: "AUTHENTICATION_ERROR", message: "Login required" },
      });
      return null;
    }
    if (!user.active) {
      res.status(403).json({
        success: false,
        error: {
          code: "AUTHORIZATION_ERROR",
          message: "Account deactivated, contact support to reactivate",
        },
      });
      return null;
    }
    if (user.tokenVersion !== payload.tokenVersion) {
      res.status(401).json({
        success: false,
        error: { code: "AUTHENTICATION_ERROR", message: "Login required" },
      });
      return null;
    }
    return user;
  } catch {
    res
      .status(401)
      .json({ success: false, error: { code: "AUTHENTICATION_ERROR", message: "Login required" } });
    return null;
  }
}

export const loginRequired: RequestHandler = asyncHandler(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = await resolveUser(req, res);
    if (!user) return;
    req.user = user;
    next();
  }
);

export const validateAccess = (roles: UserRole[]): RequestHandler => {
  return asyncHandler(async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({
        success: false,
        error: { code: "AUTHENTICATION_ERROR", message: "Login required" },
      });
      return;
    }
    const token = authHeader.split(" ")[1];
    if (!token) {
      res.status(401).json({
        success: false,
        error: { code: "AUTHENTICATION_ERROR", message: "Login required" },
      });
      return;
    }

    let payload: JwtPayload;
    try {
      payload = decodeToken(token);
    } catch {
      res.status(401).json({
        success: false,
        error: { code: "AUTHENTICATION_ERROR", message: "Login required" },
      });
      return;
    }

    // Fast role rejection from token — no DB hit needed
    if (payload.userRole && !roles.includes(payload.userRole)) {
      res.status(403).json({
        success: false,
        error: {
          code: "AUTHORIZATION_ERROR",
          message: "You are not authorized to perform this action",
        },
      });
      return;
    }

    // Full user fetch — validates tokenVersion (revocation) and populates req.user
    const user = await resolveUser(req, res);
    if (!user) return;
    req.user = user;
    next();
  });
};

export const requireCompletedProfile: RequestHandler = asyncHandler(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Guard: req.user must be set by loginRequired or validateAccess before this runs.
    // If not, return 401 rather than crashing with TypeError on req.user.userRole.
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: { code: "AUTHENTICATION_ERROR", message: "Login required" },
      });
      return;
    }
    if (req.user.userRole !== UserRole.Talent) {
      next();
      return;
    }
    const canProceed = !!(req.user.cvUrl && req.user.userRoles?.length);
    if (!canProceed) {
      res.status(403).json({
        success: false,
        error: {
          code: "PROFILE_INCOMPLETE",
          message: "Please complete your profile before proceeding",
        },
      });
      return;
    }
    next();
  }
);
