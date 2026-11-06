export const SUPPORT_STATUSES = ["unread", "read", "unreplied", "replied"] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

export const OVERDUE_AFTER = "48 hours";

/**
 * The one place a request's status is decided. It is never stored: "unreplied" means
 * no reply 48 hours after arrival, so it changes with time alone. Every query selects
 * it through this expression, so the list, the counts and a single request always agree.
 */
export const supportStatusSql = (alias: string): string => `CASE
    WHEN ${alias}."replied_at" IS NOT NULL THEN 'replied'
    WHEN ${alias}."createdAt" < NOW() - INTERVAL '${OVERDUE_AFTER}' THEN 'unreplied'
    WHEN ${alias}."isRead" = false THEN 'unread'
    ELSE 'read'
  END`;

/** Most urgent first: overdue, then never opened, then opened, then answered. */
export const supportStatusRankSql = (alias: string): string => `CASE ${supportStatusSql(alias)}
    WHEN 'unreplied' THEN 0
    WHEN 'unread' THEN 1
    WHEN 'read' THEN 2
    ELSE 3
  END`;
