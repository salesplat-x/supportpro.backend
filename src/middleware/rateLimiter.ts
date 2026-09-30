import rateLimit from "express-rate-limit";
import env from "../config/env.js";

export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => env.app_env === "test" || /\/payments\/.*webhook$/.test(req.path),
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
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

export const verificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: false, message: "Too many attempts, please try again later." },
  skip: () => env.app_env === "test",
});
