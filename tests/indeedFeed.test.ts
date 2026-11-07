import request from "supertest";
import type { QueryRunner } from "typeorm";
import { DOMParser } from "@xmldom/xmldom";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { createRecruiter, createRole, createJob, createOrganization } from "./helpers/fixtures.js";
import { Organization } from "../src/entities/Organization.js";
import { JobStatus } from "../src/types/enums.js";
import { AddIndeedFeedSwitchToOrganizations1789001600000 } from "../src/migrations/1789001600000-AddIndeedFeedSwitchToOrganizations.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  })),
}));

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
});

async function companyWithJobs(feedOn = true, name = "Acme & Sons") {
  const { user: owner, token } = await createRecruiter();
  const org = await createOrganization(owner, { name, indeedFeedEnabled: feedOn });
  const { user: refreshed } = { user: { ...owner, activeOrganizationId: org.id } };
  const role = await createRole();
  const open = await createJob(refreshed, role, {
    organizationId: org.id,
    jobBrief: "Look after our clients <daily> & keep them happy. ]]> Not a trick.",
    locationCity: "Lagos",
    locationState: "Lagos",
    locationCountry: "Nigeria",
    minSalary: 300000,
    maxSalary: 450000,
    currency: "NGN",
  });
  const draft = await createJob(refreshed, role, {
    organizationId: org.id,
    status: JobStatus.Draft,
  });
  const closed = await createJob(refreshed, role, {
    organizationId: org.id,
    status: JobStatus.Closed,
  });
  return { org, token, role, open, draft, closed };
}

const feed = (orgId: string) => request(app).get(`/v1/organizations/${orgId}/jobs.xml`);

const parse = (xml: string) => new DOMParser().parseFromString(xml, "text/xml");
const text = (el: Element, tag: string) => el.getElementsByTagName(tag)[0]?.textContent ?? null;

describe("Day 8 — Indeed XML job feed", () => {
  it("serves the company's open jobs in Indeed's XML format, with no login", async () => {
    const { org, open } = await companyWithJobs();

    const res = await feed(org.id);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/xml/);
    const doc = parse(res.text);
    expect(doc.documentElement.tagName).toBe("source");
    expect(text(doc.documentElement, "publisher")).toBe("Acme & Sons");
    const jobs = Array.from(doc.getElementsByTagName("job"));
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(text(job, "referencenumber")).toBe(open.id);
    expect(text(job, "title")).toBeTruthy();
    expect(text(job, "company")).toBe("Acme & Sons");
    expect(text(job, "url")).toMatch(new RegExp(`/job/postedjob/${open.id}$`));
    expect(text(job, "city")).toBe("Lagos");
    expect(text(job, "state")).toBe("Lagos");
    expect(text(job, "country")).toBe("Nigeria");
    expect(text(job, "description")).toBe(
      "Look after our clients <daily> & keep them happy. ]]> Not a trick."
    );
    expect(text(job, "salary")).toMatch(/300000.*450000.*NGN/);
    expect(text(job, "date")).toBeTruthy();
  });

  it("leaves out draft and closed jobs and other companies' jobs", async () => {
    const { org, draft, closed } = await companyWithJobs();
    const other = await companyWithJobs(true, "Other Co");

    const res = await feed(org.id);

    expect(res.status).toBe(200);
    expect(res.text).not.toContain(draft.id);
    expect(res.text).not.toContain(closed.id);
    expect(res.text).not.toContain(other.open.id);
  });

  it("is off by default: 404 until the company switches it on", async () => {
    const { user: owner } = await createRecruiter();
    const org = await createOrganization(owner);
    expect(org.indeedFeedEnabled).toBe(false);

    expect((await feed(org.id)).status).toBe(404);
  });

  it("404 for an unknown company and 400 for a bad id", async () => {
    expect((await feed("8b0d7a43-6f0e-4a54-9a8b-0d2f2f0b2a11")).status).toBe(404);
    expect((await feed("not-a-uuid")).status).toBe(400);
  });

  it("an empty feed is still valid XML", async () => {
    const { user: owner } = await createRecruiter();
    const org = await createOrganization(owner, { indeedFeedEnabled: true });

    const res = await feed(org.id);

    expect(res.status).toBe(200);
    const doc = parse(res.text);
    expect(doc.documentElement.tagName).toBe("source");
    expect(doc.getElementsByTagName("job")).toHaveLength(0);
  });

  it("the company owner switches the feed on and off with PATCH /v1/organizations/:id", async () => {
    const { org, token } = await companyWithJobs(false);

    const on = await request(app)
      .patch(`/v1/organizations/${org.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ indeedFeedEnabled: true });
    expect(on.status).toBe(200);
    expect((await feed(org.id)).status).toBe(200);

    const bad = await request(app)
      .patch(`/v1/organizations/${org.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ indeedFeedEnabled: "yes" });
    expect(bad.status).toBe(400);

    await request(app)
      .patch(`/v1/organizations/${org.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ indeedFeedEnabled: false });
    const saved = await testDataSource.getRepository(Organization).findOneByOrFail({ id: org.id });
    expect(saved.indeedFeedEnabled).toBe(false);
    expect((await feed(org.id)).status).toBe(404);
  });
});

describe("AddIndeedFeedSwitchToOrganizations migration", () => {
  it("adds the switch (off by default) and removes it on down", async () => {
    const queries: string[] = [];
    const runner = {
      query: (sql: string) => Promise.resolve(void queries.push(sql)),
    } as unknown as QueryRunner;
    await new AddIndeedFeedSwitchToOrganizations1789001600000().up(runner);
    expect(queries).toEqual([
      `ALTER TABLE "organizations" ADD "indeed_feed_enabled" boolean NOT NULL DEFAULT false`,
    ]);
    queries.length = 0;
    await new AddIndeedFeedSwitchToOrganizations1789001600000().down(runner);
    expect(queries).toEqual([`ALTER TABLE "organizations" DROP COLUMN "indeed_feed_enabled"`]);
  });
});
