import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { Conversation } from "../src/entities/Conversation.js";
import { Message } from "../src/entities/Message.js";
import { Organization } from "../src/entities/Organization.js";
import { createOrganization, createTalent, createScoutCandidate } from "./helpers/fixtures.js";
import { createRecruiter } from "./helpers/scout.js";

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
  assessTalentFit: jest.fn(),
  scoutAssessCandidate: jest.fn(),
  scoutShortlistSummary: jest.fn(),
  draftApplicantMessage: jest.fn(),
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
});

const onPlan = async (organizationId: string, plan: string) => {
  await testDataSource.getRepository(Organization).update(organizationId, { billingPlan: plan });
};

/** Upserts, because sending a first message has already created this period's row. */
const useOutreach = async (organizationId: string, used: number) => {
  await testDataSource.query(
    `INSERT INTO "feature_usage_counters"
       ("organization_id", "feature_key", "period_start", "count", "createdAt", "updatedAt")
     VALUES ($1, 'direct_outreach', date_trunc('month', now())::date, $2, now(), now())
     ON CONFLICT ("organization_id", "feature_key", "period_start")
     DO UPDATE SET "count" = EXCLUDED."count"`,
    [organizationId, used]
  );
};

const sendDirect = (token: string, recipientId: string, content = "Hi — are you open to a chat?") =>
  request(app)
    .post("/v1/messages/")
    .set("Authorization", `Bearer ${token}`)
    .send({ recipient: recipientId, content });

describe("direct recruiter outreach", () => {
  it("lets a recruiter open a conversation with a talent they have no application with", async () => {
    const { user, token } = await createRecruiter();
    await createOrganization(user);
    const talent = await createTalent();

    const res = await sendDirect(token, talent.user.id);

    expect(res.status).toBeLessThan(300);
    expect(await testDataSource.getRepository(Conversation).count()).toBe(1);
    expect(await testDataSource.getRepository(Message).count()).toBe(1);
  });

  it("meters only the message that opens the thread", async () => {
    const { user, token } = await createRecruiter();
    const org = await createOrganization(user);
    await onPlan(org.id, "sme_basic");
    const talent = await createTalent();

    await sendDirect(token, talent.user.id, "First contact");
    await sendDirect(token, talent.user.id, "Following up");
    await sendDirect(token, talent.user.id, "And again");

    const rows: Array<{ count: number }> = await testDataSource.query(
      `SELECT "count" FROM "feature_usage_counters"
        WHERE "organization_id" = $1 AND "feature_key" = 'direct_outreach'`,
      [org.id]
    );
    expect(rows[0]!.count).toBe(1);
    expect(await testDataSource.getRepository(Message).count()).toBe(3);
  });

  it("402s once the outreach allowance is exhausted", async () => {
    const { user, token } = await createRecruiter();
    const org = await createOrganization(user);
    await onPlan(org.id, "sme_basic");
    // sme_basic allows 5 first contacts a month.
    await useOutreach(org.id, 5);
    const talent = await createTalent();

    const res = await sendDirect(token, talent.user.id);

    expect(res.status).toBe(402);
    expect(res.body.error.featureKey).toBe("direct_outreach");
    expect(await testDataSource.getRepository(Conversation).count()).toBe(0);
  });

  it("still allows replies in an existing thread after the allowance runs out", async () => {
    const { user, token } = await createRecruiter();
    const org = await createOrganization(user);
    await onPlan(org.id, "sme_basic");
    const talent = await createTalent();

    await sendDirect(token, talent.user.id, "First contact");
    await useOutreach(org.id, 5);

    const res = await sendDirect(token, talent.user.id, "A later reply");

    expect(res.status).toBeLessThan(300);
    expect(await testDataSource.getRepository(Message).count()).toBe(2);
  });

  it("still refuses to let a talent cold-message a recruiter", async () => {
    const { user } = await createRecruiter();
    await createOrganization(user);
    const talent = await createTalent();

    const res = await request(app)
      .post("/v1/messages/")
      .set("Authorization", `Bearer ${talent.token}`)
      .send({ recipient: user.id, content: "Hire me" });

    expect(res.status).toBe(403);
    expect(await testDataSource.getRepository(Conversation).count()).toBe(0);
  });

  it("lets a talent reply once the recruiter has opened the thread", async () => {
    const { user, token } = await createRecruiter();
    await createOrganization(user);
    const talent = await createTalent();

    await sendDirect(token, talent.user.id, "Opening message");
    const res = await request(app)
      .post("/v1/messages/")
      .set("Authorization", `Bearer ${talent.token}`)
      .send({ recipient: user.id, content: "Yes, happy to chat" });

    expect(res.status).toBeLessThan(300);
    expect(await testDataSource.getRepository(Message).count()).toBe(2);
  });

  it("refuses a message to yourself", async () => {
    const { user, token } = await createRecruiter();
    await createOrganization(user);

    const res = await sendDirect(token, user.id);
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/scout/candidates/:candidateId/message", () => {
  it("messages a sourced candidate who has since registered as a talent", async () => {
    const { user, token } = await createRecruiter();
    await createOrganization(user);
    const talent = await createTalent();
    const candidate = await createScoutCandidate({
      emailNormalized: talent.user.email,
      fullName: "Registered Later",
    });

    const res = await request(app)
      .post(`/v1/scout/candidates/${candidate.id}/message`)
      .set("Authorization", `Bearer ${token}`)
      .send({ content: "Saw your CV — are you open to a chat?" });

    expect(res.status).toBeLessThan(300);
    expect(await testDataSource.getRepository(Message).count()).toBe(1);
  });

  it("explains how to reach a candidate with no account, rather than failing opaquely", async () => {
    const { user, token } = await createRecruiter();
    await createOrganization(user);
    const candidate = await createScoutCandidate({
      emailNormalized: "no-account@example.com",
      fullName: "Ada Obi",
    });

    const res = await request(app)
      .post(`/v1/scout/candidates/${candidate.id}/message`)
      .set("Authorization", `Bearer ${token}`)
      .send({ content: "Hello" });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("no-account@example.com");
    expect(res.body.error.message).toContain("Ada Obi");
  });

  it("400s a candidate with no email on record", async () => {
    const { user, token } = await createRecruiter();
    await createOrganization(user);
    const candidate = await createScoutCandidate({ emailNormalized: null });

    const res = await request(app)
      .post(`/v1/scout/candidates/${candidate.id}/message`)
      .set("Authorization", `Bearer ${token}`)
      .send({ content: "Hello" });

    expect(res.status).toBe(400);
  });

  it("rejects an empty message", async () => {
    const { user, token } = await createRecruiter();
    await createOrganization(user);
    const candidate = await createScoutCandidate();

    const res = await request(app)
      .post(`/v1/scout/candidates/${candidate.id}/message`)
      .set("Authorization", `Bearer ${token}`)
      .send({ content: "   " });

    expect(res.status).toBe(400);
  });

  it("404s an unknown candidate", async () => {
    const { user, token } = await createRecruiter();
    await createOrganization(user);

    const res = await request(app)
      .post("/v1/scout/candidates/11111111-1111-4111-8111-111111111111/message")
      .set("Authorization", `Bearer ${token}`)
      .send({ content: "Hello" });

    expect(res.status).toBe(404);
  });

  it("403s a talent trying to message a candidate", async () => {
    const talent = await createTalent();
    const candidate = await createScoutCandidate();

    const res = await request(app)
      .post(`/v1/scout/candidates/${candidate.id}/message`)
      .set("Authorization", `Bearer ${talent.token}`)
      .send({ content: "Hello" });

    expect(res.status).toBe(403);
  });

  it("401s without a token", async () => {
    const candidate = await createScoutCandidate();
    const res = await request(app)
      .post(`/v1/scout/candidates/${candidate.id}/message`)
      .send({ content: "Hello" });
    expect(res.status).toBe(401);
  });
});
