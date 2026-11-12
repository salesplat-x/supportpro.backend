import { body, param, query } from "express-validator";
import { paginationRules, idParam } from "./shared.js";
import { ApplicationStatus, ApplicationType, ExperienceLevel } from "../types/enums.js";

export const getApplicationsQueryValidator = [
  ...paginationRules,
  query("roleId").optional().isString(),
  query("experienceLevel")
    .optional()
    .isIn(Object.values(ExperienceLevel))
    .withMessage("Invalid experienceLevel"),
  query("job").optional().isString(),
  query("applicationType")
    .optional()
    .isIn(Object.values(ApplicationType))
    .withMessage("Invalid applicationType"),
  query("applicationStatus")
    .optional()
    .isIn(Object.values(ApplicationStatus))
    .withMessage("Invalid applicationStatus"),
];

export const applicationIdParamValidator = [idParam("_id")];

export const DECISION_EMAIL_MAX_CHARS = 2000;

export const updateApplicationStatusValidator = [
  param("_id").notEmpty().withMessage("Application ID is required"),
  body("status")
    .isIn([ApplicationStatus.Rejected, ApplicationStatus.Shortlisted])
    .withMessage(
      `status must be one of: ${ApplicationStatus.Rejected}, ${ApplicationStatus.Shortlisted}`
    ),
  body("email")
    .optional()
    .isObject()
    .custom((_value, { req }) => req.body.status === ApplicationStatus.Rejected)
    .withMessage("An email can only be sent with a rejection"),
  body("email.send")
    .if(body("email").exists())
    .isBoolean()
    .withMessage("email.send must be true or false")
    .toBoolean(),
  body("email.body")
    .if(body("email.send").equals("true"))
    .isString()
    .trim()
    .isLength({ min: 1, max: DECISION_EMAIL_MAX_CHARS })
    .withMessage(`Write the email, up to ${DECISION_EMAIL_MAX_CHARS} characters`),
];

export const advanceApplicationValidator = [
  idParam("_id"),
  body("sendInterviewInvite")
    .isBoolean()
    .withMessage("sendInterviewInvite must be true or false")
    .toBoolean(),
];

export const bulkUpdateApplicationStatusValidator = [
  body("applicationIds")
    .isArray({ min: 1 })
    .withMessage("applicationIds must be a non-empty array"),
  body("applicationIds.*").isString(),
  body("status")
    .isIn([ApplicationStatus.Rejected, ApplicationStatus.Shortlisted])
    .withMessage(
      `status must be one of: ${ApplicationStatus.Rejected}, ${ApplicationStatus.Shortlisted}`
    ),
];
