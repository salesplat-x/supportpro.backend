import { body } from "express-validator";

export const initializePaymentValidator = [
  body("amount")
    .optional()
    .isFloat({ min: 0 })
    .toFloat()
    .withMessage("amount must be a positive number"),
  body("planId").optional().isString(),
  body().custom((value: { amount?: number; planId?: string }) => {
    if ((value.amount === undefined) === (value.planId === undefined)) {
      throw new Error("Provide either amount or planId, not both or neither");
    }
    return true;
  }),
];

export const verifyPaymentValidator = [
  body("reference").notEmpty().withMessage("Payment reference is required"),
];
