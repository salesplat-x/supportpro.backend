import { ApplicationStatus } from "../types/enums.js";

// Shared by the single-item and bulk status-update paths so the copy a talent
// sees never drifts between the two (item 9).
export const decisionNotificationMessage = (
  status: ApplicationStatus.Rejected | ApplicationStatus.Shortlisted
): string =>
  status === ApplicationStatus.Rejected
    ? "This role wasn't the right fit this time — but your dream job is still out there. Keep going!"
    : "Congratulations, you've been shortlisted! Watch your inbox for a message from the recruiter.";
