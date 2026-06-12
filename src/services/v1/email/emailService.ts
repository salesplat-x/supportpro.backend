import logger from "../../../config/logger";
import { Roles } from "../../../typings/customs";
import { IUser } from "../../../typings/user";
import BrevoProvider from "./providers/brevo.provider";
import { renderTemplate } from "./template";
import { EmailPayload, EmailProvider } from "./types";

class EmailService {
  private provider: EmailProvider;

  constructor(provider: EmailProvider = new BrevoProvider()) {
    this.provider = provider;
  }

  async sendEmail(payload: EmailPayload): Promise<void> {
    try {
      await this.provider.send(payload);
    } catch (error) {
      logger.logErrorMessage(`Failed to send email to ${payload.to}: ${error}`);
    }
  }

  async sendWelcome(user: IUser): Promise<void> {
    const template = user.userRole === Roles.Recruiter ? "welcomeRecruiter" : "welcome";
    const html = renderTemplate(template, { firstName: user.firstName });
    await this.sendEmail({ to: user.email, subject: "Welcome to AuxHR", html });
  }

  async sendPasswordReset(user: IUser, otp: string): Promise<void> {
    const html = renderTemplate("password-reset", {
      firstName: user.firstName,
      lastName: user.lastName,
      otp,
    });
    await this.sendEmail({ to: user.email, subject: "Password Reset Request", html });
  }
}

export default EmailService;
