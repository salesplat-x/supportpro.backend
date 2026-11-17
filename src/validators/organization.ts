import { body, param } from "express-validator";
import { idParam, phoneRule } from "./shared.js";
import { isValidLinkedinUrl } from "../utils/emailDomain.js";
import { MAX_DEPARTMENT_LENGTH } from "../services/departments.js";

export const COMPANY_SIZES = ["1–10", "11–50", "51–200", "201–500", "500+"];
export const MAX_COMPANY_VALUES_LENGTH = 1000;
export const MAX_COMPANY_ABOUT_LENGTH = 2000;
export const MIN_FOUNDED_YEAR = 1800;

const optionalText = (field: string, max: number) =>
  body(field)
    .optional({ values: "null" })
    .isString()
    .withMessage(`${field} must be text`)
    .bail()
    .trim()
    .isLength({ max })
    .withMessage(`${field} must be at most ${max} characters`)
    .customSanitizer((value: string) => value || null);

export const switchOrganizationValidator = [idParam("_id")];

export const organizationLogoValidator = [idParam("_id")];

export const joinRequestIdValidator = [
  param("requestId").isUUID().withMessage("Invalid request id"),
];

export const updateOrganizationValidator = [
  idParam("_id"),
  body("name").optional().notEmpty().withMessage("Organization name cannot be empty"),
  phoneRule("phone"),
  body("address").optional().notEmpty().withMessage("Address cannot be empty"),
  body("industry").optional().isString(),
  body("twitter").optional().isString(),
  body("linkedin").optional().isString(),
  body("facebook").optional().isString(),
  optionalText("companyValues", MAX_COMPANY_VALUES_LENGTH),
  optionalText("about", MAX_COMPANY_ABOUT_LENGTH),
  body("size")
    .optional({ values: "null" })
    .isIn(COMPANY_SIZES)
    .withMessage(`size must be one of ${COMPANY_SIZES.join(", ")}`),
  body("foundedYear")
    .optional({ values: "null" })
    .custom((value) => {
      const latest = new Date().getUTCFullYear();
      if (!Number.isInteger(value) || value < MIN_FOUNDED_YEAR || value > latest) {
        throw new Error(`foundedYear must be a whole year from ${MIN_FOUNDED_YEAR} to ${latest}`);
      }
      return true;
    }),
];

export const setMemberCanManagePeopleValidator = [
  param("_id").isUUID().withMessage("Invalid company id"),
  param("memberId").isUUID().withMessage("Invalid member id"),
  body("canManagePeople")
    .isBoolean({ strict: true })
    .withMessage("canManagePeople must be true or false")
    .bail()
    .toBoolean(),
];

export const deleteOrganizationValidator = [idParam("_id")];

export const joinRequestOrganizationValidator = [
  idParam("_id"),
  body("workEmail").isEmail().normalizeEmail().withMessage("Valid work email is required"),
];

export const inviteTokenValidator = [
  param("token").notEmpty().withMessage("Invite token is required"),
];

export const sendOrganizationInviteValidator = [
  idParam("_id"),
  body("email").isEmail().normalizeEmail().withMessage("Valid email is required"),
];

export const revokeOrganizationInviteValidator = [
  idParam("_id"),
  param("inviteId").isUUID().withMessage("Invalid invite id"),
];

export const createOrganizationValidator = [
  body("domain")
    .optional({ values: "falsy" })
    .matches(/^@?[^\s@]+\.[^\s@]+$/)
    .withMessage("Domain must include a dot (e.g. acme.com)"),
  body("email").isEmail().normalizeEmail().withMessage("Valid email is required"),
  body("name").notEmpty().withMessage("Organization name is required"),
  phoneRule("phone"),
  body("website").optional().isString(),
  body("address").notEmpty().withMessage("Address is required"),
  body("industry").notEmpty().withMessage("Industry is required").isString(),
  body("twitter").optional().isString(),
  body("linkedin")
    .custom((value, { req }) => {
      if (!req.body.domain?.trim() && !value?.trim()) {
        throw new Error("LinkedIn URL is required when no company domain is provided");
      }
      return true;
    })
    .custom((value) => !value || isValidLinkedinUrl(value))
    .withMessage("Enter a valid LinkedIn URL (e.g. https://linkedin.com/company/acme)"),
  body("facebook").optional().isString(),
];

export const joinWithAccessCodeValidator = [
  body("code")
    .isString()
    .withMessage("Enter your company's access code")
    .bail()
    .trim()
    .isLength({ min: 8, max: 20 })
    .withMessage("Enter your company's access code"),
];

export const addDepartmentValidator = [
  idParam("_id"),
  body("name")
    .isString()
    .withMessage("Department name must be text")
    .bail()
    .trim()
    .isLength({ min: 1, max: MAX_DEPARTMENT_LENGTH })
    .withMessage(`Department name must be 1-${MAX_DEPARTMENT_LENGTH} characters`),
];

export const removeDepartmentValidator = [
  idParam("_id"),
  param("name")
    .trim()
    .isLength({ min: 1, max: MAX_DEPARTMENT_LENGTH })
    .withMessage("Invalid department name"),
];
