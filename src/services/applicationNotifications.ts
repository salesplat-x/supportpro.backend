import { ApplicationStatus } from "../types/enums.js";

// Talent-facing decision notifications are title-only — one scannable line,
// no separate "long story" message body underneath.
export const decisionNotificationTitle = (
  status: ApplicationStatus.Rejected | ApplicationStatus.Shortlisted,
  jobTitle?: string | null,
  companyName?: string | null
): string => {
  const at =
    jobTitle && companyName
      ? ` for ${jobTitle} at ${companyName}`
      : jobTitle
        ? ` for ${jobTitle}`
        : "";

  if (status === ApplicationStatus.Rejected) {
    return `You were not shortlisted${at}`;
  }

  return `Congratulations, you've been shortlisted${at}`;
};
