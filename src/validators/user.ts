import { body, query } from "express-validator";
import { paginationRules, idParam } from "./shared.js";
import {
  ExperienceLevel,
  WorkType,
  Currency,
  CompensationPeriod,
  ApplicationType,
  ApplicationStatus,
} from "../types/enums.js";

// Shared profile fields persisted by both userService.updateUser and
// userService.editProfile — keep the two validators in lockstep with the
// fields the services actually read to avoid silent field-name drift.
export const profileFieldRules = [
  body("bio").optional().isLength({ max: 1000 }).withMessage("Bio must be at most 1000 characters"),
  body("workType").optional().isArray({ min: 1 }).withMessage("workType must be a non-empty array"),
  body("workType.*")
    .optional()
    .isIn(Object.values(WorkType))
    .withMessage(`workType must be one of: ${Object.values(WorkType).join(", ")}`),
  body("locationCity").optional().trim(),
  body("locationState").optional().trim(),
  body("locationCountry").optional().trim(),
  body("experience")
    .optional()
    .isIn(Object.values(ExperienceLevel))
    .withMessage(`experience must be one of: ${Object.values(ExperienceLevel).join(", ")}`),
  body("currency")
    .optional()
    .isIn(Object.values(Currency))
    .withMessage(`currency must be one of: ${Object.values(Currency).join(", ")}`),
  body("maxSalary").optional().isFloat({ min: 0, max: 100000000 }).toFloat(),
  body("minSalary")
    .optional()
    .isFloat({ min: 0, max: 100000000 })
    .toFloat()
    .custom((value, { req }) => {
      if (req.body.maxSalary !== undefined && value >= req.body.maxSalary) {
        throw new Error("minSalary must be less than maxSalary");
      }
      return true;
    }),
  body("compensationPeriod")
    .optional()
    .isIn(Object.values(CompensationPeriod))
    .withMessage(
      `compensationPeriod must be one of: ${Object.values(CompensationPeriod).join(", ")}`
    ),
  body("roleIds").optional().isArray(),
  body("roleIds.*").optional().isUUID().withMessage("roleIds must be valid UUIDs"),
];

export const updateUserValidator = [
  body("firstName").optional().trim(),
  body("lastName").optional().trim(),
  body("middleName").optional().trim(),
  body("country").optional().trim(),
  ...profileFieldRules,
];

export const updateProfileValidator = [...profileFieldRules];

export const userProfilesQueryValidator = [
  ...paginationRules,
  query("roleId").optional().isString(),
  query("experience")
    .optional()
    .isIn(Object.values(ExperienceLevel))
    .withMessage(`experience must be one of: ${Object.values(ExperienceLevel).join(", ")}`),
  query("minScore").optional().isFloat({ min: 0, max: 99 }).toFloat(),
  query("maxSalary").optional().isFloat({ min: 0, max: 100000000 }).toFloat(),
  query("incomplete").optional().isBoolean().toBoolean(),
];

export const userApplicationsQueryValidator = [
  ...paginationRules,
  query("applicationType")
    .optional()
    .isIn(Object.values(ApplicationType))
    .withMessage("Invalid applicationType"),
  query("applicationStatus")
    .optional()
    .isIn(Object.values(ApplicationStatus))
    .withMessage("Invalid applicationStatus"),
];

export const userIdParamValidator = [idParam("_id")];
