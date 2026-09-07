import { ValidationError } from "../src/utils/errors/ValidationError.js";
import { NotFoundError } from "../src/utils/errors/NotFoundError.js";
import {
  backoffMs,
  durableFailureUpdate,
  isDurableRetryable,
  MAX_DURABLE_ATTEMPTS,
} from "../src/utils/durableJobs.js";

describe("durableJobs helpers", () => {
  it("backs off 30s, 1m, 2m, 4m, then caps at 8m", () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(3)).toBe(120_000);
    expect(backoffMs(4)).toBe(240_000);
    expect(backoffMs(5)).toBe(480_000);
    expect(backoffMs(6)).toBe(480_000);
  });

  it("retries LLM ValidationErrors and network failures, but not 404s", () => {
    expect(isDurableRetryable(new ValidationError("Error with LLM"))).toBe(true);
    expect(isDurableRetryable(new Error("ECONNRESET"))).toBe(true);
    expect(isDurableRetryable(Object.assign(new Error("rate limited"), { status: 429 }))).toBe(
      true
    );
    expect(isDurableRetryable(new NotFoundError("Job not found"))).toBe(false);
    expect(isDurableRetryable(Object.assign(new Error("bad key"), { status: 401 }))).toBe(false);
  });

  it("marks a retryable failure pending until max attempts, then exhausted", () => {
    const first = durableFailureUpdate(0, new ValidationError("Error with LLM"));
    expect(first.attempts).toBe(1);
    expect(first.exhausted).toBe(false);
    expect(first.nextRetryAt).not.toBeNull();

    const last = durableFailureUpdate(
      MAX_DURABLE_ATTEMPTS - 1,
      new ValidationError("Error with LLM")
    );
    expect(last.attempts).toBe(MAX_DURABLE_ATTEMPTS);
    expect(last.exhausted).toBe(true);
    expect(last.nextRetryAt).toBeNull();
  });
});
