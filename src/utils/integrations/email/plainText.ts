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

export const staffInvitePlainText = (details: {
  firstName: string;
  inviterName: string;
  companyName: string;
  jobTitle: string;
  email: string;
  inviteLink: string;
}): string =>
  [
    `Hi ${details.firstName},`,
    "",
    `${details.companyName} has added you as ${details.jobTitle}. Accept to see your contracts, pay and first-week tasks.`,
    "",
    `${details.inviterName} sent this invite. Use ${details.email} to create your Auxhr account or sign in, then complete your profile to join:`,
    details.inviteLink,
    "",
    "This link expires in 7 days. If you were not expecting this invitation, you can ignore this email.",
  ].join("\n");

export const documentToSignPlainText = (details: {
  firstName: string;
  companyName: string;
  documentTitle: string;
  signLink: string;
}): string =>
  [
    `Hi ${details.firstName},`,
    "",
    `${details.companyName} sent you your ${details.documentTitle.toLowerCase()} to sign.`,
    "",
    "Review and sign it here:",
    details.signLink,
    "",
    "This link works once and expires in 7 days.",
  ].join("\n");

export const signedDocumentPlainText = (details: {
  firstName: string;
  companyName: string;
  documentTitle: string;
  signerName: string;
}): string =>
  [
    `Hi ${details.firstName},`,
    "",
    `${details.signerName} signed the ${details.documentTitle.toLowerCase()} for ${details.companyName}. The signed copy is attached.`,
  ].join("\n");
