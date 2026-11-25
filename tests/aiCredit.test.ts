/**
 * Pure unit tests: which provider errors mean "out of credit", as opposed to a rate limit.
 */

import { creditErrorSummary, isOutOfCreditError } from "../src/utils/integrations/ai/credit.js";
import { isRetryableError } from "../src/utils/retry.js";

const sdkError = (status: number, body: Record<string, unknown>) =>
  Object.assign(new Error(`${status} ${String(body["message"] ?? "")}`), {
    status,
    code: body["code"],
    type: body["type"],
    error: body,
  });

const openAiQuota = sdkError(429, {
  message: "You exceeded your current quota, please check your plan and billing details.",
  type: "insufficient_quota",
  code: "insufficient_quota",
});
const openAiRateLimit = sdkError(429, {
  message: "Rate limit reached for gpt-5.6-luna on requests per min (RPM): Limit 500.",
  type: "requests",
  code: "rate_limit_exceeded",
});
const deepSeekBalance = sdkError(402, { message: "Insufficient Balance" });
const xAiCredits = sdkError(403, {
  message: "Your team has either used all available credits or reached its monthly spending limit.",
});
const geminiPerMinute = sdkError(429, {
  message:
    "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.",
});
const elevenLabsQuota = Object.assign(new Error("Request failed with status code 401"), {
  response: {
    status: 401,
    data: { detail: { status: "quota_exceeded", message: "This request exceeds your quota." } },
  },
});
const elevenLabsBadKey = Object.assign(new Error("Request failed with status code 401"), {
  response: {
    status: 401,
    data: { detail: { status: "invalid_api_key", message: "Invalid key" } },
  },
});

describe("isOutOfCreditError", () => {
  it.each([
    ["OpenAI insufficient_quota", openAiQuota],
    ["DeepSeek 402 Insufficient Balance", deepSeekBalance],
    ["xAI credits used up", xAiCredits],
    ["ElevenLabs quota_exceeded", elevenLabsQuota],
  ])("is true for %s", (_label, err) => {
    expect(isOutOfCreditError(err)).toBe(true);
  });

  it.each([
    ["an OpenAI rate limit", openAiRateLimit],
    ["a Gemini per-minute quota", geminiPerMinute],
    ["an ElevenLabs bad key", elevenLabsBadKey],
    ["a server error", sdkError(500, { message: "Internal error" })],
    ["a timeout", Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })],
  ])("is false for %s", (_label, err) => {
    expect(isOutOfCreditError(err)).toBe(false);
  });
});

describe("retries", () => {
  it("stops retrying an account that is out of credit, but still retries a rate limit", () => {
    expect(isRetryableError(openAiQuota)).toBe(false);
    expect(isRetryableError(openAiRateLimit)).toBe(true);
  });
});

describe("creditErrorSummary", () => {
  it("keeps only the status and code, never the provider's message", () => {
    expect(creditErrorSummary(openAiQuota)).toBe("429 insufficient_quota");
    expect(creditErrorSummary(deepSeekBalance)).toBe("402");
    expect(creditErrorSummary(elevenLabsQuota)).toBe("401 quota_exceeded");
  });
});
