/**
 * "Can manage people" setting on company members — owner-only, never for the owner's own row.
 */

import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { OrganizationMember } from "../src/entities";
import { addMember, authHeader, setupCompany } from "./helpers/company.js";
import { apiData } from "./helpers/http.js";

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
});

describe("can manage people setting", () => {
  it("is off for a new member", async () => {
    const { org } = await setupCompany();
    const member = await addMember(org);
    const row = await testDataSource
      .getRepository(OrganizationMember)
      .findOneByOrFail({ id: member.memberId });
    expect(row.canManagePeople).toBe(false);
  });

  it("lets only the owner switch the setting on or off", async () => {
    const { owner, org } = await setupCompany();
    const hr = await addMember(org, { canManagePeople: true });
    const plain = await addMember(org, { firstName: "Pat", lastName: "Plain" });
    const url = `/v1/organizations/${org.id}/members/${plain.memberId}`;

    const byHr = await request(app)
      .patch(url)
      .set(authHeader(hr.token))
      .send({ canManagePeople: true });
    expect(byHr.status).toBe(403);

    const byOwner = await request(app)
      .patch(url)
      .set(authHeader(owner.token))
      .send({ canManagePeople: true });
    expect(byOwner.status).toBe(200);
    const row = await testDataSource
      .getRepository(OrganizationMember)
      .findOneByOrFail({ id: plain.memberId });
    expect(row.canManagePeople).toBe(true);
  });

  it("rejects the owner's own row, another company's member and bad input", async () => {
    const { owner, org } = await setupCompany();
    const ownerRow = await testDataSource.getRepository(OrganizationMember).save({
      userId: owner.user.id,
      organizationId: org.id,
      workEmail: owner.user.email,
      role: "owner",
    });
    const other = await setupCompany("Globex Ltd");
    const foreign = await addMember(other.org);
    const patch = (memberId: string, body: Record<string, unknown>) =>
      request(app)
        .patch(`/v1/organizations/${org.id}/members/${memberId}`)
        .set(authHeader(owner.token))
        .send(body);

    expect((await patch(ownerRow.id, { canManagePeople: true })).status).toBe(400);
    expect((await patch(foreign.memberId, { canManagePeople: true })).status).toBe(404);
    expect((await patch("not-a-uuid", { canManagePeople: true })).status).toBe(400);
    expect((await patch(foreign.memberId, { canManagePeople: "maybe" })).status).toBe(400);
  });

  it("shows the setting on the owner's members list", async () => {
    const { owner, org } = await setupCompany();
    await addMember(org, { canManagePeople: true });
    const res = await request(app)
      .get(`/v1/organizations/${org.id}/members`)
      .set(authHeader(owner.token));
    const { members } = apiData<{ members: { canManagePeople: boolean }[] }>(res);
    expect(members.some((m) => m.canManagePeople === true)).toBe(true);
  });
});

describe("member job title", () => {
  const patchMember = (orgId: string, memberId: string, token: string, body: unknown) =>
    request(app)
      .patch(`/v1/organizations/${orgId}/members/${memberId}`)
      .set(authHeader(token))
      .send(body as object);

  const storedTitle = async (memberId: string) =>
    (await testDataSource.getRepository(OrganizationMember).findOneByOrFail({ id: memberId }))
      .title;

  it("the owner sets a trimmed title, it shows on the list, and clearing it saves null", async () => {
    const { owner, org } = await setupCompany();
    const member = await addMember(org);

    const res = await patchMember(org.id, member.memberId, owner.token, { title: "  HR lead " });
    expect(res.status).toBe(200);
    expect(apiData<{ member: { title: string } }>(res).member.title).toBe("HR lead");

    const list = await request(app)
      .get(`/v1/organizations/${org.id}/members`)
      .set(authHeader(owner.token));
    const { members } = apiData<{ members: { id: string; title: string | null }[] }>(list);
    expect(members.find((m) => m.id === member.memberId)?.title).toBe("HR lead");

    await patchMember(org.id, member.memberId, owner.token, { title: "   " }).expect(200);
    expect(await storedTitle(member.memberId)).toBeNull();
  });

  it("changing the title leaves Can manage people alone, and the other way round", async () => {
    const { owner, org } = await setupCompany();
    const member = await addMember(org, { canManagePeople: true });

    await patchMember(org.id, member.memberId, owner.token, { title: "Recruiter" }).expect(200);
    await patchMember(org.id, member.memberId, owner.token, { canManagePeople: false }).expect(200);

    const row = await testDataSource
      .getRepository(OrganizationMember)
      .findOneByOrFail({ id: member.memberId });
    expect(row).toMatchObject({ title: "Recruiter", canManagePeople: false });
  });

  it("the owner can title their own row", async () => {
    const { owner, org } = await setupCompany();
    const ownerRow = await testDataSource.getRepository(OrganizationMember).save({
      userId: owner.user.id,
      organizationId: org.id,
      workEmail: owner.user.email,
      role: "owner",
    });

    await patchMember(org.id, ownerRow.id, owner.token, { title: "Founder" }).expect(200);
    expect(await storedTitle(ownerRow.id)).toBe("Founder");
  });

  it("a member who isn't the owner → 403, even with Can manage people", async () => {
    const { org } = await setupCompany();
    const hr = await addMember(org, { canManagePeople: true });
    const other = await addMember(org, { firstName: "Bola" });

    await patchMember(org.id, other.memberId, hr.token, { title: "Boss" }).expect(403);
    expect(await storedTitle(other.memberId)).toBeNull();
  });

  it("a member of another company → 404", async () => {
    const { owner, org } = await setupCompany();
    const other = await setupCompany("Globex Ltd");
    const foreign = await addMember(other.org);

    await patchMember(org.id, foreign.memberId, owner.token, { title: "HR lead" }).expect(404);
    expect(await storedTitle(foreign.memberId)).toBeNull();
  });

  it.each([
    ["a title over 60 characters", { title: "x".repeat(61) }],
    ["a title that is not text", { title: 42 }],
    ["an empty body", {}],
  ])("rejects %s → 400", async (_label, body) => {
    const { owner, org } = await setupCompany();
    const member = await addMember(org);

    await patchMember(org.id, member.memberId, owner.token, body).expect(400);
  });

  it("accepts a title of exactly 60 characters", async () => {
    const { owner, org } = await setupCompany();
    const member = await addMember(org);

    await patchMember(org.id, member.memberId, owner.token, { title: "x".repeat(60) }).expect(200);
  });
});
