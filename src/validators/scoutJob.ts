import { body, param, query } from "express-validator";
import { paginationRules } from "./shared.js";
import { ExperienceLevel, WorkMode } from "../types/enums.js";
import { MAX_SHORTLIST_SIZE, MIN_SHORTLIST_SIZE } from "../config/scout.js";

const MAX_SKILLS = 15;
const MAX_SKILL_LENGTH = 60;

const shortlistSizeRule = (chain: ReturnType<typeof body>) =>
  chain
    .isInt({ min: MIN_SHORTLIST_SIZE, max: MAX_SHORTLIST_SIZE })
    .withMessage(
      `Choose between ${MIN_SHORTLIST_SIZE} and ${MAX_SHORTLIST_SIZE} candidates to shortlist`
    )
    .toInt();

/**
 * Skills arrive as an array of short strings. Rejected loudly rather than coerced,
 * because a silently dropped must-have skill changes who gets shortlisted.
 */
const skillsRule = (field: string, label: string) =>
  body(field)
    .optional({ values: "null" })
    .isArray({ max: MAX_SKILLS })
    .withMessage(`${label} can list at most ${MAX_SKILLS} skills`)
    .bail()
    .custom((value: unknown[]) => {
      const invalid = value.some(
        (skill) =>
          typeof skill !== "string" || skill.trim().length === 0 || skill.length > MAX_SKILL_LENGTH
      );
      if (invalid) {
        throw new Error(
          `Each ${label.toLowerCase()} entry must be 1-${MAX_SKILL_LENGTH} characters`
        );
      }
      return true;
    });

const targetingRules = [
  body("experienceLevel")
    .optional({ values: "null" })
    .isIn(Object.values(ExperienceLevel))
    .withMessage(`experienceLevel must be one of: ${Object.values(ExperienceLevel).join(", ")}`),
  skillsRule("mustHaveSkills", "Must-have skills"),
  skillsRule("niceToHaveSkills", "Nice-to-have skills"),
  body("workMode")
    .optional({ values: "null" })
    .isIn(Object.values(WorkMode))
    .withMessage(`workMode must be one of: ${Object.values(WorkMode).join(", ")}`),
  body("locationCountry").optional({ values: "null" }).isString().trim().isLength({ max: 120 }),
  body("locationState").optional({ values: "null" }).isString().trim().isLength({ max: 120 }),
  body("locationCity").optional({ values: "null" }).isString().trim().isLength({ max: 120 }),
];

export const createScoutJobValidator = [
  body("role").notEmpty().isUUID().withMessage("A valid role is required"),
  body("jobBrief")
    .isString()
    .trim()
    .isLength({ min: 50, max: 5000 })
    .withMessage("Job brief must be between 50 and 5000 characters"),
  body("name")
    .isString()
    .trim()
    .isLength({ min: 1, max: 150 })
    .withMessage("Name is required and must be at most 150 characters"),
  body("recruiterGuide")
    .isString()
    .trim()
    .isLength({ min: 30, max: 2000 })
    .withMessage("Tell the AI how to choose in between 30 and 2000 characters"),
  shortlistSizeRule(body("shortlistSize").optional()),
  ...targetingRules,
];

export const updateScoutJobValidator = [
  param("_id").isUUID().withMessage("Scout job ID must be a valid UUID"),
  body("role").optional().isUUID().withMessage("role must be a valid UUID"),
  body("jobBrief")
    .optional()
    .isString()
    .trim()
    .isLength({ min: 50, max: 5000 })
    .withMessage("Job brief must be between 50 and 5000 characters"),
  body("name").optional().isString().trim().isLength({ min: 1, max: 150 }),
  body("recruiterGuide")
    .optional()
    .isString()
    .trim()
    .isLength({ min: 30, max: 2000 })
    .withMessage("Tell the AI how to choose in between 30 and 2000 characters"),
  shortlistSizeRule(body("shortlistSize").optional()),
  ...targetingRules,
];

export const scoutJobIdParamValidator = [
  param("_id").isUUID().withMessage("Scout job ID must be a valid UUID"),
];

export const scoutJobsListQueryValidator = [
  query("search").optional().isString().trim().isLength({ max: 150 }),
  ...paginationRules,
];
