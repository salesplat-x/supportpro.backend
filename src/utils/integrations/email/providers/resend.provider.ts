import { Resend } from "resend";
import env from "../../../../config/env.js";
import type { EmailPayload, EmailProvider } from "../types.js";

const resend = new Resend(env.resend_api_key);

class ResendProvider implements EmailProvider {
  async send({
    to,
    subject,
    html,
    text,
    replyTo,
    tags,
    attachments,
    idempotencyKey,
    headers,
  }: EmailPayload): Promise<void> {
    const { error } = await resend.emails.send(
      {
        from: `${env.resend_sender_name} <${env.resend_sender_email}>`,
        to,
        subject,
        html,
        text,
        replyTo: replyTo ?? "support@auxhr.com",
        tags,
        attachments,
        headers,
      },
      idempotencyKey ? { idempotencyKey } : undefined
    );

    if (error) {
      throw new Error(`Resend API error: ${error.message}`);
    }
  }
}

export default ResendProvider;
