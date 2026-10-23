import { body, param, query, type ValidationChain } from "express-validator";
import { StaffStatus } from "../entities/StaffMember.js";

const NO_LINE_BREAKS = /^[^\r\n]*$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;
const MAX_TEXT = 120;
const MAX_EMAIL = 254;

const orgParam = param("_id").isUUID().withMessage("Invalid company id");
const staffParam = param("staffId").isUUID().withMessage("Invalid staff id");

const text = (chain: ValidationChain, label: string): ValidationChain =>
  chain
    .isString()
    .withMessage(`${label} must be text`)
    .bail()
    .trim()
    .isLength({ min: 1, max: MAX_TEXT })
    .withMessage(`${label} must be between 1 and ${MAX_TEXT} characters`)
    .bail()
    .matches(NO_LINE_BREAKS)
    .withMessage(`${label} can't contain line breaks`);

const nullableText = (chain: ValidationChain, label: string): ValidationChain =>
  chain
    .optional({ values: "null" })
    .isString()
    .withMessage(`${label} must be text`)
    .bail()
    .trim()
    .isLength({ max: MAX_TEXT })
    .withMessage(`${label} must be at most ${MAX_TEXT} characters`)
    .bail()
    .matches(NO_LINE_BREAKS)
    .withMessage(`${label} can't contain line breaks`);

const dateOnly = (chain: ValidationChain, label: string): ValidationChain =>
  chain
    .isString()
    .matches(DATE_ONLY)
    .withMessage(`${label} must be a date like 2026-01-31`)
    .bail()
    .isISO8601({ strict: true, strictSeparator: true })
    .withMessage(`${label} is not a real date`)
    .bail()
    .custom((value: string) => {
      const year = Number(value.slice(0, 4));
      return year >= MIN_YEAR && year <= MAX_YEAR;
    })
    .withMessage(`${label} must be between ${MIN_YEAR} and ${MAX_YEAR}`);

const flag = (field: string, label: string): ValidationChain =>
  body(field)
    .optional()
    .isBoolean({ strict: true })
    .withMessage(`${label} must be true or false`)
    .bail()
    .toBoolean();

const pagination = [
  query("limit").optional().isInt({ min: 1, max: 100 }).withMessage("limit must be 1-100").toInt(),
  query("offset").optional().isInt({ min: 0 }).withMessage("offset must be 0 or more").toInt(),
];

export const companyParamValidator = [orgParam];

export const staffOptionsValidator = [
  orgParam,
  query("includeEnded")
    .optional()
    .isIn(["true", "false"])
    .withMessage("includeEnded must be true or false")
    .bail()
    .toBoolean(),
];

export const listStaffValidator = [
  orgParam,
  ...pagination,
  query("status")
    .optional()
    .isIn(Object.values(StaffStatus))
    .withMessage(`status must be one of: ${Object.values(StaffStatus).join(", ")}`),
  query("search").optional().isString().trim().isLength({ max: 100 }),
];

export const createStaffValidator = [
  orgParam,
  text(body("fullName"), "Full name"),
  body("email")
    .isString()
    .isLength({ max: MAX_EMAIL })
    .isEmail()
    .normalizeEmail()
    .withMessage("A valid email is required"),
  text(body("jobTitle"), "Job title"),
  nullableText(body("department"), "Department"),
  body("managerId").optional({ values: "null" }).isUUID().withMessage("Invalid manager"),
  dateOnly(body("startDate"), "Start date"),
  flag("isExecutive", "isExecutive"),
  flag("sendInvite", "sendInvite"),
];

export const staffIdValidator = [orgParam, staffParam];

export const updateStaffValidator = [
  orgParam,
  staffParam,
  text(body("fullName").optional(), "Full name"),
  text(body("jobTitle").optional(), "Job title"),
  nullableText(body("department"), "Department"),
  body("managerId").optional({ values: "null" }).isUUID().withMessage("Invalid manager"),
  dateOnly(body("startDate").optional(), "Start date"),
  flag("isExecutive", "isExecutive"),
];

export const endStaffValidator = [
  orgParam,
  staffParam,
  dateOnly(body("endDate").optional(), "End date"),
];

export const accessLogValidator = [
  orgParam,
  ...pagination,
  query("staffId").optional().isUUID().withMessage("Invalid staff id"),
  query("actorId").optional().isUUID().withMessage("Invalid person id"),
  dateOnly(query("from").optional(), "From date"),
  dateOnly(query("to").optional(), "To date"),
];

export const staffInviteTokenValidator = [
  param("token")
    .matches(/^[a-f0-9]{64}$/)
    .withMessage("This invite link is not valid"),
];
