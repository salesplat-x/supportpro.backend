import { AppDataSource } from "../database/dataSource.js";
import { Job } from "../entities/Job.js";
import { Organization } from "../entities/Organization.js";
import { JobStatus } from "../types/enums.js";
import { NotFoundError } from "../utils/errors";
import env from "../config/env.js";

const cdata = (value: string | number | null | undefined): string =>
  `<![CDATA[${String(value ?? "").replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;

const tag = (name: string, value: string | number | null | undefined) =>
  `<${name}>${cdata(value)}</${name}>`;

const jobUrl = (jobId: string) =>
  `${env.website || "https://auxhr.com"}/job/postedjob/${encodeURIComponent(jobId)}`;

const salaryText = (job: Job): string => {
  if (job.minSalary == null && job.maxSalary == null) return "";
  const range =
    job.maxSalary != null && job.maxSalary !== job.minSalary
      ? `${job.minSalary} - ${job.maxSalary}`
      : `${job.minSalary ?? job.maxSalary}`;
  return [range, job.currency, job.compensationPeriod ? `per ${job.compensationPeriod}` : null]
    .filter(Boolean)
    .join(" ");
};

const jobXml = (job: Job, company: string): string =>
  [
    "<job>",
    tag("title", job.role?.name ?? ""),
    tag("date", job.createdAt.toUTCString()),
    tag("referencenumber", job.id),
    tag("url", jobUrl(job.id)),
    tag("company", company),
    tag("city", job.locationCity),
    tag("state", job.locationState),
    tag("country", job.locationCountry),
    tag("description", [job.jobBrief, job.requirements].filter(Boolean).join("\n\n")),
    tag("salary", salaryText(job)),
    tag("experience", job.experienceLevel),
    "</job>",
  ].join("");

export const buildIndeedFeed = async (organizationId: string): Promise<string> => {
  const org = await AppDataSource.getRepository(Organization).findOne({
    where: { id: organizationId },
  });
  if (!org || !org.indeedFeedEnabled) {
    throw new NotFoundError("Job feed not found");
  }

  const jobs = await AppDataSource.getRepository(Job).find({
    where: { organizationId, status: JobStatus.Active },
    relations: { role: true },
    order: { createdAt: "DESC" },
  });

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<source>",
    tag("publisher", org.name),
    tag("publisherurl", env.website || "https://auxhr.com"),
    tag("lastBuildDate", new Date().toUTCString()),
    ...jobs.map((job) => jobXml(job, org.name)),
    "</source>",
  ].join("\n");
};
