import type { CheckStatus, OverallStatus } from "../types/checks.js";

export const overallStatus = (checks: ReadonlyArray<{ status: CheckStatus }>): OverallStatus => {
  if (checks.length === 0) return "none";
  const statuses = new Set(checks.map((check) => check.status));
  if (statuses.has("failed")) return "failed";
  if (statuses.has("flagged")) return "flagged";
  if (statuses.has("pending")) return "pending";
  return "verified";
};
