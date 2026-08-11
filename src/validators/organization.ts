import { body } from "express-validator";
import { idParam, phoneRule } from "./shared.js";

export const switchOrganizationValidator = [idParam("_id")];

export const createOrganizationValidator = [
  body("email").isEmail().normalizeEmail().withMessage("Valid email is required"),
  body("name").notEmpty().withMessage("Organization name is required"),
  phoneRule("phone"),
  body("website").notEmpty().withMessage("Website is required"),
  body("address").notEmpty().withMessage("Address is required"),
  body("industry").optional().isString(),
  body("twitter").optional().isString(),
  body("linkedin").optional().isString(),
  body("facebook").optional().isString(),
];
