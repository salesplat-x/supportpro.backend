import { Request, Response, NextFunction, RequestHandler } from "express";
import { lookupActivityTarget } from "../services/companyActivity.js";

type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/**
 * `action` names what a route does in the user's words (e.g. "delete recruiter") so an
 * unexpected failure can be reported as "Could not delete recruiter" instead of a generic error.
 * Middleware wrappers leave it out so they never relabel the route they run in front of.
 */
export const asyncHandler = (fn: AsyncRequestHandler, action?: string): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (action) {
      res.locals["action"] = action;
      res.locals["route"] =
        `${req.baseUrl}${typeof req.route?.path === "string" ? req.route.path : ""}`;
      res.locals["routeParams"] = { ...req.params };
    }
    if (action && req.method === "DELETE") {
      lookupActivityTarget(res.locals["route"] as string, { ...req.params })
        .catch(() => null)
        .then((target) => {
          if (target) res.locals["activityTarget"] = target;
          return fn(req, res, next);
        })
        .catch(next);
      return;
    }
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
