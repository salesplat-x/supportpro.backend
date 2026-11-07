import type { Request } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import env from "../config/env.js";
import { getClientIp } from "../utils/clientIp.js";

export const clientIpKey = (req: Request): string => ipKeyGenerator(getClientIp(req));

export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  skip: (req) => env.app_env === "test" || /\/payments\/.*webhook$/.test(req.path),
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  message: { status: false, message: "Too many attempts, please try again later." },
  skip: () => env.app_env === "test",
});

/**
 * A scout run can fire up to 50 gpt-4o calls, so it needs a tighter ceiling than the
 * general limiter. Keyed per user rather than per IP so one company behind a shared
 * NAT can't exhaust another's allowance.
 *
 * The key never falls back to the IP: express-rate-limit rejects an IP-derived key
 * that doesn't normalise IPv6 (ERR_ERL_KEY_GEN_IPV6), and every route using this
 * limiter is behind `validateAccess`, so `req.user` is always populated.
 */
export const scoutRunLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? "unauthenticated",
  message: {
    status: false,
    message: "You've started a lot of scouting runs in the last hour — please try again later.",
  },
  skip: () => env.app_env === "test",
});

/**
 * Every voice request costs a transcription, a completion and a synthesis, so it gets a
 * per-user ceiling. Like the scout limiter it relies on `loginRequired` running first.
 */
export const voiceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? "unauthenticated",
  message: {
    status: false,
    message: "You've sent a lot of voice messages recently — please try again in a few minutes.",
  },
  skip: () => env.app_env === "test",
});

/** Each support message can start an AI draft, so one account can send 10 an hour. */
export const supportSubmitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? "unauthenticated",
  message: {
    status: false,
    message: "You've sent a lot of messages in the last hour. Please try again later.",
  },
  skip: () => env.app_env === "test",
});

export const verificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  message: { status: false, message: "Too many attempts, please try again later." },
  skip: () => env.app_env === "test",
});

export const staffWriteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? "unauthenticated",
  message: {
    status: false,
    message: "You've added or invited a lot of staff in the last hour — please try again later.",
  },
  skip: () => env.app_env === "test",
});

export const documentLinkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  message: { status: false, message: "Too many attempts, please try again later." },
  skip: () => env.app_env === "test",
});

export const documentCheckLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  message: { status: false, message: "Too many attempts, please try again later." },
  skip: () => env.app_env === "test",
});

export const peopleAiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? "unauthenticated",
  message: {
    status: false,
    message: "You've asked the AI a lot in the last hour. Please try again later.",
  },
  skip: () => env.app_env === "test",
});

/** Each CV upload costs an embedding and a CV reading, so one talent can upload 20 an hour. */
export const cvUploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? "unauthenticated",
  message: {
    status: false,
    message: "You've uploaded a lot of CVs in the last hour. Please try again later.",
  },
  skip: () => env.app_env === "test",
});
