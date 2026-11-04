import { EntityManager } from "typeorm";
import { Application } from "../entities/Application.js";
import { JobStatus } from "../types/enums.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A verdict that finally arrives on an old application (a backfill, a late retry) isn't news. */
const MAX_APPLICATION_AGE_DAYS = 30;

export const NOTIFICATION_TYPE_AI_MATCH = "ai_match";

/**
 * Runs inside the transaction that saves the verdict, so a verdict and its alerts land
 * together. `DO NOTHING` matters: a unique violation here would abort that transaction
 * and lose the verdict itself.
 */
export const notifyTeamOfHighMatch = async (
  manager: EntityManager,
  applicationId: string
): Promise<void> => {
  const application = await manager.findOne(Application, {
    where: { id: applicationId },
    relations: { job: { role: true }, talent: true },
  });
  if (!application || application.job.status !== JobStatus.Active) return;

  const ageMs = Date.now() - new Date(application.createdAt).getTime();
  if (ageMs > MAX_APPLICATION_AGE_DAYS * DAY_MS) return;

  const { job, talent } = application;
  const name = `${talent.firstName ?? ""} ${talent.lastName ?? ""}`.trim() || "An applicant";
  const jobTitle = job.role?.name ?? "your job";

  await manager.query(
    `INSERT INTO notifications (user_id, title, message, type, link, organization_id, dedupe_key)
     SELECT u.id, $1::varchar, $2::text, $3::varchar, $4::varchar, $5::uuid, $6::varchar
     FROM users u
     WHERE u.active = true AND u.id IN (
       SELECT user_id FROM organization_members WHERE organization_id = $5::uuid
       UNION
       SELECT owner_id FROM organizations WHERE id = $5::uuid
       UNION
       SELECT $7::uuid WHERE $5::uuid IS NULL
     )
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [
      "New high match",
      `${name} is a high match for ${jobTitle}.`,
      NOTIFICATION_TYPE_AI_MATCH,
      `/recruiterDashboard/singleJobPost/${job.id}?applicationId=${application.id}`,
      job.organizationId,
      `${NOTIFICATION_TYPE_AI_MATCH}:${application.id}`,
      job.postedById,
    ]
  );
};
