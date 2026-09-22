import { body, param } from "express-validator";

export const subscriptionIdParamValidator = [
  param("id").notEmpty().withMessage("Subscription ID is required"),
];

export const findSubscriptionValidator = [
  body("userId").optional().isString(),
  body("planId").optional().isString(),
  body().custom((value: { userId?: string; planId?: string }) => {
    if (!value.userId && !value.planId) {
      throw new Error("At least one of userId or planId must be provided");
    }
    return true;
  }),
];
