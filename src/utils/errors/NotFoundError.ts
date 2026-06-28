import { AppError } from "./AppError.js";

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(404, "RESOURCE_NOT_FOUND", message);
  }
}
