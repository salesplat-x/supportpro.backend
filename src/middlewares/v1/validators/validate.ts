import { handleValidationError } from "../../../helpers/response";
import { Request, Response, NextFunction } from "express";
import Joi from "joi";

export default (
  schema: Joi.ObjectSchema<any>,
  intercept: { query?: boolean; body?: boolean; params?: boolean }
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    //   handle the payload interception
    let payload = {};
    if (intercept.query) {
      payload = { ...payload, query: req.query };
    }
    if (intercept.body) {
      payload = { ...payload, body: req.body };
    }
    if (intercept.params) {
      payload = { ...payload, params: req.params };
    }

    // validate the payload
    const validated = schema.validate(payload);
    if (validated.error) {
      const formattedErrors = validated.error.details.map((detail) => {
        // Get the message and clean it up
        const message = detail.message
          .replace(/^"|"$/g, '') // Remove double quotes
          .replace(/^body\.|query\.|params\./, '') // Remove prefixes
          .replace(/^[^:]+: /, '') // Remove field name prefix from message
          .replace(/"\s/g, ' ')

        return message;
      });

      return res.status(400).json({
        status: false,
        message: formattedErrors.join(', '),
      });
    }
    // continue to the next middleware
    return next();
  };
};
