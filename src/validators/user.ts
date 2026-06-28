import { body, query } from "express-validator";
import { phoneRule, paginationRules, idParam } from "./shared.js";
import { ExperienceLevel, WorkType, Currency, ApplicationType, ApplicationStatus } from "../types/enums.js";

export const updateUserValidator = [
  body("firstName").optional().trim(),
  body("lastName").optional().trim(),
  body("middleName").optional().trim(),
  phoneRule("phone"),
  body("picture").optional().isURL().withMessage("Picture must be a valid URL"),
  body("cv").optional().isURL().withMessage("CV must be a valid URL"),
  body("bio").optional().isLength({ max: 1000 }).withMessage("Bio must be at most 1000 characters"),
  body("country").optional().trim(),
];

export const updateProfileValidator = [
  body("bio").optional().isLength({ max: 1000 }).withMessage("Bio must be at most 1000 characters"),
  body("workType")
    .optional()
    .isArray({ min: 1 })
    .withMessage("workType must be a non-empty array"),
  body("workType.*")
    .optional()
    .isIn(Object.values(WorkType))
    .withMessage(`workType must be one of: ${Object.values(WorkType).join(", ")}`),
  body("location").optional().isObject(),
  body("location.city").optional().trim(),
  body("location.state").optional().trim(),
  body("location.country").optional().trim(),
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
  body("role").optional().isArray(),
  body("role.*").optional().isString(),
];

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
