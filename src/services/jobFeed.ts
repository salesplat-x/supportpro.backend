import { EntityManager } from "typeorm";
import env from "../config/env.js";
import { AppDataSource } from "../database/dataSource.js";
import { Job } from "../entities/Job.js";
import { Organization } from "../entities/Organization.js";
import { OrganizationMember } from "../entities/OrganizationMember.js";
import { CompensationPeriod, EmploymentType, JobStatus } from "../types/enums.js";
import { resultRows } from "../utils/durableJobs.js";
import { AppError, AuthorizationError, NotFoundError } from "../utils/errors";

export const FEED_TTL_MS = 60 * 60 * 1000;
export const MAX_CACHED_FEEDS = 1000;
export const MAX_FEED_JOBS = 1000;
const MAX_SLUG_LENGTH = 60;
const SLUG_ATTEMPTS = 5;
const SLUG_PATTERN = /^[a-z0-9-]{1,80}$/;

interface FeedEntry {
  xml: string;
  generatedAt: Date;
  expiresAt: number;
}

const cache = new Map<string, FeedEntry>();
const building = new Map<string, Promise<FeedEntry>>();

export const clearFeedCache = (slug?: string | null): void => {
  if (slug === undefined) {
    cache.clear();
    return;
  }
  if (slug) cache.delete(slug);
};

const remember = (slug: string, entry: FeedEntry): void => {
  cache.delete(slug);
  while (cache.size >= MAX_CACHED_FEEDS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(slug, entry);
};

const freshEntry = (slug: string): FeedEntry | undefined => {
  const entry = cache.get(slug);
  if (!entry) return undefined;
  if (entry.expiresAt > Date.now()) return entry;
  cache.delete(slug);
  return undefined;
};

export const slugify = (name: string): string => {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug || "company";
};

const isUniqueViolation = (error: unknown) =>
  (error as { code?: string; driverError?: { code?: string } })?.code === "23505" ||
  (error as { driverError?: { code?: string } })?.driverError?.code === "23505";

const firstFreeSlug = async (em: EntityManager, base: string): Promise<string> => {
  const rows = resultRows(
    await em.query(
      `SELECT "feed_slug" FROM "organizations" WHERE "feed_slug" = $1 OR "feed_slug" LIKE $2`,
      [base, `${base}-%`]
    )
  ) as { feed_slug: string }[];
  const taken = new Set(rows.map((row) => row.feed_slug));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
};

/** Gives the company its feed slug once. Safe to call from two requests at the same time. */
export const ensureFeedSlug = async (organization: Organization): Promise<string> => {
  if (organization.feedSlug) return organization.feedSlug;
  const base = slugify(organization.name);

  for (let attempt = 1; attempt <= SLUG_ATTEMPTS; attempt++) {
    try {
      const candidate = await firstFreeSlug(AppDataSource.manager, base);
      const claimed = resultRows(
        await AppDataSource.query(
          `UPDATE "organizations" SET "feed_slug" = $2 WHERE "id" = $1 AND "feed_slug" IS NULL RETURNING "feed_slug"`,
          [organization.id, candidate]
        )
      ) as { feed_slug: string }[];
      if (claimed[0]) return claimed[0].feed_slug;

      const current = await AppDataSource.getRepository(Organization).findOneByOrFail({
        id: organization.id,
      });
      if (current.feedSlug) return current.feedSlug;
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === SLUG_ATTEMPTS) throw error;
    }
  }
  throw new AppError(503, "FEED_SLUG_UNAVAILABLE", "Couldn't create the feed link. Try again.");
};

const isXmlChar = (codePoint: number): boolean =>
  codePoint === 0x9 ||
  codePoint === 0xa ||
  codePoint === 0xd ||
  (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
  (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
  (codePoint >= 0x10000 && codePoint <= 0x10ffff);

const dropNonXmlChars = (value: string): string =>
  Array.from(value)
    .filter((char) => isXmlChar(char.codePointAt(0)!))
    .join("");

export const escapeXml = (value: string): string =>
  dropNonXmlChars(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const tag = (name: string, value: string | number | null | undefined): string =>
  value === null || value === undefined || value === ""
    ? ""
    : `<${name}>${escapeXml(String(value))}</${name}>`;

const JOB_TYPES: Record<EmploymentType, string> = {
  [EmploymentType.FullTime]: "fulltime",
  [EmploymentType.PartTime]: "parttime",
  [EmploymentType.Contract]: "contract",
  [EmploymentType.Internship]: "internship",
};

const salaryText = (job: Job): string | null => {
  if (!job.minSalary && !job.maxSalary) return null;
  const range =
    job.maxSalary && job.maxSalary !== job.minSalary
      ? `${job.minSalary} - ${job.maxSalary}`
      : `${job.minSalary || job.maxSalary}`;
  const period = job.compensationPeriod === CompensationPeriod.Monthly ? "per month" : "per year";
  return [job.currency, range, period].filter(Boolean).join(" ");
};

export const applyUrl = (jobId: string): string => `${env.website}/apply/${jobId}?source=indeed`;

const jobXml = (job: Job, companyName: string): string =>
  [
    "<job>",
    tag("title", job.role?.name),
    tag("date", job.createdAt.toUTCString()),
    tag("referencenumber", job.id),
    tag("url", applyUrl(job.id)),
    tag("company", companyName),
    tag("city", job.locationCity),
    tag("state", job.locationState),
    tag("country", job.locationCountry),
    tag("description", [job.jobBrief, job.requirements].filter(Boolean).join("\n\n")),
    tag("salary", salaryText(job)),
    tag("jobtype", JOB_TYPES[job.employmentType]),
    job.workMode?.includes("remote") ? tag("remotetype", "Fully remote") : "",
    "</job>",
  ].join("");

const buildEntry = async (organization: Organization): Promise<FeedEntry> => {
  const jobs = await AppDataSource.getRepository(Job).find({
    where: { organizationId: organization.id, status: JobStatus.Active },
    relations: { role: true },
    order: { createdAt: "DESC" },
    take: MAX_FEED_JOBS,
  });
  const generatedAt = new Date();
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<source>",
    tag("publisher", "AuxHR"),
    tag("publisherurl", env.website),
    tag("lastBuildDate", generatedAt.toUTCString()),
    ...jobs.map((job) => jobXml(job, organization.name)),
    "</source>",
  ].join("\n");
  return { xml, generatedAt, expiresAt: generatedAt.getTime() + FEED_TTL_MS };
};

const feedNotFound = () => new NotFoundError("Feed not found");

/** The public feed. A missing company and a switched-off feed look the same from outside. */
export const getFeedXml = async (slug: string): Promise<string> => {
  if (!SLUG_PATTERN.test(slug)) throw feedNotFound();

  const organization = await AppDataSource.getRepository(Organization).findOne({
    where: { feedSlug: slug },
  });
  if (!organization?.indeedFeedEnabled) throw feedNotFound();

  const cached = freshEntry(slug);
  if (cached) return cached.xml;

  let pending = building.get(slug);
  if (!pending) {
    pending = buildEntry(organization)
      .then((entry) => {
        remember(slug, entry);
        return entry;
      })
      .finally(() => building.delete(slug));
    building.set(slug, pending);
  }

  try {
    return (await pending).xml;
  } catch {
    throw new AppError(503, "FEED_UNAVAILABLE", "The feed is unavailable right now. Try again.");
  }
};

export const feedUrl = (slug: string | null): string | null =>
  slug && env.publicApiUrl ? `${env.publicApiUrl}/v1/feed/${slug}.xml` : null;

export interface FeedStatus {
  enabled: boolean;
  url: string | null;
  openJobs: number;
  updatedAt: Date | null;
}

export const getFeedStatus = async (
  userId: string,
  organizationId: string
): Promise<FeedStatus> => {
  const organization = await AppDataSource.getRepository(Organization).findOne({
    where: { id: organizationId },
  });
  if (!organization) throw new NotFoundError("Company not found");
  const isMember =
    organization.ownerId === userId ||
    (await AppDataSource.getRepository(OrganizationMember).exists({
      where: { userId, organizationId },
    }));
  if (!isMember) throw new AuthorizationError("You don't belong to this company");

  const openJobs = await AppDataSource.getRepository(Job).count({
    where: { organizationId, status: JobStatus.Active },
  });
  const cached = organization.feedSlug ? freshEntry(organization.feedSlug) : undefined;

  return {
    enabled: organization.indeedFeedEnabled,
    url: organization.indeedFeedEnabled ? feedUrl(organization.feedSlug) : null,
    openJobs,
    updatedAt: cached?.generatedAt ?? null,
  };
};
