import { body } from "express-validator";
import { paginationRules, idParam } from "./shared.js";

export const createRoleValidator = [
  body("name").notEmpty().trim().withMessage("Role name is required"),
  body("description").optional().trim(),
];

export const roleIdParamValidator = [idParam("_id")];

export const updateRoleValidator = [
  body("name").optional().notEmpty().trim().withMessage("Role name cannot be empty"),
  body("description").optional().trim(),
];

export const allRolesQueryValidator = [...paginationRules];

export const roleQuestionsValidator = [idParam("_id"), ...paginationRules];
