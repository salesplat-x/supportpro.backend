import { body } from "express-validator";
import { BillingInterval } from "../types/enums.js";
import { getSubscriptionPlanKeys } from "../config/pricingCatalog.js";

export const initializePaymentValidator = [
  body("planKey")
    .custom((value) => getSubscriptionPlanKeys().includes(value))
    .withMessage(`planKey must be one of: ${getSubscriptionPlanKeys().join(", ")}`),
  body("interval")
    .isIn([BillingInterval.Monthly, BillingInterval.Annually])
    .withMessage("interval must be monthly or annually"),
];

export const verifyPaymentValidator = [
  body("reference").notEmpty().withMessage("Payment reference is required"),
];
