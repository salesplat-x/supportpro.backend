import logger from "../../logger.js";
import { UserRole, type AiInterviewMode } from "../../../types/enums.js";
import env from "../../../config/env.js";
import ResendProvider from "./providers/resend.provider.js";
import {
  companyInvitePlainText,
  documentToSignPlainText,
  signedDocumentPlainText,
  staffInvitePlainText,
  verificationPlainText,
} from "./plainText.js";
import { renderTemplate } from "./template.js";
import type { EmailPayload, EmailProvider } from "./types.js";

export type { EmailPayload, EmailProvider };

interface UserLike {
  email: string;
  firstName: string;
  lastName: string;
  userRole: UserRole;
}

/** What an email nobody reviewed has to carry: a way out, and protection against a double send. */
export interface AutomaticEmail {
  idempotencyKey: string;
  unsubscribeUrl: string;
  oneClickUrl?: string;
}

const unsubscribeText = (automatic?: AutomaticEmail): string[] =>
  automatic ? [`Stop these reminders: ${automatic.unsubscribeUrl}`] : [];

const automaticFields = (automatic?: AutomaticEmail) =>
  automatic
    ? {
        idempotencyKey: automatic.idempotencyKey,
        headers: {
          "List-Unsubscribe": `<${automatic.oneClickUrl ?? automatic.unsubscribeUrl}>`,
          ...(automatic.oneClickUrl
            ? { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
            : {}),
        },
      }
    : {};

class EmailService {
  private provider: EmailProvider;

  constructor(provider: EmailProvider = new ResendProvider()) {
    this.provider = provider;
  }

  async sendEmail(payload: EmailPayload): Promise<void> {
    try {
      await this.provider.send(payload);
    } catch (error) {
      logger.error(`Failed to send email to ${payload.to}: ${error}`);
    }
  }

  /** Sends a notice about someone's work at their company. It throws, so the caller decides what a failure means. */
  async sendPeopleUpdate(details: {
    to: string;
    subject: string;
    paragraphs: string[];
    ctaLabel: string;
    ctaUrl: string;
  }): Promise<void> {
    const html = renderTemplate("people-update", {
      paragraphs: details.paragraphs,
      ctaLabel: details.ctaLabel,
      ctaUrl: details.ctaUrl,
    });
    await this.provider.send({
      to: details.to,
      subject: details.subject,
      html,
      text: [...details.paragraphs, `${details.ctaLabel}: ${details.ctaUrl}`].join("\n\n"),
      tags: [{ name: "category", value: "people-update" }],
    });
  }

  /** Sends the admin's reply to a support request. It throws, so the caller can record a failure. */
  async sendSupportReply(details: {
    to: string;
    subject: string;
    paragraphs: string[];
    quote: string;
    ctaLabel: string;
    ctaUrl: string;
    idempotencyKey: string;
  }): Promise<void> {
    const html = renderTemplate("support-reply", {
      paragraphs: details.paragraphs,
      quote: details.quote,
      ctaLabel: details.ctaLabel,
      ctaUrl: details.ctaUrl,
    });
    await this.provider.send({
      to: details.to,
      subject: details.subject,
      html,
      text: [
        ...details.paragraphs,
        `Your message: ${details.quote}`,
        `${details.ctaLabel}: ${details.ctaUrl}`,
      ].join("\n\n"),
      tags: [{ name: "category", value: "support-reply" }],
      idempotencyKey: details.idempotencyKey,
    });
  }

  /** Sends an onboarding follow-up. Unlike sendEmail it throws, so failures can be recorded. */
  async sendOnboardingFollowUp(details: {
    to: string;
    subject: string;
    paragraphs: string[];
    ctaLabel: string;
    ctaUrl: string;
    automatic?: AutomaticEmail;
  }): Promise<void> {
    const html = renderTemplate("onboarding-follow-up", {
      paragraphs: details.paragraphs,
      ctaLabel: details.ctaLabel,
      ctaUrl: details.ctaUrl,
      unsubscribeUrl: details.automatic?.unsubscribeUrl,
    });
    await this.provider.send({
      to: details.to,
      subject: details.subject,
      html,
      text: [
        ...details.paragraphs,
        `${details.ctaLabel}: ${details.ctaUrl}`,
        ...unsubscribeText(details.automatic),
      ].join("\n\n"),
      tags: [{ name: "category", value: "onboarding-follow-up" }],
      ...automaticFields(details.automatic),
    });
  }

  /** Sends a follow-up about a talent's stuck job application. Unlike sendEmail it throws, so failures can be recorded. */
  async sendApplicationFollowUp(details: {
    to: string;
    subject: string;
    jobTitle: string;
    companyName?: string;
    paragraphs: string[];
    ctaLabel: string;
    ctaUrl: string;
    automatic?: AutomaticEmail;
  }): Promise<void> {
    const html = renderTemplate("application-follow-up", {
      jobTitle: details.jobTitle,
      companyName: details.companyName,
      paragraphs: details.paragraphs,
      ctaLabel: details.ctaLabel,
      ctaUrl: details.ctaUrl,
      unsubscribeUrl: details.automatic?.unsubscribeUrl,
    });
    await this.provider.send({
      to: details.to,
      subject: details.subject,
      html,
      text: [
        ...details.paragraphs,
        `${details.ctaLabel}: ${details.ctaUrl}`,
        ...unsubscribeText(details.automatic),
      ].join("\n\n"),
      tags: [{ name: "category", value: "application-follow-up" }],
      ...automaticFields(details.automatic),
    });
  }

  async sendAiInterviewInvite(details: {
    to: string;
    firstName?: string | null;
    jobTitle: string;
    companyName?: string;
    mode: AiInterviewMode;
    ctaUrl: string;
  }): Promise<void> {
    const how = details.mode === "audio_video" ? "audio and video" : "audio only";
    const paragraphs = [
      `Hi ${details.firstName || "there"},`,
      `You're through to the interview for ${details.jobTitle}${details.companyName ? ` at ${details.companyName}` : ""}.`,
      `There are 5 questions, and you'll record your answers (${how}).`,
    ];
    const html = renderTemplate("application-follow-up", {
      jobTitle: details.jobTitle,
      companyName: details.companyName,
      paragraphs,
      ctaLabel: "Open your interview",
      ctaUrl: details.ctaUrl,
    });
    await this.provider.send({
      to: details.to,
      subject: `Your interview for ${details.jobTitle}`,
      html,
      text: [...paragraphs, `Open your interview: ${details.ctaUrl}`].join("\n\n"),
      tags: [{ name: "category", value: "ai-interview-invite" }],
    });
  }

  /** Sends a recruiter's message to a shortlisted applicant. Unlike sendEmail it throws, so the caller can record a per-recipient failure without failing the whole batch. */
  async sendApplicantMessage(details: {
    to: string;
    subject: string;
    recruiterFirstName: string;
    jobTitle: string;
    companyName?: string;
    paragraphs: string[];
    ctaUrl: string;
  }): Promise<void> {
    const html = renderTemplate("applicant-message", {
      title: details.subject,
      preheader: details.paragraphs[0] ?? "",
      recruiterFirstName: details.recruiterFirstName,
      jobTitle: details.jobTitle,
      companyName: details.companyName,
      paragraphs: details.paragraphs,
      ctaLabel: "View and reply",
      ctaUrl: details.ctaUrl,
    });
    await this.provider.send({
      to: details.to,
      subject: details.subject,
      html,
      text: [...details.paragraphs, `View and reply: ${details.ctaUrl}`].join("\n\n"),
      tags: [{ name: "category", value: "applicant-message" }],
    });
  }

  async sendWelcome(user: UserLike): Promise<void> {
    const template = user.userRole === UserRole.Recruiter ? "welcomeRecruiter" : "welcome";
    const html = renderTemplate(template, { firstName: user.firstName });
    await this.sendEmail({ to: user.email, subject: "Welcome to Auxhr", html });
  }

  async sendPasswordReset(user: UserLike, token: string): Promise<void> {
    const resetLink = `${env.website}/reset-password?token=${encodeURIComponent(token)}`;
    const html = renderTemplate("password-reset", {
      firstName: user.firstName,
      lastName: user.lastName,
      resetLink,
    });
    await this.sendEmail({ to: user.email, subject: "Password Reset Request", html });
  }

  async sendVerificationEmail(user: UserLike, token: string, redirectPath?: string): Promise<void> {
    const verificationLink = redirectPath
      ? `${env.website}/verify-email?token=${token}&redirect=${encodeURIComponent(redirectPath)}`
      : `${env.website}/verify-email?token=${token}`;
    const html = renderTemplate("verify-email", {
      firstName: user.firstName,
      lastName: user.lastName,
      verificationLink,
    });
    await this.sendEmail({
      to: user.email,
      subject: "Verify your email address",
      html,
      text: verificationPlainText(user.firstName, verificationLink),
      tags: [{ name: "category", value: "verification" }],
    });
  }

  async sendCompanyInvite(details: {
    email: string;
    firstName: string;
    companyName: string;
    inviterName: string;
    inviteLink: string;
  }): Promise<void> {
    const html = renderTemplate("company-invite", details);
    await this.sendEmail({
      to: details.email,
      subject: `${details.inviterName} invited you to join ${details.companyName}`,
      html,
      text: companyInvitePlainText(details),
      tags: [{ name: "category", value: "company-invite" }],
    });
  }

  /** Unlike sendEmail it throws, so the caller can record that the invite did not go out. */
  async sendStaffInvite(details: {
    email: string;
    firstName: string;
    companyName: string;
    companyLogoUrl?: string | null;
    inviterName: string;
    jobTitle: string;
    inviteLink: string;
  }): Promise<void> {
    const html = renderTemplate("staff-invite", details);
    await this.provider.send({
      to: details.email,
      subject: `${details.companyName} has added you to their team`,
      html,
      text: staffInvitePlainText(details),
      tags: [{ name: "category", value: "staff-invite" }],
    });
  }

  async sendDocumentToSign(details: {
    email: string;
    firstName: string;
    companyName: string;
    companyLogoUrl?: string | null;
    documentTitle: string;
    signLink: string;
  }): Promise<void> {
    await this.provider.send({
      to: details.email,
      subject: `${details.companyName} sent you your ${details.documentTitle.toLowerCase()} to sign`,
      html: renderTemplate("staff-document-sign", details),
      text: documentToSignPlainText(details),
      tags: [{ name: "category", value: "staff-document-sign" }],
    });
  }

  async sendSignedDocument(details: {
    email: string;
    firstName: string;
    companyName: string;
    documentTitle: string;
    signerName: string;
    fileName: string;
    pdf: Buffer;
    idempotencyKey: string;
  }): Promise<void> {
    await this.provider.send({
      to: details.email,
      subject: `Signed: ${details.documentTitle} for ${details.companyName}`,
      html: renderTemplate("staff-document-signed", details),
      text: signedDocumentPlainText(details),
      tags: [{ name: "category", value: "staff-document-signed" }],
      attachments: [{ filename: details.fileName, content: details.pdf }],
      idempotencyKey: details.idempotencyKey,
    });
  }

  async sendPaymentConfirmation(details: {
    email: string;
    firstName: string;
    planName: string;
    interval: string;
    amount: string;
    currency: string;
    reference: string;
    paidAt: string;
    billingStatus: string;
    manageUrl: string;
  }): Promise<void> {
    const html = renderTemplate("payment-confirmation", details);
    await this.sendEmail({
      to: details.email,
      subject: `Payment confirmed — you're on the ${details.planName} plan`,
      html,
    });
  }
}

export default EmailService;
