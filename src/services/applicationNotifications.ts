import { ApplicationStatus } from "../types/enums.js";

// Shared by the single-item and bulk status-update paths so the copy a talent
// sees never drifts between the two (item 9).
export const decisionNotificationMessage = (
  status: ApplicationStatus.Rejected | ApplicationStatus.Shortlisted,
  jobTitle?: string | null
): string => {
  if (status === ApplicationStatus.Rejected) {
    return jobTitle
      ? `Thanks for applying to ${jobTitle} — this one wasn't the right fit, but your dream job is still out there. Keep going!`
      : "This role wasn't the right fit this time — but your dream job is still out there. Keep going!";
  }

  return jobTitle
    ? `Great news! You've been shortlisted for ${jobTitle}. Watch your inbox — the recruiter will be in touch soon.`
    : "Congratulations, you've been shortlisted! Watch your inbox for a message from the recruiter.";
};

// Short, scannable notification title — the message body above stays available
// as secondary/expandable text.
export const decisionNotificationTitle = (
  status: ApplicationStatus.Rejected | ApplicationStatus.Shortlisted,
  jobTitle?: string | null
): string => {
  if (status === ApplicationStatus.Rejected) {
    return jobTitle ? `Update on your ${jobTitle} application` : "Update on your application";
  }

  return jobTitle ? `Shortlisted for ${jobTitle}` : "You've been shortlisted";
};
