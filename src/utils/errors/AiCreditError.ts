import { AiConfigError } from "./AiConfigError.js";

/**
 * The provider refused the call because the account is out of credit. Users see a neutral
 * message; admins see which provider on the AI usage page.
 */
export class AiCreditError extends AiConfigError {
  constructor() {
    super("AI features are briefly unavailable. Please try again later.");
  }
}
