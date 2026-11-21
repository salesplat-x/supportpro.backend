import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import {
  createTalent,
  createRecruiter,
  createRole,
  createJob,
  createApplication,
  createOrganization,
} from "./helpers/fixtures.js";
import { ApplicationCheckEvent } from "../src/entities/ApplicationCheckEvent.js";
import { ApplicationCheck } from "../src/entities/ApplicationCheck.js";
import { User } from "../src/entities/User.js";
import env from "../src/config/env.js";
import { CHECKS_CONSENT_VERSION } from "../src/services/checkConsent.js";

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
}));

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
}, 120_000);

afterAll(async () => {
  await stopTestDatabase();
});

afterEach(async () => {
  await clearAllTables();
  jest.clearAllMocks();
  env.criminalCheckCountries.length = 0;
});

const as = (token: string | undefined, req: request.Test) =>
  token ? req.set("Authorization", `Bearer ${token}`) : req;

async function setup(talentOverrides: Partial<User> = {}) {
  const { user: owner, token: ownerToken } = await createRecruiter();
  const organization = await createOrganization(owner);
  const job = await createJob(owner, await createRole(), { organizationId: organization.id });
  const { user: member, token: memberToken } = await createRecruiter({
    activeOrganizationId: organization.id,
  });
  const { token: secondMemberToken } = await createRecruiter({
    activeOrganizationId: organization.id,
  });
  const { token: outsiderToken } = await createRecruiter();
  const { user: talent, token: talentToken } = await createTalent({
    firstName: "Amaka",
    lastName: "Obi",
    ...talentOverrides,
  });
  const application = await createApplication(talent, job);
  const base = `/v1/checks/applications/${application.id}`;
  const agree = () =>
    request(app)
      .post(`${base}/consent`)
      .set("Authorization", `Bearer ${talentToken}`)
      .send({ version: CHECKS_CONSENT_VERSION, idKind: "bvn", idNumber: "22334455667" });
  const order = (token: string, type = "identity") =>
    as(token, request(app).post(base)).send({ type });
  const list = (token: string) => as(token, request(app).get(base));
  const result = (token: string | undefined, checkId: string, body: Record<string, unknown>) =>
    as(token, request(app).patch(`/v1/checks/${checkId}/result`)).send(body);
  const history = (token: string, checkId: string) =>
    as(token, request(app).get(`/v1/checks/${checkId}/history`));
  const idNumber = (token: string, checkId: string) =>
    as(token, request(app).get(`/v1/checks/${checkId}/id-number`));
  const events = (checkId: string) =>
    testDataSource.getRepository(ApplicationCheckEvent).find({
      where: { checkId },
      order: { createdAt: "ASC" },
    });
  return {
    owner,
    ownerToken,
    member,
    memberToken,
    secondMemberToken,
    outsiderToken,
    talent,
    talentToken,
    application,
    agree,
    order,
    list,
    result,
    history,
    idNumber,
    events,
  };
}

describe("ordering a check", () => {
  it("records who ordered it in the history", async () => {
    const { agree, order, events, memberToken, member } = await setup();
    await agree();
    const res = await order(memberToken);
    expect(res.status).toBe(201);
    const recorded = await events(res.body.data.id);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ kind: "ordered", actorId: member.id });
  });

  it("refuses a second check of the same type", async () => {
    const { agree, order, memberToken } = await setup();
    await agree();
    expect((await order(memberToken, "education")).status).toBe(201);
    const again = await order(memberToken, "education");
    expect(again.status).toBe(409);
    expect(await testDataSource.getRepository(ApplicationCheck).count()).toBe(1);
  });

  it("refuses criminal checks unless the candidate's country is on the list", async () => {
    const { agree, order, memberToken } = await setup({ country: "Nigeria" });
    await agree();
    const refused = await order(memberToken, "criminal");
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("NOT_AVAILABLE_IN_COUNTRY");
    env.criminalCheckCountries.push("nigeria");
    expect((await order(memberToken, "criminal")).status).toBe(201);
  });

  it("refuses an order after the candidate declined", async () => {
    const { order, memberToken, application, talentToken } = await setup();
    await request(app)
      .post(`/v1/checks/applications/${application.id}/consent/decline`)
      .set("Authorization", `Bearer ${talentToken}`);
    const res = await order(memberToken);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/declined/i);
  });
});

describe("entering a result", () => {
  it("saves an employment result by hand and moves the status", async () => {
    const { agree, order, result, list, memberToken } = await setup();
    await agree();
    const ordered = await order(memberToken, "employment");
    const res = await result(memberToken, ordered.body.data.id, {
      confirmedBy: "Tunde Bakare, Lagos Brand Co",
      confirmedOn: "2026-11-05",
      result: "verified",
      note: "Confirmed she worked there from 2021 to 2025.",
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: "passed",
      confirmedBy: "Tunde Bakare, Lagos Brand Co",
      confirmedOn: "2026-11-05",
      note: "Confirmed she worked there from 2021 to 2025.",
      completedAt: expect.any(String),
    });
    const listed = await list(memberToken);
    expect(listed.body.data.overallStatus).toBe("verified");
  });

  it("stores a flagged and a failed result", async () => {
    const { agree, order, result, memberToken } = await setup();
    await agree();
    const education = await order(memberToken, "education");
    const flagged = await result(memberToken, education.body.data.id, {
      confirmedBy: "Registrar",
      confirmedOn: "2026-11-05",
      result: "flagged",
    });
    expect(flagged.body.data.status).toBe("flagged");
    const failed = await result(memberToken, education.body.data.id, {
      confirmedBy: "Registrar",
      confirmedOn: "2026-11-06",
      result: "failed",
    });
    expect(failed.body.data.status).toBe("failed");
  });

  it("compares the name on the ID with the name the candidate gave", async () => {
    const { agree, order, result, memberToken } = await setup();
    await agree();
    const identity = await order(memberToken, "identity");
    const mismatch = await result(memberToken, identity.body.data.id, {
      nameOnId: "Amaka Ngozi Obi",
      confirmedOn: "2026-11-05",
    });
    expect(mismatch.body.data).toMatchObject({
      status: "failed",
      nameOnId: "Amaka Ngozi Obi",
      nameGiven: "Amaka Obi",
      resultText: "The names do not match",
    });
    const match = await result(memberToken, identity.body.data.id, {
      nameOnId: "  OBI   amaka ",
      confirmedOn: "2026-11-05",
    });
    expect(match.body.data).toMatchObject({ status: "passed", resultText: "The names match" });
  });

  it("rejects missing or wrong fields and a future date", async () => {
    const { agree, order, result, memberToken } = await setup();
    await agree();
    const identity = await order(memberToken, "identity");
    const employment = await order(memberToken, "employment");
    expect(
      (
        await result(memberToken, identity.body.data.id, {
          confirmedOn: "2026-11-05",
          confirmedBy: "x",
          result: "verified",
        })
      ).status
    ).toBe(400);
    expect(
      (
        await result(memberToken, employment.body.data.id, {
          confirmedOn: "2026-11-05",
          nameOnId: "Amaka Obi",
        })
      ).status
    ).toBe(400);
    expect(
      (
        await result(memberToken, employment.body.data.id, {
          confirmedOn: "2026-11-05",
          confirmedBy: "x",
          result: "maybe",
        })
      ).status
    ).toBe(400);
    expect(
      (
        await result(memberToken, employment.body.data.id, {
          confirmedOn: "not a date",
          confirmedBy: "x",
          result: "verified",
        })
      ).status
    ).toBe(400);
    expect(
      (
        await result(memberToken, employment.body.data.id, {
          confirmedOn: "2099-01-01",
          confirmedBy: "x",
          result: "verified",
        })
      ).status
    ).toBe(400);
  });

  it("lets only the orderer or the owner enter a result", async () => {
    const {
      agree,
      order,
      result,
      memberToken,
      secondMemberToken,
      ownerToken,
      outsiderToken,
      talentToken,
    } = await setup();
    await agree();
    const ordered = await order(memberToken, "education");
    const body = { confirmedBy: "Registrar", confirmedOn: "2026-11-05", result: "verified" };
    expect((await result(secondMemberToken, ordered.body.data.id, body)).status).toBe(403);
    expect((await result(outsiderToken, ordered.body.data.id, body)).status).toBe(403);
    expect((await result(talentToken, ordered.body.data.id, body)).status).toBe(403);
    expect((await result(undefined, ordered.body.data.id, body)).status).toBe(401);
    expect((await result(ownerToken, ordered.body.data.id, body)).status).toBe(200);
  });
});

describe("who can read the results", () => {
  it("shows another member the check as restricted, with no status or result", async () => {
    const { agree, order, result, list, memberToken, secondMemberToken, owner } = await setup();
    await agree();
    const ordered = await order(memberToken, "education");
    await result(memberToken, ordered.body.data.id, {
      confirmedBy: "Registrar",
      confirmedOn: "2026-11-05",
      result: "failed",
    });
    const res = await list(secondMemberToken);
    expect(res.status).toBe(200);
    expect(res.body.data.checks).toEqual([
      {
        id: ordered.body.data.id,
        applicationId: expect.any(String),
        type: "education",
        restricted: true,
      },
    ]);
    expect(res.body.data.ownerName).toBe(`${owner.firstName} ${owner.lastName}`.trim());
    expect(JSON.stringify(res.body.data.checks)).not.toMatch(/Registrar|failed/);
  });

  it("lets the owner and the orderer see the full result", async () => {
    const { agree, order, result, list, memberToken, ownerToken } = await setup();
    await agree();
    const ordered = await order(memberToken, "education");
    await result(memberToken, ordered.body.data.id, {
      confirmedBy: "Registrar",
      confirmedOn: "2026-11-05",
      result: "verified",
    });
    for (const token of [memberToken, ownerToken]) {
      const res = await list(token);
      expect(res.body.data.checks[0]).toMatchObject({
        restricted: false,
        status: "passed",
        confirmedBy: "Registrar",
      });
    }
  });

  it("refuses someone outside the company and the candidate", async () => {
    const { list, outsiderToken, talentToken } = await setup();
    expect((await list(outsiderToken)).status).toBe(403);
    expect((await list(talentToken)).status).toBe(403);
  });

  it("writes a viewed line for every read of a finished result, and none for a pending one", async () => {
    const { agree, order, result, list, events, memberToken, ownerToken } = await setup();
    await agree();
    const ordered = await order(memberToken, "education");
    await list(memberToken);
    expect((await events(ordered.body.data.id)).map((e) => e.kind)).toEqual(["ordered"]);
    await result(memberToken, ordered.body.data.id, {
      confirmedBy: "Registrar",
      confirmedOn: "2026-11-05",
      result: "verified",
    });
    await list(memberToken);
    await list(ownerToken);
    const kinds = (await events(ordered.body.data.id)).map((e) => e.kind);
    expect(kinds).toEqual(["ordered", "result_saved", "viewed", "viewed"]);
  });

  it("does not return the result when its view cannot be recorded", async () => {
    const { agree, order, result, list, memberToken } = await setup();
    await agree();
    const ordered = await order(memberToken, "education");
    await result(memberToken, ordered.body.data.id, {
      confirmedBy: "Registrar",
      confirmedOn: "2026-11-05",
      result: "verified",
    });
    const insert = jest
      .spyOn(testDataSource.getRepository(ApplicationCheckEvent).constructor.prototype, "insert")
      .mockRejectedValueOnce(new Error("disk full"));
    const res = await list(memberToken);
    insert.mockRestore();
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("Registrar");
  });
});

describe("check history", () => {
  it("lists every order, change and view with who did it, oldest first", async () => {
    const { agree, order, result, list, history, memberToken, ownerToken, member } = await setup();
    await agree();
    const ordered = await order(memberToken, "education");
    await result(memberToken, ordered.body.data.id, {
      confirmedBy: "Registrar",
      confirmedOn: "2026-11-05",
      result: "verified",
    });
    await list(ownerToken);
    const res = await history(memberToken, ordered.body.data.id);
    expect(res.status).toBe(200);
    expect(res.body.data.events.map((e: { kind: string }) => e.kind)).toEqual([
      "ordered",
      "result_saved",
      "viewed",
    ]);
    expect(res.body.data.events[0].actorName).toBe(`${member.firstName} ${member.lastName}`.trim());
  });

  it("is closed to other members, outsiders and the candidate", async () => {
    const { agree, order, history, memberToken, secondMemberToken, outsiderToken, talentToken } =
      await setup();
    await agree();
    const ordered = await order(memberToken, "education");
    for (const token of [secondMemberToken, outsiderToken, talentToken]) {
      expect((await history(token, ordered.body.data.id)).status).toBe(403);
    }
  });
});

describe("the candidate's ID number", () => {
  it("is shown only to the orderer and the owner, and every view is logged", async () => {
    const { agree, order, idNumber, events, memberToken, ownerToken, secondMemberToken } =
      await setup();
    await agree();
    const identity = await order(memberToken, "identity");
    const ok = await idNumber(memberToken, identity.body.data.id);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ idKind: "bvn", idNumber: "22334455667" });
    expect((await idNumber(ownerToken, identity.body.data.id)).status).toBe(200);
    expect((await idNumber(secondMemberToken, identity.body.data.id)).status).toBe(403);
    const kinds = (await events(identity.body.data.id)).map((e) => e.kind);
    expect(kinds).toEqual(["ordered", "id_number_viewed", "id_number_viewed"]);
  });

  it("is not offered for other checks, and is never in the list or history responses", async () => {
    const { agree, order, idNumber, list, history, memberToken } = await setup();
    await agree();
    const education = await order(memberToken, "education");
    expect((await idNumber(memberToken, education.body.data.id)).status).toBe(404);
    const identity = await order(memberToken, "identity");
    expect(JSON.stringify((await list(memberToken)).body)).not.toContain("22334455667");
    expect(JSON.stringify((await history(memberToken, identity.body.data.id)).body)).not.toContain(
      "22334455667"
    );
  });
});
