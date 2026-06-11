import fs from "fs";
import path from "path";
import nodemailer, { Transporter } from "nodemailer";
import { compile } from "handlebars";
import { IUser } from "../../typings/user";
import env from "../../config/env";
import { Roles } from "../../typings/customs";

class Email {
  private user: string;
  private from: string;
  private password: string;

  constructor() {
    this.user = env.email_username!;
    this.password = env.email_password!;
    this.from = `AuxHR <${env.email_username}>`;
  }

  private newTransport(): Transporter {
    return nodemailer.createTransport({
      host: env.email_host,
      port: Number(env.email_port),
      secure: Number(env.email_port) === 465,
      auth: {
        user: this.user,
        pass: this.password,
      },
    });
  }

  private async sendHtml(to: string, template: string, subject: string, data: Record<string, any>) {
    const htmlTemplate = fs.readFileSync(
      path.join(__dirname, `../../../templates/${template}.html`),
      "utf-8"
    );
    const html = compile(htmlTemplate)(data);

    const mailOptions = {
      from: this.from,
      to,
      subject,
      html,
    };

    //@TODO switch to brevo
    // await this.newTransport().sendMail(mailOptions);
  }

  async sendOtp(user: IUser, otp: string) {
    await this.sendHtml(user.email, "send-otp", `Verify your AuxHR account`, {
      firstName: user.firstName,
      otp,
    });
  }

  async sendWelcome(user: IUser) {
    const template = user.userRole === Roles.Recruiter ? "welcomeRecruiter" : "welcome";
    await this.sendHtml(user.email, template, `Welcome to AuxHR`, {
      firstName: user.firstName,
    });
  }

  // async sendPasswordReset(user: IUser, resetLink: string) {
  //   await this.sendHtml(user.email, "password-reset", "Password Reset Request", {
  //     firstName: user.firstName,
  //     lastName: user.lastName,
  //     resetLink,
  //   });
  // }

  async sendPasswordReset(user: IUser, otp: string) {
    await this.sendHtml(user.email, "password-reset", "Password Reset Request", {
      firstName: user.firstName,
      lastName: user.lastName,
      otp,
    });
  }
}

export default Email;
