import rateLimit from "express-rate-limit";
import env from "../config/env.js";

export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => env.app_env === "test",
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: false, message: "Too many attempts, please try again later." },
  skip: () => env.app_env === "test",
});

export const verificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: false, message: "Too many attempts, please try again later." },
  skip: () => env.app_env === "test",
});
