import express from "express";
import request from "supertest";
import { QueryFailedError } from "typeorm";
import { asyncHandler } from "../src/middleware/asyncHandler.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { DatabaseError, NotFoundError } from "../src/utils/errors";

const queryFailure = (code: string, detail: string) =>
  new QueryFailedError(
    'DELETE FROM "users" WHERE "id" = $1',
    ["user-id"],
    Object.assign(new Error(`violates constraint on "users"`), { code, detail })
  );

const appThrowing = (err: unknown, action?: string) => {
  const app = express();
  app.get(
    "/",
    asyncHandler(() => Promise.reject(err), action)
  );
  app.use(errorHandler);
  return app;
};

describe("errorHandler", () => {
  it("says which action failed when a referenced row blocks a delete", async () => {
    const res = await request(
      appThrowing(
        queryFailure("23503", 'Key (id)=(user-id) is still referenced from table "payments".'),
        "delete recruiter"
      )
    ).get("/");

    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({
      code: "DATABASE_ERROR",
      message: "Could not delete recruiter. Other records still depend on it.",
    });
  });

  it("explains a missing referenced row", async () => {
    const res = await request(
      appThrowing(
        queryFailure("23503", 'Key (role_id)=(role-id) is not present in table "roles".'),
        "create job"
      )
    ).get("/");

    expect(res.body.error.message).toBe(
      "Could not create job. Something it refers to no longer exists."
    );
  });

  it("explains a duplicate without leaking SQL", async () => {
    const res = await request(
      appThrowing(queryFailure("23505", "Key (email)=(a@b.com) already exists."), "create account")
    ).get("/");

    expect(res.body.error.message).toBe(
      "Could not create account. A record with these details already exists."
    );
    expect(JSON.stringify(res.body)).not.toMatch(/DELETE FROM|users|constraint/);
  });

  it("names the action for unexpected non-database errors", async () => {
    const res = await request(
      appThrowing(new Error("Cannot read properties of undefined (reading 'id')"), "load job")
    ).get("/");

    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({
      code: "INTERNAL_ERROR",
      message: "Could not load job. Please try again.",
    });
  });

  it("names the action for non-operational app errors", async () => {
    const res = await request(appThrowing(new DatabaseError(), "update company")).get("/");

    expect(res.body.error).toEqual({
      code: "DATABASE_ERROR",
      message: "Could not update company. Please try again.",
    });
  });

  it("falls back to a generic sentence when the route has no action", async () => {
    const res = await request(appThrowing(new Error("boom"))).get("/");

    expect(res.body.error.message).toBe("Something went wrong. Please try again.");
  });

  it("keeps hand-written operational messages", async () => {
    const res = await request(
      appThrowing(new NotFoundError("Recruiter not found"), "delete recruiter")
    ).get("/");

    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe("Recruiter not found");
  });
});
