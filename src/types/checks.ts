export const CHECK_TYPES = ["identity", "employment", "education", "criminal"] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

export const CHECK_STATUSES = ["pending", "passed", "flagged", "failed"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export type OverallStatus = "failed" | "flagged" | "pending" | "verified" | "none";

export const CHECK_RESULTS = ["verified", "flagged", "failed"] as const;
export type CheckResult = (typeof CHECK_RESULTS)[number];

export const CHECK_EVENT_KINDS = ["ordered", "result_saved", "viewed", "id_number_viewed"] as const;
export type CheckEventKind = (typeof CHECK_EVENT_KINDS)[number];
