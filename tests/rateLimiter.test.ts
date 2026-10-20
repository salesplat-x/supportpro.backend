import express, { Request } from "express";
import rateLimit from "express-rate-limit";
import request from "supertest";
import { clientIpKey } from "../src/middleware/rateLimiter.js";

const fakeRequest = (headers: Record<string, string | string[]>, ip = "172.17.0.1"): Request =>
  ({ headers, ip, socket: { remoteAddress: ip } }) as unknown as Request;

describe("clientIpKey", () => {
  it("keys on Cloudflare's CF-Connecting-IP when it is a valid address", () => {
    expect(clientIpKey(fakeRequest({ "cf-connecting-ip": "102.89.34.10" }))).toBe("102.89.34.10");
  });

  it("falls back to req.ip when the header is missing", () => {
    expect(clientIpKey(fakeRequest({}))).toBe("172.17.0.1");
  });

  it.each([
    ["empty", ""],
    ["not an address", "not-an-ip"],
    ["comma-joined duplicates", "102.89.34.10, 41.58.1.2"],
  ])("falls back to req.ip when the header is %s", (_label, value) => {
    expect(clientIpKey(fakeRequest({ "cf-connecting-ip": value }))).toBe("172.17.0.1");
  });

  it("ignores a header sent more than once", () => {
    expect(clientIpKey(fakeRequest({ "cf-connecting-ip": ["102.89.34.10", "41.58.1.2"] }))).toBe(
      "172.17.0.1"
    );
  });

  it("groups IPv6 clients by their /56 subnet", () => {
    const first = clientIpKey(fakeRequest({ "cf-connecting-ip": "2001:db8:abcd:12ff::1" }));
    const sameSubnet = clientIpKey(fakeRequest({ "cf-connecting-ip": "2001:db8:abcd:1200::9" }));

    expect(first).toBe(sameSubnet);
    expect(first).toContain("/56");
  });
});

describe("rate limiting keyed by clientIpKey", () => {
  const buildApp = () => {
    const app = express();
    app.use(rateLimit({ windowMs: 60_000, limit: 1, keyGenerator: clientIpKey }));
    app.get("/", (_req, res) => {
      res.send("ok");
    });
    return app;
  };

  it("gives each Cloudflare client its own allowance behind one proxy address", async () => {
    const app = buildApp();

    const first = await request(app).get("/").set("CF-Connecting-IP", "102.89.34.10");
    const second = await request(app).get("/").set("CF-Connecting-IP", "41.58.1.2");
    const repeat = await request(app).get("/").set("CF-Connecting-IP", "102.89.34.10");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(repeat.status).toBe(429);
  });
});
