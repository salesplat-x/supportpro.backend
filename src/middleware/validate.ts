import { Request, Response, NextFunction, RequestHandler } from "express";
import { validationResult, ValidationChain } from "express-validator";
import { ValidationError } from "../utils/errors/index.js";

export const validate = (validations: ValidationChain[]): RequestHandler[] => {
  return [
    ...validations,
    // Pass errors to next() rather than throwing synchronously — Express 4 does not
    // guarantee that synchronous throws in plain middleware reach the error handler.
    (req: Request, _res: Response, next: NextFunction): void => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        const fields: Record<string, string> = {};
        for (const err of errors.array()) {
          if (err.type === "field") {
            fields[err.path] = err.msg as string;
          }
        }
        const firstMessage = errors.array()[0]?.msg as string;
        next(new ValidationError(firstMessage, fields));
        return;
      }
      next();
    },
  ];
};
