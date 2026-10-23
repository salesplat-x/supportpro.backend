import request from "supertest";
import { createApp } from "../src/app.js";
import { AppDataSource } from "../src/database/dataSource.js";

// The deploy script reads `version` from /health to prove which release is
// serving (and that a rollback really brought the previous one back).
describe("GET /health version", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const originalVersion = process.env.APP_VERSION;

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalVersion === undefined) {
      delete process.env.APP_VERSION;
    } else {
      process.env.APP_VERSION = originalVersion;
    }
  });

  it("reports the commit SHA baked into the image when healthy", async () => {
    process.env.APP_VERSION = SHA;
    jest.spyOn(AppDataSource, "query").mockResolvedValue([{ ok: 1 }]);

    const res = await request(createApp()).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", db: "connected", version: SHA });
  });

  it("still reports the version when the database is down", async () => {
    process.env.APP_VERSION = SHA;
    jest.spyOn(AppDataSource, "query").mockRejectedValue(new Error("connection refused"));

    const res = await request(createApp()).get("/health");

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: "error", db: "disconnected", version: SHA });
  });

  it('reports "unknown" when no version was injected (local dev)', async () => {
    delete process.env.APP_VERSION;
    jest.spyOn(AppDataSource, "query").mockResolvedValue([{ ok: 1 }]);

    const res = await request(createApp()).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: "unknown" });
  });
});
