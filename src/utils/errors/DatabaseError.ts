import { AppError } from "./AppError.js";

export class DatabaseError extends AppError {
  constructor(message = "A database error occurred") {
    super(500, "DATABASE_ERROR", message, false);
  }
}
