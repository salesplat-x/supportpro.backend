import { AppError } from "./AppError.js";

export class AuthenticationError extends AppError {
  constructor(message = "Authentication required") {
    super(401, "AUTHENTICATION_ERROR", message);
  }
}
