import { body, param, query } from "express-validator";
import { ExperienceLevel, JobStatus, OrganizationStatus } from "../types/enums.js";
import {
  FOLLOW_UP_STATUSES,
  MAX_BODY_LENGTH,
  MAX_SUBJECT_LENGTH,
  RECRUITER_STAGES,
  TALENT_STAGES,
} from "../services/onboardingRules.js";
import {
  FOLLOW_UP_STATUSES as APP_FOLLOW_UP_STATUSES,
  MAX_BODY_LENGTH as APP_MAX_BODY_LENGTH,
  MAX_SUBJECT_LENGTH as APP_MAX_SUBJECT_LENGTH,
  STUCK_STAGES,
} from "../services/applicationFollowUpRules.js";
import { OVERVIEW_RANGES } from "../services/adminOverview.js";
import { AI_FEATURE_KEYS } from "../utils/integrations/ai/catalog.js";
import { idParam, paginationRules } from "./shared.js";

const onboardingQueryRules = (stages: readonly string[]) => [
  query("onboardingStage")
    .optional()
    .isIn(stages)
    .withMessage(`onboardingStage must be one of: ${stages.join(", ")}`),
  query("followUp")
    .optional()
    .isIn(FOLLOW_UP_STATUSES)
    .withMessage(`followUp must be one of: ${FOLLOW_UP_STATUSES.join(", ")}`),
];

export const adminTalentsQueryValidator = [
  ...paginationRules,
  query("search").optional().trim().isLength({ max: 200 }),
  query("experience")
    .optional()
    .isIn(Object.values(ExperienceLevel))
    .withMessage(`experience must be one of: ${Object.values(ExperienceLevel).join(", ")}`),
  query("roleId").optional().isUUID().withMessage("roleId must be a valid UUID"),
  ...onboardingQueryRules(TALENT_STAGES),
];

export const adminRecruitersQueryValidator = [
  ...paginationRules,
  query("search").optional().trim().isLength({ max: 200 }),
  ...onboardingQueryRules(RECRUITER_STAGES),
];

export const adminUserIdParamValidator = [
  param("_id").isUUID().withMessage("_id must be a valid UUID"),
];

export const adminOnboardingEmailValidator = [
  ...adminUserIdParamValidator,
  body("subject")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("Add a subject")
    .isLength({ max: MAX_SUBJECT_LENGTH })
    .withMessage(`Subject must be at most ${MAX_SUBJECT_LENGTH} characters`),
  body("body")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("Add a message")
    .isLength({ max: MAX_BODY_LENGTH })
    .withMessage(`Message must be at most ${MAX_BODY_LENGTH} characters`),
  body("confirm").optional().isBoolean().toBoolean(),
];

export const adminJobsQueryValidator = [
  ...paginationRules,
  query("search").optional().trim().isLength({ max: 200 }),
  query("status")
    .optional()
    .isIn(Object.values(JobStatus))
    .withMessage(`status must be one of: ${Object.values(JobStatus).join(", ")}`),
  query("roleId").optional().isUUID().withMessage("roleId must be a valid UUID"),
  query("organizationId").optional().isUUID().withMessage("organizationId must be a valid UUID"),
];

export const adminIdParamValidator = [idParam("_id")];

export const adminOrganizationsQueryValidator = [
  ...paginationRules,
  query("search").optional().trim().isLength({ max: 200 }),
  query("status")
    .optional()
    .isIn(Object.values(OrganizationStatus))
    .withMessage(`status must be one of: ${Object.values(OrganizationStatus).join(", ")}`),
];

export const adminStuckApplicationsQueryValidator = [
  ...paginationRules,
  query("search").optional().trim().isLength({ max: 200 }),
  query("stuckStage")
    .optional()
    .isIn(STUCK_STAGES)
    .withMessage(`stuckStage must be one of: ${STUCK_STAGES.join(", ")}`),
  query("followUp")
    .optional()
    .isIn(APP_FOLLOW_UP_STATUSES)
    .withMessage(`followUp must be one of: ${APP_FOLLOW_UP_STATUSES.join(", ")}`),
];

export const adminApplicationIdParamValidator = [
  param("_id").isUUID().withMessage("_id must be a valid UUID"),
];

export const adminApplicationFollowUpEmailValidator = [
  ...adminApplicationIdParamValidator,
  body("subject")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("Add a subject")
    .isLength({ max: APP_MAX_SUBJECT_LENGTH })
    .withMessage(`Subject must be at most ${APP_MAX_SUBJECT_LENGTH} characters`),
  body("body")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("Add a message")
    .isLength({ max: APP_MAX_BODY_LENGTH })
    .withMessage(`Message must be at most ${APP_MAX_BODY_LENGTH} characters`),
  body("confirm").optional().isBoolean().toBoolean(),
];

export const adminOverviewQueryValidator = [
  query("days")
    .optional()
    .isIn(OVERVIEW_RANGES.map(String))
    .withMessage(`days must be one of: ${OVERVIEW_RANGES.join(", ")}`),
];

export const adminAiFeatureModelValidator = [
  param("key").isIn(AI_FEATURE_KEYS).withMessage("Unknown AI job"),
  body("provider").isString().trim().isLength({ min: 1, max: 32 }).withMessage("Choose a provider"),
  body("model").isString().trim().isLength({ min: 1, max: 128 }).withMessage("Choose a model"),
];

export const adminAiFeatureKeyValidator = [
  param("key").isIn(AI_FEATURE_KEYS).withMessage("Unknown AI job"),
];

export const adminAiFeaturePromptsValidator = [
  ...adminAiFeatureKeyValidator,
  body("prompts").isObject().withMessage("Send the prompt text to save"),
  body("prompts.*").isString().withMessage("A prompt must be text"),
];
