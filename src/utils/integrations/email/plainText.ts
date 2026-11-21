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
  department?: string | null;
  managerName?: string | null;
  startDate?: string | null;
  expiresOn: string;
  email: string;
  inviteLink: string;
}): string =>
  [
    `Hi ${details.firstName},`,
    "",
    `${details.companyName} added you as ${details.jobTitle}. Accept to see your contracts, pay and first-week tasks.`,
    "",
    `Role: ${details.jobTitle}${details.department ? ` · ${details.department} team` : ""}`,
    ...(details.managerName ? [`Your manager: ${details.managerName}`] : []),
    ...(details.startDate ? [`Start date: ${details.startDate}`] : []),
    "",
    "Accept invite:",
    details.inviteLink,
    "",
    `${details.inviterName} sent this invite to ${details.email}. It works for 7 days, until ${details.expiresOn}. Not expecting this? You can ignore this email.`,
  ].join("\n");

export const documentToSignPlainText = (details: {
  firstName: string;
  companyName: string;
  documentTitle: string;
  jobTitle: string;
  startDate: string;
  signLink: string;
}): string =>
  [
    `Hi ${details.firstName}, your ${details.documentTitle.toLowerCase()} is ready to sign.`,
    "",
    `${details.companyName} sent you your ${details.documentTitle.toLowerCase()} for ${details.jobTitle}. Read it, then sign it online. It takes about 2 minutes.`,
    "",
    `${details.documentTitle} for ${details.jobTitle}`,
    `Start date ${details.startDate}`,
    "Sign by typing your full name",
    "A signed copy is emailed to you",
    "",
    "Review and sign:",
    details.signLink,
    "",
    `This link works once. If it stops working, ask ${details.companyName} to send it again.`,
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
