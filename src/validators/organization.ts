import { body, param } from "express-validator";
import { idParam, phoneRule } from "./shared.js";
import { isValidLinkedinUrl } from "../utils/emailDomain.js";

export const switchOrganizationValidator = [idParam("_id")];

export const organizationLogoValidator = [idParam("_id")];

export const joinRequestIdValidator = [
  param("requestId").isUUID().withMessage("Invalid request id"),
];

// Declares every owner-editable field. The controller passes only matchedData()
// to the service, so a field missing here is silently dropped; keep this list in
// step with EDITABLE_ORGANIZATION_FIELDS in services/organization.ts.
export const updateOrganizationValidator = [
  idParam("_id"),
  body("name").optional().notEmpty().withMessage("Organization name cannot be empty"),
  phoneRule("phone"),
  body("address").optional().notEmpty().withMessage("Address cannot be empty"),
  body("industry").optional().isString(),
  body("twitter").optional().isString(),
  body("linkedin").optional().isString(),
  body("facebook").optional().isString(),
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
