import mongoose, { Document, Schema } from "mongoose";

export interface IErrorLog extends Document {
  timestamp: Date;
  level: "error" | "warn" | "info" | "debug";
  message: string;
  stack?: string;
  errorType: string;
  userId?: string;
  requestId?: string;
  endpoint?: string;
  method?: string;
  userAgent?: string;
  ip?: string;
  requestBody?: any;
  requestQuery?: any;
  requestParams?: any;
  responseStatus?: number;
  environment: string;
  version?: string;
  metadata?: Record<string, any>;
  resolved: boolean;
  resolvedAt?: Date;
  resolvedBy?: string;
  tags?: string[];
}

const errorLogSchema = new Schema<IErrorLog>(
  {
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
    level: {
      type: String,
      enum: ["error", "warn", "info", "debug"],
      default: "error",
      index: true,
    },
    message: {
      type: String,
      required: true,
      index: true,
    },
    stack: {
      type: String,
    },
    errorType: {
      type: String,
      required: true,
      index: true,
    },
    userId: {
      type: String,
      index: true,
    },
    requestId: {
      type: String,
      index: true,
    },
    endpoint: {
      type: String,
      index: true,
    },
    method: {
      type: String,
      index: true,
    },
    userAgent: {
      type: String,
    },
    ip: {
      type: String,
      index: true,
    },
    requestBody: {
      type: Schema.Types.Mixed,
    },
    requestQuery: {
      type: Schema.Types.Mixed,
    },
    requestParams: {
      type: Schema.Types.Mixed,
    },
    responseStatus: {
      type: Number,
      index: true,
    },
    environment: {
      type: String,
      required: true,
      index: true,
    },
    version: {
      type: String,
    },
    metadata: {
      type: Schema.Types.Mixed,
    },
    resolved: {
      type: Boolean,
      default: false,
      index: true,
    },
    resolvedAt: {
      type: Date,
    },
    resolvedBy: {
      type: String,
    },
    tags: [{
      type: String,
      index: true,
    }],
  },
  {
    timestamps: true,
  }
);

// Compound indexes for efficient querying
errorLogSchema.index({ timestamp: -1, level: 1 });
errorLogSchema.index({ environment: 1, timestamp: -1 });
errorLogSchema.index({ resolved: 1, timestamp: -1 });
errorLogSchema.index({ errorType: 1, timestamp: -1 });

errorLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 }); // 30 days

const ErrorLog = mongoose.model<IErrorLog>("ErrorLog", errorLogSchema);

export default ErrorLog; 