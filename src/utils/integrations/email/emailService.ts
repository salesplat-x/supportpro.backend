import logger from "../../logger.js";
import { UserRole } from "../../../types/enums.js";
import env from "../../../config/env.js";
import ResendProvider from "./providers/resend.provider.js";
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

  async sendWelcome(user: UserLike): Promise<void> {
    const template = user.userRole === UserRole.Recruiter ? "welcomeRecruiter" : "welcome";
    const html = renderTemplate(template, { firstName: user.firstName });
    await this.sendEmail({ to: user.email, subject: "Welcome to Auxhr", html });
  }

  async sendPasswordReset(user: UserLike, otp: string): Promise<void> {
    const html = renderTemplate("password-reset", {
      firstName: user.firstName,
      lastName: user.lastName,
      otp,
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
    await this.sendEmail({ to: user.email, subject: "Verify your email address", html });
  }
}

export default EmailService;
