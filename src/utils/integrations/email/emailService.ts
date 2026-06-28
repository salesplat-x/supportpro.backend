import logger from "../../logger.js";
import { UserRole } from "../../../types/enums.js";
import BrevoProvider from "./providers/brevo.provider.js";
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

  constructor(provider: EmailProvider = new BrevoProvider()) {
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
    await this.sendEmail({ to: user.email, subject: "Welcome to AuxHR", html });
  }

  async sendPasswordReset(user: UserLike, otp: string): Promise<void> {
    const html = renderTemplate("password-reset", {
      firstName: user.firstName,
      lastName: user.lastName,
      otp,
    });
    await this.sendEmail({ to: user.email, subject: "Password Reset Request", html });
  }
}

export default EmailService;
