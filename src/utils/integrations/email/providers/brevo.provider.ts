import axios from "axios";
import env from "../../../../config/env.js";
import type { EmailPayload, EmailProvider } from "../types.js";

const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";

class BrevoProvider implements EmailProvider {
  async send({ to, subject, html }: EmailPayload): Promise<void> {
    await axios.post(
      BREVO_API_URL,
      {
        sender: { name: env.brevo_sender_name, email: env.brevo_sender_email },
        to: [{ email: to }],
        subject,
        htmlContent: html,
      },
      {
        headers: {
          "api-key": env.brevo_api_key,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      }
    );
  }
}

export default BrevoProvider;
