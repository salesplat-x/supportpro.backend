import request from "supertest";
import { Repository } from "typeorm";
import { createApp } from "../src/app.js";
import env from "../src/config/env.js";
import { Job } from "../src/entities/Job.js";
import { Organization } from "../src/entities/Organization.js";
import { clearFeedCache, slugify } from "../src/services/jobFeed.js";
import { JobStatus } from "../src/types/enums.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { apiData } from "./helpers/http.js";
import { addMember, authHeader, setupCompany } from "./helpers/company.js";
import { createJob, createRole } from "./helpers/fixtures.js";

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
}, 120_000);

afterAll(async () => {
  await stopTestDatabase();
});

afterEach(async () => {
  clearFeedCache();
  jest.restoreAllMocks();
  await clearAllTables();
});

const setFeed = (orgId: string, token: string, indeedFeedEnabled: unknown) =>
  request(app)
    .patch(`/v1/organizations/${orgId}`)
    .set(authHeader(token))
    .send({ indeedFeedEnabled });

const slugOf = async (orgId: string) =>
  (await testDataSource.getRepository(Organization).findOneByOrFail({ id: orgId })).feedSlug;

const fetchFeed = (slug: string) => request(app).get(`/v1/feed/${slug}.xml`);

const companyWithFeed = async (name = "Kosana Tech Ltd") => {
  const { owner, org } = await setupCompany(name);
  await setFeed(org.id, owner.token, true).expect(200);
  return { owner, org, slug: (await slugOf(org.id))! };
};

const spyOnJobFinds = () => {
  const spy = jest.spyOn(Repository.prototype, "find");
  return () => spy.mock.contexts.filter((repo) => (repo as Repository<Job>).target === Job).length;
};

const textOf = (xml: string, tagName: string) =>
  [...xml.matchAll(new RegExp(`<${tagName}>([^<]*)</${tagName}>`, "g"))].map((m) => m[1]!);

describe("slugify", () => {
  it.each([
    ["Kosana Tech Ltd", "kosana-tech-ltd"],
    ["  Café & Co.  ", "cafe-co"],
    ["!!!", "company"],
    ["x".repeat(100), "x".repeat(60)],
  ])("%s → %s", (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });
});

describe("turning the job feed on and off", () => {
  it("the first switch-on gives the company a slug from its name", async () => {
    const { slug, org } = await companyWithFeed();

    expect(slug).toBe("kosana-tech-ltd");
    const stored = await testDataSource.getRepository(Organization).findOneByOrFail({ id: org.id });
    expect(stored.indeedFeedEnabled).toBe(true);
  });

  it("keeps the slug when the company is renamed or the feed is switched off and on", async () => {
    const { owner, org, slug } = await companyWithFeed();

    await request(app)
      .patch(`/v1/organizations/${org.id}`)
      .set(authHeader(owner.token))
      .send({ name: "Kosana Group" })
      .expect(200);
    await setFeed(org.id, owner.token, false).expect(200);
    await setFeed(org.id, owner.token, true).expect(200);

    expect(await slugOf(org.id)).toBe(slug);
  });

  it("two companies with the same name get different slugs", async () => {
    const first = await companyWithFeed("Acme Ltd");
    const second = await companyWithFeed("Acme Ltd");

    expect(first.slug).toBe("acme-ltd");
    expect(second.slug).toBe("acme-ltd-2");
  });

  it("two companies with the same name switching on at once still get different slugs", async () => {
    const a = await setupCompany("Acme Ltd");
    const b = await setupCompany("Acme Ltd");

    const results = await Promise.all([
      setFeed(a.org.id, a.owner.token, true),
      setFeed(b.org.id, b.owner.token, true),
    ]);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const slugs = [await slugOf(a.org.id), await slugOf(b.org.id)];
    expect(new Set(slugs).size).toBe(2);
  });

  it("switching on twice at once gives the company one slug", async () => {
    const { owner, org } = await setupCompany("Acme Ltd");

    const results = await Promise.all([
      setFeed(org.id, owner.token, true),
      setFeed(org.id, owner.token, true),
    ]);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await slugOf(org.id)).toBe("acme-ltd");
  });

  it("only the owner can switch it → 403 for a member", async () => {
    const { org } = await setupCompany();
    const hr = await addMember(org, { canManagePeople: true });

    await setFeed(org.id, hr.token, true).expect(403);

    expect(await slugOf(org.id)).toBeNull();
  });

  it("rejects a value that isn't true or false → 400", async () => {
    const { owner, org } = await setupCompany();

    await setFeed(org.id, owner.token, "yes").expect(400);
  });
});

describe("GET /v1/feed/:slug.xml", () => {
  it("lists only this company's open jobs as Indeed XML", async () => {
    const { owner, org, slug } = await companyWithFeed();
    const role = await createRole("Data Analyst");
    const open = await createJob(owner.user, role, { organizationId: org.id });
    await createJob(owner.user, role, { organizationId: org.id, status: JobStatus.Draft });
    await createJob(owner.user, role, { organizationId: org.id, status: JobStatus.Closed });
    const other = await setupCompany("Other Ltd");
    await createJob(other.owner.user, role, { organizationId: other.org.id });

    const res = await fetchFeed(slug).expect(200);

    expect(res.headers["content-type"]).toContain("application/xml");
    expect(res.text.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    expect(textOf(res.text, "referencenumber")).toEqual([open.id]);
    expect(textOf(res.text, "title")).toEqual(["Data Analyst"]);
    expect(textOf(res.text, "company")).toEqual(["Kosana Tech Ltd"]);
    expect(textOf(res.text, "url")).toEqual([`${env.website}/apply/${open.id}?source=indeed`]);
    expect(res.text).not.toContain(owner.user.email);
    expect(res.text).not.toContain(org.id);
  });

  it("escapes markup and drops characters XML can't hold", async () => {
    const { owner, org, slug } = await companyWithFeed();
    const role = await createRole('R&D <Lead> "QA" ]]>');
    await createJob(owner.user, role, {
      organizationId: org.id,
      jobBrief: "Tom & Jerry's <script>alert(1)</script>\u0007\u001F team",
    });

    const res = await fetchFeed(slug).expect(200);

    expect(textOf(res.text, "title")).toEqual(["R&amp;D &lt;Lead&gt; &quot;QA&quot; ]]&gt;"]);
    const [description] = textOf(res.text, "description");
    expect(description).toBe("Tom &amp; Jerry&apos;s &lt;script&gt;alert(1)&lt;/script&gt; team");
    const controlChars = Array.from(res.text).filter((char) => {
      const code = char.codePointAt(0)!;
      return code < 0x20 && code !== 0x9 && code !== 0xa && code !== 0xd;
    });
    expect(controlChars).toEqual([]);
  });

  it("a switched-off feed and an unknown slug give the same 404", async () => {
    const { owner, org, slug } = await companyWithFeed();
    await setFeed(org.id, owner.token, false).expect(200);

    const off = await fetchFeed(slug);
    const unknown = await fetchFeed("no-such-company");

    expect(off.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(off.body).toEqual(unknown.body);
  });

  it("a company that never switched the feed on has no feed", async () => {
    await setupCompany("Quiet Ltd");

    await fetchFeed("quiet-ltd").expect(404);
  });

  it("rejects a file name that isn't a slug.xml", async () => {
    const res = await request(app).get("/v1/feed/..%2Fsecret");

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("serves the cached feed for an hour, so new jobs show up on the next build", async () => {
    const { owner, org, slug } = await companyWithFeed();
    const role = await createRole("Data Analyst");
    await createJob(owner.user, role, { organizationId: org.id });
    const jobFinds = spyOnJobFinds();
    const first = await fetchFeed(slug).expect(200);

    await createJob(owner.user, role, { organizationId: org.id });
    const second = await fetchFeed(slug).expect(200);

    expect(second.text).toBe(first.text);
    expect(textOf(second.text, "referencenumber")).toHaveLength(1);
    expect(jobFinds()).toBe(1);

    clearFeedCache(slug);
    const rebuilt = await fetchFeed(slug).expect(200);
    expect(textOf(rebuilt.text, "referencenumber")).toHaveLength(2);
  });

  it("switching the feed off stops a cached feed at once", async () => {
    const { owner, org, slug } = await companyWithFeed();
    await fetchFeed(slug).expect(200);

    await setFeed(org.id, owner.token, false).expect(200);

    await fetchFeed(slug).expect(404);
  });

  it("many requests for a cold feed build it once", async () => {
    const { owner, org, slug } = await companyWithFeed();
    const role = await createRole("Data Analyst");
    await createJob(owner.user, role, { organizationId: org.id });
    const jobFinds = spyOnJobFinds();

    const results = await Promise.all(Array.from({ length: 5 }, () => fetchFeed(slug)));

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.text)).size).toBe(1);
    expect(jobFinds()).toBe(1);
  });
});

describe("GET /v1/organizations/:id/feed", () => {
  it("shows a member whether the feed is on, its link and the open job count", async () => {
    const { owner, org, slug } = await companyWithFeed();
    const member = await addMember(org);
    const role = await createRole("Data Analyst");
    await createJob(owner.user, role, { organizationId: org.id });
    await createJob(owner.user, role, { organizationId: org.id, status: JobStatus.Draft });
    const original = env.publicApiUrl;
    Object.assign(env, { publicApiUrl: "https://api.auxhr.com" });

    try {
      const res = await request(app)
        .get(`/v1/organizations/${org.id}/feed`)
        .set(authHeader(member.token))
        .expect(200);

      expect(apiData<{ feed: unknown }>(res).feed).toEqual({
        enabled: true,
        url: `https://api.auxhr.com/v1/feed/${slug}.xml`,
        openJobs: 1,
        updatedAt: null,
      });
    } finally {
      Object.assign(env, { publicApiUrl: original });
    }
  });

  it("shows when the feed was last built", async () => {
    const { owner, org, slug } = await companyWithFeed();
    await fetchFeed(slug).expect(200);

    const res = await request(app)
      .get(`/v1/organizations/${org.id}/feed`)
      .set(authHeader(owner.token))
      .expect(200);

    expect(apiData<{ feed: { updatedAt: string | null } }>(res).feed.updatedAt).not.toBeNull();
  });

  it("gives no link while the feed is off", async () => {
    const { owner, org } = await setupCompany();

    const res = await request(app)
      .get(`/v1/organizations/${org.id}/feed`)
      .set(authHeader(owner.token))
      .expect(200);

    expect(apiData<{ feed: unknown }>(res).feed).toMatchObject({ enabled: false, url: null });
  });

  it("someone from another company → 403", async () => {
    const { org } = await setupCompany();
    const { owner: outsider } = await setupCompany("Other Ltd");

    await request(app)
      .get(`/v1/organizations/${org.id}/feed`)
      .set(authHeader(outsider.token))
      .expect(403);
  });
});
