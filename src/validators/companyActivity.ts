import { query } from "express-validator";
import { dateOnly, orgParam, pagination } from "./staff.js";

const MAX_SEARCH_LENGTH = 100;

export const companyActivityValidator = [
  orgParam,
  ...pagination,
  query("actorId").optional().isUUID().withMessage("Invalid person id"),
  query("search")
    .optional()
    .isString()
    .withMessage("search must be text")
    .bail()
    .trim()
    .isLength({ max: MAX_SEARCH_LENGTH })
    .withMessage(`search must be at most ${MAX_SEARCH_LENGTH} characters`),
  dateOnly(query("from").optional(), "From date"),
  dateOnly(query("to").optional(), "To date"),
];
