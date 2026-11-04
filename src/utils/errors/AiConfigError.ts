import { AppError } from "./AppError.js";

/** The AI setup is wrong (missing key, refused key, unknown model), so retrying can't help until it's fixed. */
export class AiConfigError extends AppError {
  constructor(message: string) {
    super(503, "AI_NOT_CONFIGURED", message);
  }
}
