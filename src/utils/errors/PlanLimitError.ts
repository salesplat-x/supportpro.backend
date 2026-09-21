import { AppError } from "./AppError.js";

/** Thrown when an organization has hit a hard limit on its current plan (see services/entitlements.ts). */
export class PlanLimitError extends AppError {
  readonly featureKey: string;
  readonly planKey: string;

  constructor(message: string, featureKey: string, planKey: string) {
    super(402, "PLAN_LIMIT_REACHED", message);
    this.featureKey = featureKey;
    this.planKey = planKey;
  }
}
