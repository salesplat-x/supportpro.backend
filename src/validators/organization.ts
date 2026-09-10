import { body, param } from "express-validator";
import { idParam, phoneRule } from "./shared.js";

export const switchOrganizationValidator = [idParam("_id")];

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
  body("logoUrl").optional({ values: "falsy" }).isURL().withMessage("Logo must be a valid URL"),
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
    .notEmpty()
    .withMessage("Company domain is required")
    .matches(/^@[^\s@]+\.[^\s@]+$/)
    .withMessage("Domain must start with @ and include a dot (e.g. @acme.com)"),
  body("email").isEmail().normalizeEmail().withMessage("Valid email is required"),
  body("name").notEmpty().withMessage("Organization name is required"),
  phoneRule("phone"),
  body("website").optional().isString(),
  body("address").notEmpty().withMessage("Address is required"),
  body("industry").notEmpty().withMessage("Industry is required").isString(),
  body("twitter").optional().isString(),
  body("linkedin").optional().isString(),
  body("facebook").optional().isString(),
  body("logoUrl").optional({ values: "falsy" }).isURL().withMessage("Logo must be a valid URL"),
  body("website").custom((value, { req }) => {
    if (!value && !req.body.linkedin) {
      throw new Error("Provide either a website or a LinkedIn URL");
    }
    return true;
  }),
];
