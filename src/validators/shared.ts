import { body, query, param, ValidationChain } from "express-validator";
import { PhoneNumberUtil } from "google-libphonenumber";

const phoneUtil = PhoneNumberUtil.getInstance();

export const passwordRules = (field: string): ValidationChain =>
  body(field)
    .isLength({ min: 8, max: 72 })
    .withMessage("Password must be between 8 and 72 characters")
    .matches(/^(?=.*[A-Za-z])(?=.*\d)(?=.*[@$!%*#.?&])[A-Za-z\d@$!%*#?.&]{8,}$/)
    .withMessage(
      "Password must contain at least one number, one letter and one special character"
    );

export const phoneRule = (field: string): ValidationChain =>
  body(field)
    .optional()
    .custom((value: string) => {
      try {
        const number = phoneUtil.parseAndKeepRawInput(value, "");
        if (!phoneUtil.isValidNumber(number)) {
          throw new Error();
        }
        return true;
      } catch {
        throw new Error(
          "must be a valid international phone number e.g., +2348058272524"
        );
      }
    });

export const paginationRules = [
  query("limit").optional().isInt({ min: 1 }).toInt(),
  query("offset").optional().isInt({ min: 0 }).toInt(),
  query("sort").optional().isIn(["asc", "desc"]),
];

export const idParam = (name = "_id") =>
  param(name).notEmpty().withMessage(`${name} is required`);
