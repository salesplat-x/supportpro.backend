import { body } from "express-validator";
import { BillingInterval } from "../types/enums.js";

export const initializePaymentValidator = [
  body("planKey").equals("paid").withMessage("planKey must be paid"),
  body("interval")
    .isIn([BillingInterval.Monthly, BillingInterval.Annually])
    .withMessage("interval must be monthly or annually"),
];

export const verifyPaymentValidator = [
  body("reference").notEmpty().withMessage("Payment reference is required"),
];
