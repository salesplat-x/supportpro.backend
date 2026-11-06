export interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  tags?: Array<{ name: string; value: string }>;
  attachments?: Array<{ filename: string; content: Buffer }>;
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

export interface EmailProvider {
  send(payload: EmailPayload): Promise<void>;
}
