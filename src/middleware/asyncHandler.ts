import { Request, Response, NextFunction, RequestHandler } from "express";

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
    }
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
