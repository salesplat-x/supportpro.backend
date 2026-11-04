import express from "express";
import request from "supertest";
import type { RequestHandler } from "express";

jest.mock("../src/config/env.js", () => {
  const actual = jest.requireActual<{ default: Record<string, unknown> }>("../src/config/env.js");
  return { __esModule: true, default: { ...actual.default, app_env: "production" } };
});

const hit = (limiter: RequestHandler) => {
  const app = express();
  app.get("/", limiter, (_req, res) => {
    res.sendStatus(200);
  });
  return () => request(app).get("/");
};

describe("people rate limits outside tests", () => {
  it.each([
    ["documentLinkLimiter", 60],
    ["documentCheckLimiter", 10],
    ["peopleAiLimiter", 30],
  ])("%s allows %i requests and refuses the next", async (name, limit) => {
    const limiters = (await import("../src/middleware/rateLimiter.js")) as unknown as Record<
      string,
      RequestHandler
    >;
    const send = hit(limiters[name]!);
    for (let i = 0; i < limit; i += 1) {
      expect((await send()).status).toBe(200);
    }
    expect((await send()).status).toBe(429);
  });
});
