import { body, param, query } from "express-validator";
import { BillingInterval, Currency } from "../types/enums.js";
import { getSubscriptionPlanKeys } from "../config/pricingCatalog.js";

export const createPlanValidator = [
  body("planKey")
    .custom((value) => getSubscriptionPlanKeys().includes(value))
    .withMessage(`planKey must be one of: ${getSubscriptionPlanKeys().join(", ")}`),
  body("name").notEmpty().trim().withMessage("Plan name is required"),
  body("amount").isFloat({ min: 0.01 }).toFloat().withMessage("Amount must be a positive number"),
  body("interval")
    .isIn(Object.values(BillingInterval))
    .withMessage(`interval must be one of: ${Object.values(BillingInterval).join(", ")}`),
  body("paystackPlanCode").optional().isString(),
  body("currency")
    .isIn(Object.values(Currency))
    .withMessage(`currency must be one of: ${Object.values(Currency).join(", ")}`),
  body("description").notEmpty().withMessage("Description is required"),
  body("features").optional().isArray(),
  body("features.*").optional().isString(),
];

export const updatePlanValidator = [
  param("_id").notEmpty().withMessage("Plan ID is required"),
  body("planKey")
    .optional()
    .custom((value) => getSubscriptionPlanKeys().includes(value))
    .withMessage(`planKey must be one of: ${getSubscriptionPlanKeys().join(", ")}`),
  body("name").optional().trim(),
  body("interval").optional().isIn(Object.values(BillingInterval)).withMessage("Invalid interval"),
  body("amount").optional().isFloat({ min: 0.01 }).toFloat(),
  body("currency").optional().isIn(Object.values(Currency)).withMessage("Invalid currency"),
  body("description").optional().isString(),
  body("features").optional().isArray(),
  body("features.*").optional().isString(),
];

export const planIdParamValidator = [param("id").notEmpty().withMessage("Plan ID is required")];

export const fetchPlansQueryValidator = [
  query("interval").optional().isIn(Object.values(BillingInterval)).withMessage("Invalid interval"),
  query("currency").optional().isIn(Object.values(Currency)).withMessage("Invalid currency"),
];
