import { body } from "express-validator";
import { idParam, phoneRule } from "./shared.js";

export const switchOrganizationValidator = [idParam("_id")];

// Email and website are immutable once a company is created — they are the two
// fields verification is anchored to, so changing them would silently invalidate
// an already-verified company.
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

export const createOrganizationValidator = [
  body("email").isEmail().normalizeEmail().withMessage("Valid email is required"),
  body("name").notEmpty().withMessage("Organization name is required"),
  phoneRule("phone"),
  body("website").optional().isString(),
  body("address").notEmpty().withMessage("Address is required"),
  body("industry").optional().isString(),
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
