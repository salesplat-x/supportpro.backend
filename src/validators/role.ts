import { body } from "express-validator";
import { paginationRules, idParam } from "./shared.js";

const TYPED_ROLE_NAME = /^[^{}<>\r\n]{2,60}$/;

/** A role someone typed instead of picking: short, has a letter, nothing that could be markup. */
export const isTypedRoleName = (value: unknown): boolean =>
  typeof value === "string" && TYPED_ROLE_NAME.test(value.trim()) && /\p{L}/u.test(value);

export const TYPED_ROLE_NAME_MESSAGE =
  "A role name must be 2 to 60 characters, include a letter, and not use { } < >";

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
