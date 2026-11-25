import { getErrorStatus } from "../../retry.js";

// Error codes providers send when the account has no credit left, as opposed to a rate limit.
const CREDIT_CODES = new Set([
  "insufficient_quota",
  "billing_hard_limit_reached",
  "insufficient_balance",
  "quota_exceeded",
  "payment_required",
]);

const CREDIT_TEXT =
  /insufficient[_ ](quota|balance|credits?|funds)|exceeded your current quota|credit balance|out of credits|run out of credits|used all available credits|spending limit|billing hard limit|payment required/i;

// Gemini says "exceeded your current quota" for per-minute limits too, so anything that names a
// rate stays a rate limit. When unsure, it is a rate limit: retrying one is harmless.
const RATE_TEXT = /per[ _-]?(minute|second|day)|PerMinute|PerDay|rate[ _-]?limit|requests per/i;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;

const strings = (...values: unknown[]): string[] =>
  values.filter((value): value is string => typeof value === "string");

/** Codes and messages from the OpenAI SDK, axios responses and ElevenLabs' `detail` body. */
const describe = (err: unknown): { codes: string[]; text: string } => {
  const e = asRecord(err) ?? {};
  const inner = asRecord(e.error);
  const data = asRecord(asRecord(e.response)?.data);
  const dataError = asRecord(data?.error);
  const detail = asRecord(data?.detail);
  const codes = strings(
    e.code,
    e.type,
    inner?.code,
    inner?.type,
    dataError?.code,
    dataError?.type,
    detail?.status,
    detail?.code
  ).map((code) => code.toLowerCase());
  const text = strings(
    e.message,
    inner?.message,
    dataError?.message,
    detail?.message,
    typeof data?.detail === "string" ? data.detail : undefined,
    typeof data?.message === "string" ? data.message : undefined
  ).join(" ");
  return { codes, text };
};

/** The provider refused the call because the account is out of credit or over its spending cap. */
export const isOutOfCreditError = (err: unknown): boolean => {
  const status = getErrorStatus(err);
  if (status === 402) return true;
  const { codes, text } = describe(err);
  if (codes.some((code) => CREDIT_CODES.has(code))) return true;
  if (status !== undefined && ![401, 403, 429].includes(status)) return false;
  return CREDIT_TEXT.test(text) && !RATE_TEXT.test(text);
};

/** Status and code only, safe to store and show: provider messages can quote part of the key. */
export const creditErrorSummary = (err: unknown): string => {
  const status = getErrorStatus(err);
  const [code] = describe(err).codes;
  return (
    [status, code]
      .filter((part) => part !== undefined)
      .join(" ")
      .slice(0, 64) || "refused"
  );
};
