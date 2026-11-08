export const CHECK_TYPES = ["identity", "employment", "education", "criminal"] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

export const CHECK_STATUSES = ["pending", "passed", "flagged", "failed"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export type OverallStatus = "failed" | "flagged" | "pending" | "verified" | "none";
