import { AppError } from "./AppError.js";

export class AuthorizationError extends AppError {
  constructor(message = "Access denied") {
    super(403, "AUTHORIZATION_ERROR", message);
  }
}
