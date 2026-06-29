import { body, param } from "express-validator";

export const subscriptionIdParamValidator = [
  param("id").notEmpty().withMessage("Subscription ID is required"),
];

export const findSubscriptionValidator = [
  body("user").optional().isString(),
  body("plan").optional().isString(),
  body().custom((value: { user?: string; plan?: string }) => {
    if (!value.user && !value.plan) {
      throw new Error("At least one of user or plan must be provided");
    }
    return true;
  }),
];
