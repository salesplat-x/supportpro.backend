export const verificationPlainText = (firstName: string, verificationLink: string): string =>
  [
    `Hi ${firstName},`,
    "",
    "Please confirm this email address to activate your Auxhr account.",
    "",
    verificationLink,
    "",
    "This link expires in 24 hours. If you did not create an account, you can ignore this email.",
    "",
    "The Auxhr team",
  ].join("\n");

export const companyInvitePlainText = (details: {
  firstName: string;
  inviterName: string;
  companyName: string;
  email: string;
  inviteLink: string;
}): string =>
  [
    `Hi ${details.firstName},`,
    "",
    `${details.inviterName} invited you to join ${details.companyName} on Auxhr.`,
    "",
    `Sign in or create a recruiter account with ${details.email} to accept:`,
    details.inviteLink,
    "",
    "If you were not expecting this invitation, you can ignore this email.",
  ].join("\n");
