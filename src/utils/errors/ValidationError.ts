import { AppError } from "./AppError.js";

export class ValidationError extends AppError {
  readonly fields?: Record<string, string>;

  constructor(message: string, fields?: Record<string, string>) {
    super(400, "VALIDATION_ERROR", message);
    this.fields = fields;
  }
}
