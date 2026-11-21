export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly isOperational: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    isOperational = true,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.details = details;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}
