import logger from "../../logger.js";
import { UserRole } from "../../../types/enums.js";
import env from "../../../config/env.js";
import ResendProvider from "./providers/resend.provider.js";
import { companyInvitePlainText, verificationPlainText } from "./plainText.js";
import { renderTemplate } from "./template.js";
import type { EmailPayload, EmailProvider } from "./types.js";

export type { EmailPayload, EmailProvider };

interface UserLike {
  email: string;
  firstName: string;
  lastName: string;
  userRole: UserRole;
}

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

  /** Sends an admin's onboarding follow-up. Unlike sendEmail it throws, so failures can be recorded. */
  async sendOnboardingFollowUp(details: {
    to: string;
    subject: string;
    paragraphs: string[];
    ctaLabel: string;
    ctaUrl: string;
  }): Promise<void> {
    const html = renderTemplate("onboarding-follow-up", {
      paragraphs: details.paragraphs,
      ctaLabel: details.ctaLabel,
      ctaUrl: details.ctaUrl,
    });
    await this.provider.send({
      to: details.to,
      subject: details.subject,
      html,
      text: [...details.paragraphs, `${details.ctaLabel}: ${details.ctaUrl}`].join("\n\n"),
      tags: [{ name: "category", value: "onboarding-follow-up" }],
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
