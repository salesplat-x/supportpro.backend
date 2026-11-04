import { randomUUID } from "crypto";
import path from "path";
import { EntityManager, In, IsNull } from "typeorm";
import env from "../config/env.js";
import { AppDataSource } from "../database/dataSource.js";
import { Notification } from "../entities/Notification.js";
import { Organization } from "../entities/Organization.js";
import { StaffActivityType } from "../entities/StaffActivity.js";
import { StaffChecklistTask } from "../entities/StaffChecklistTask.js";
import {
  CompletionEvidenceFile,
  CompletionRequestStatus,
  StaffCompletionRequest,
} from "../entities/StaffCompletionRequest.js";
import { GoalStatus, StaffGoal } from "../entities/StaffGoal.js";
import { StaffGoalProgressEvent } from "../entities/StaffGoalProgressEvent.js";
import { StaffHrAssignment } from "../entities/StaffHrAssignment.js";
import { StaffMember } from "../entities/StaffMember.js";
import { User } from "../entities/User.js";
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from "../utils/errors";
import EmailService from "../utils/integrations/email/emailService.js";
import {
  deleteSpacesObjectQuietly,
  getFromSpaces,
  spacesKeyFor,
  uploadPrivateToSpaces,
} from "../utils/integrations/spaces.js";
import logger from "../utils/logger.js";
import { isOwnRecord } from "./hrAssignments.js";
import { assertCanViewStaff } from "./peopleAccess.js";
import {
  type PerformanceScope,
  assertWritable,
  findOwnStaff,
  lockOwnStaff,
  lockScopedStaff,
  logPerformanceRead,
  openPerformance,
} from "./performanceAccess.js";
import { type GoalView, toGoalView } from "./goals.js";
import { activityEntry, recordActivities } from "./staffAudit.js";
import { fullNameOf, isUniqueViolation } from "./staffRecord.js";

export const MAX_EVIDENCE_FILES = 3;
export const MAX_EVIDENCE_LINKS = 5;
export const MAX_COMPLETION_SUMMARY = 4000;
export const MAX_REVIEW_NOTE = 2000;

const MAX_LINK_LENGTH = 2048;
const MAX_FILE_NAME_LENGTH = 200;

const NOTIFICATION_TYPE_COMPLETION = "completion_request";

export type CompletionItemType = "goal" | "task";

export interface CompletionRequestView {
  id: string;
  itemType: CompletionItemType;
  itemId: string;
  itemTitle: string;
  summary: string;
  links: string[];
  files: Array<Pick<CompletionEvidenceFile, "id" | "name" | "mimeType" | "size">>;
  status: CompletionRequestStatus;
  reviewNote: string | null;
  reviewedByName: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

const requestsRepo = (em: EntityManager = AppDataSource.manager) =>
  em.getRepository(StaffCompletionRequest);

const toRequestView = (
  request: StaffCompletionRequest,
  titles: Map<string, string>
): CompletionRequestView => {
  const itemId = (request.goalId ?? request.taskId)!;
  return {
    id: request.id,
    itemType: request.goalId ? "goal" : "task",
    itemId,
    itemTitle: titles.get(itemId) ?? "",
    summary: request.summary,
    links: request.links,
    // The storage key stays on the server, so nobody can try to reach the file directly.
    files: request.files.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size })),
    status: request.status,
    reviewNote: request.reviewNote,
    reviewedByName: request.reviewedByName,
    reviewedAt: request.reviewedAt,
    createdAt: request.createdAt,
  };
};

/** The newest request for each goal and task, so a returned one shows until it's resubmitted. */
export const loadLatestRequests = async (staffIds: string[]): Promise<CompletionRequestView[]> => {
  if (staffIds.length === 0) return [];
  const [rows, goals, tasks] = await Promise.all([
    requestsRepo().find({
      where: { staffId: In(staffIds) },
      order: { createdAt: "DESC" },
    }),
    AppDataSource.getRepository(StaffGoal).find({
      where: { staffId: In(staffIds) },
      select: { id: true, title: true },
    }),
    AppDataSource.getRepository(StaffChecklistTask).find({
      where: { staffId: In(staffIds) },
      select: { id: true, title: true },
    }),
  ]);
  const titles = new Map([...goals, ...tasks].map((item) => [item.id, item.title]));
  const seen = new Set<string>();
  return rows
    .filter((row) => {
      const itemId = (row.goalId ?? row.taskId)!;
      if (seen.has(itemId)) return false;
      seen.add(itemId);
      return true;
    })
    .map((row) => toRequestView(row, titles));
};

export interface ReviewResult {
  goal: GoalView | null;
  task: StaffChecklistTask | null;
  request: CompletionRequestView | null;
}

/** Sent back after each decision, so the page can update without a read that writes a log line. */
const reviewResult = async (
  staffId: string,
  item: { goalId: string } | { taskId: string }
): Promise<ReviewResult> => {
  const itemId = "goalId" in item ? item.goalId : item.taskId;
  const [goal, task, requests] = await Promise.all([
    "goalId" in item
      ? AppDataSource.getRepository(StaffGoal).findOne({ where: { id: item.goalId } })
      : null,
    "taskId" in item
      ? AppDataSource.getRepository(StaffChecklistTask).findOne({ where: { id: item.taskId } })
      : null,
    loadLatestRequests([staffId]),
  ]);
  return {
    goal: goal ? toGoalView(goal) : null,
    task,
    request: requests.find((request) => request.itemId === itemId) ?? null,
  };
};

const includesBytes = (buffer: Buffer, text: string) => buffer.includes(text, 0, "latin1");

/** Reads the file's real type from its bytes, because the browser's claim can say anything. */
export const detectEvidenceType = (
  buffer: Buffer
): { mimeType: string; extension: string } | null => {
  if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") {
    return { mimeType: "application/pdf", extension: ".pdf" };
  }
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: "image/png", extension: ".png" };
  }
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return { mimeType: "image/jpeg", extension: ".jpg" };
  }
  if (
    buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) &&
    includesBytes(buffer, "word/document.xml")
  ) {
    return {
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      extension: ".docx",
    };
  }
  return null;
};

const cleanFileName = (name: string, extension: string): string => {
  const base = path
    .basename(name.replace(/\\/g, "/"))
    .replace(/\.[^.]*$/, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f"<>|:*?/\\]/g, "")
    .trim()
    .slice(0, MAX_FILE_NAME_LENGTH);
  return `${base || "evidence"}${extension}`;
};

const cleanLinks = (links: string[]): string[] =>
  [...new Set(links.map((link) => link.trim()).filter(Boolean))].map((link) => {
    let parsed: URL;
    try {
      parsed = new URL(link);
    } catch {
      throw new ValidationError(`${link} isn't a valid link`);
    }
    if (
      parsed.protocol !== "https:" ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      link.length > MAX_LINK_LENGTH
    ) {
      throw new ValidationError("Links must start with https:// and can't include a password");
    }
    return parsed.toString();
  });

const prepareFiles = (
  files: Express.Multer.File[],
  organizationId: string
): Array<{ meta: CompletionEvidenceFile; buffer: Buffer }> =>
  files.map((file) => {
    const type = file.size > 0 ? detectEvidenceType(file.buffer) : null;
    if (!type) {
      throw new ValidationError("Upload evidence as a PDF, JPG, PNG or Word (.docx) file");
    }
    const key = spacesKeyFor("completion-evidence", organizationId, `evidence${type.extension}`);
    return {
      buffer: file.buffer,
      meta: {
        id: randomUUID(),
        key,
        name: cleanFileName(file.originalname, type.extension),
        mimeType: type.mimeType,
        size: file.size,
      },
    };
  });

const deleteEvidence = async (keys: string[], reason: string): Promise<void> => {
  await Promise.all(keys.map((key) => deleteSpacesObjectQuietly(key, reason)));
};

/** For deleting a goal, task or company: read these first, then delete them after the commit. */
export const evidenceKeysFor = async (
  where: { goalId: string } | { taskId: string } | { organizationId: string },
  em: EntityManager = AppDataSource.manager
): Promise<string[]> => {
  const query = requestsRepo(em).createQueryBuilder("request");
  if ("organizationId" in where) {
    query
      .innerJoin(StaffMember, "staff", "staff.id = request.staffId")
      .where("staff.organizationId = :organizationId", where);
  } else if ("goalId" in where) {
    query.where("request.goalId = :goalId", where);
  } else {
    query.where("request.taskId = :taskId", where);
  }
  const rows = await query.getMany();
  return rows.flatMap((row) => row.files.map((file) => file.key));
};

export const deleteEvidenceQuietly = (keys: string[]): Promise<void> =>
  deleteEvidence(keys, "removed completion evidence");

const company = (em: EntityManager, organizationId: string) =>
  em.getRepository(Organization).findOneOrFail({
    where: { id: organizationId },
    select: { id: true, ownerId: true },
  });

const employeeLink = (staffId: string) =>
  `/recruiterDashboard/people/employees/${staffId}?tab=performance`;
const MY_WORK_LINK = "/talentDashboard/my-work";

interface Reviewer {
  userId: string;
  link: string;
  organizationId: string | null;
}

/** Assigned HRs and the direct manager. The creator hears about it only when there's no one else. */
const reviewersOf = async (em: EntityManager, staff: StaffMember): Promise<Reviewer[]> => {
  const assignments = await em
    .getRepository(StaffHrAssignment)
    .find({ where: { staffId: staff.id }, select: { assigneeUserId: true } });
  const reviewers: Reviewer[] = assignments.map(({ assigneeUserId }) => ({
    userId: assigneeUserId,
    link: employeeLink(staff.id),
    organizationId: staff.organizationId,
  }));
  if (staff.managerId) {
    const manager = await em.getRepository(StaffMember).findOne({
      where: { id: staff.managerId, endDate: IsNull() },
      select: { id: true, userId: true },
    });
    if (manager?.userId) {
      reviewers.push({ userId: manager.userId, link: MY_WORK_LINK, organizationId: null });
    }
  }
  if (reviewers.length === 0) {
    const { ownerId } = await company(em, staff.organizationId);
    if (ownerId) {
      reviewers.push({
        userId: ownerId,
        link: employeeLink(staff.id),
        organizationId: staff.organizationId,
      });
    }
  }
  return reviewers;
};

interface PendingEmail {
  userId: string;
  subject: string;
  paragraphs: string[];
  ctaLabel: string;
  ctaUrl: string;
}

const sendEmails = async (emails: PendingEmail[]): Promise<void> => {
  if (emails.length === 0) return;
  const users = await AppDataSource.getRepository(User).find({
    where: { id: In(emails.map((email) => email.userId)) },
    select: { id: true, email: true },
  });
  const addresses = new Map(users.map((user) => [user.id, user.email]));
  await Promise.all(
    emails.map(async ({ userId, ...email }) => {
      const to = addresses.get(userId);
      if (!to) return;
      await new EmailService()
        .sendPeopleUpdate({ to, ...email })
        .catch((err: Error) =>
          logger.error(`Completion email to ${userId} failed: ${err.message}`)
        );
    })
  );
};

const siteUrl = (link: string) => `${env.website ?? ""}${link}`;

const assertSubmittable = async (
  em: EntityManager,
  staff: StaffMember,
  itemType: CompletionItemType,
  itemId: string
): Promise<{ title: string; goalId: string | null; taskId: string | null }> => {
  if (itemType === "goal") {
    const goal = await em.getRepository(StaffGoal).findOne({
      where: { id: itemId, staffId: staff.id },
      lock: { mode: "pessimistic_write" },
    });
    if (!goal || goal.status !== GoalStatus.Approved) {
      throw new NotFoundError("Goal not found");
    }
    if (goal.completedAt) {
      throw new ConflictError("This goal is already complete");
    }
    return { title: goal.title, goalId: goal.id, taskId: null };
  }
  const task = await em.getRepository(StaffChecklistTask).findOne({
    where: { id: itemId, staffId: staff.id },
    lock: { mode: "pessimistic_write" },
  });
  if (!task) {
    throw new NotFoundError("Task not found");
  }
  if (task.doneAt) {
    throw new ConflictError("This task is already complete");
  }
  return { title: task.title, goalId: null, taskId: task.id };
};

export const submitCompletionRequest = async (
  actor: User,
  staffId: string,
  input: { itemType: CompletionItemType; itemId: string; summary: string; links: string[] },
  uploads: Express.Multer.File[]
): Promise<CompletionRequestView> => {
  const links = cleanLinks(input.links);
  if (links.length > MAX_EVIDENCE_LINKS) {
    throw new ValidationError(`Add at most ${MAX_EVIDENCE_LINKS} links`);
  }
  if (uploads.length > MAX_EVIDENCE_FILES) {
    throw new ValidationError(`Add at most ${MAX_EVIDENCE_FILES} files`);
  }
  if (links.length === 0 && uploads.length === 0) {
    throw new ValidationError("Add a file or a link as evidence");
  }

  const owned = await findOwnStaff(actor.id, staffId);
  const prepared = prepareFiles(uploads, owned.organizationId);
  await Promise.all(
    prepared.map(({ buffer, meta }) => uploadPrivateToSpaces(buffer, meta.key, meta.mimeType))
  );

  const emails: PendingEmail[] = [];
  try {
    const { view } = await AppDataSource.transaction(async (em) => {
      const staff = await lockOwnStaff(actor.id, staffId, em);
      const item = await assertSubmittable(em, staff, input.itemType, input.itemId);
      const saved = await requestsRepo(em).save(
        requestsRepo(em).create({
          staffId: staff.id,
          goalId: item.goalId,
          taskId: item.taskId,
          summary: input.summary,
          links,
          files: prepared.map(({ meta }) => meta),
          submittedById: actor.id,
        })
      );
      await recordActivities(em, staff, [
        activityEntry(StaffActivityType.CompletionRequested, actor, { title: item.title }),
      ]);

      const reviewers = await reviewersOf(em, staff);
      const message = `${staff.fullName} asked for "${item.title}" to be marked complete.`;
      await em.getRepository(Notification).save(
        reviewers.map((reviewer) =>
          em.getRepository(Notification).create({
            userId: reviewer.userId,
            title: "Completion request to review",
            message,
            type: NOTIFICATION_TYPE_COMPLETION,
            link: reviewer.link,
            organizationId: reviewer.organizationId,
          })
        )
      );
      emails.push(
        ...reviewers.map((reviewer) => ({
          userId: reviewer.userId,
          subject: `${staff.fullName} asked you to review their work`,
          paragraphs: [message, "Open their record to read the summary and evidence."],
          ctaLabel: "Review it",
          ctaUrl: siteUrl(reviewer.link),
        }))
      );
      return { view: toRequestView(saved, new Map([[input.itemId, item.title]])) };
    });
    await sendEmails(emails);
    return view;
  } catch (err) {
    await deleteEvidence(
      prepared.map(({ meta }) => meta.key),
      "unsaved completion evidence"
    );
    if (isUniqueViolation(err)) {
      throw new ConflictError("This is already waiting for review");
    }
    throw err;
  }
};

export const withdrawCompletionRequest = async (
  actor: User,
  staffId: string,
  requestId: string
): Promise<void> => {
  const files = await AppDataSource.transaction(async (em) => {
    const staff = await lockOwnStaff(actor.id, staffId, em);
    const request = await requestsRepo(em).findOne({ where: { id: requestId, staffId: staff.id } });
    if (!request) {
      throw new NotFoundError("Request not found");
    }
    if (request.status !== CompletionRequestStatus.Pending) {
      throw new ConflictError("This has already been reviewed");
    }
    await requestsRepo(em).update(request.id, {
      status: CompletionRequestStatus.Withdrawn,
      files: [],
    });
    return request.files;
  });
  await deleteEvidence(
    files.map((file) => file.key),
    "withdrawn completion evidence"
  );
};

interface Evidence {
  fileName: string;
  contentType: string;
  file: Buffer;
}

const readEvidence = async (
  staffId: string,
  requestId: string,
  fileId: string
): Promise<Evidence> => {
  const request = await requestsRepo().findOne({ where: { id: requestId, staffId } });
  const stored = request?.files.find((file) => file.id === fileId);
  if (!stored) {
    throw new NotFoundError("File not found");
  }
  return {
    fileName: stored.name,
    contentType: stored.mimeType,
    file: await getFromSpaces(stored.key),
  };
};

export const downloadMyEvidence = async (
  actor: User,
  staffId: string,
  requestId: string,
  fileId: string,
  ip: string
): Promise<Evidence> => {
  const staff = await findOwnStaff(actor.id, staffId);
  await logPerformanceRead(actor, staff, ip);
  return readEvidence(staff.id, requestId, fileId);
};

export const downloadEvidence = async (
  scope: PerformanceScope,
  requestId: string,
  fileId: string,
  ip: string
): Promise<Evidence> => {
  const staff = await openPerformance(scope, ip);
  return readEvidence(staff.id, requestId, fileId);
};

/**
 * Locks the employee, then re-reads the reviewer's right on the same connection, so removing an
 * assignment can't race an approval. Nobody reviews their own work, even if they're the creator.
 */
const openForReview = async (scope: PerformanceScope, em: EntityManager): Promise<StaffMember> => {
  const staff = await lockScopedStaff(scope, em);
  if (scope.kind === "hr") {
    await assertCanViewStaff(scope.actor.id, scope.organizationId, staff.id, em);
    if (await isOwnRecord(em, scope.organizationId, scope.actor.id, staff)) {
      throw new AuthorizationError("You can't review your own work");
    }
  }
  return staff;
};

const completeGoal = async (em: EntityManager, goal: StaffGoal, actor: User): Promise<void> => {
  await em.getRepository(StaffGoalProgressEvent).insert({
    goalId: goal.id,
    fromProgress: goal.progress,
    toProgress: 100,
  });
  await em.getRepository(StaffGoal).update(goal.id, {
    progress: 100,
    completedAt: new Date(),
    completedByName: fullNameOf(actor),
  });
};

const lockGoal = async (em: EntityManager, staffId: string, goalId: string): Promise<StaffGoal> => {
  const goal = await em.getRepository(StaffGoal).findOne({
    where: { id: goalId, staffId },
    lock: { mode: "pessimistic_write" },
  });
  if (!goal) {
    throw new NotFoundError("Goal not found");
  }
  return goal;
};

const lockTask = async (
  em: EntityManager,
  staffId: string,
  taskId: string
): Promise<StaffChecklistTask> => {
  const task = await em.getRepository(StaffChecklistTask).findOne({
    where: { id: taskId, staffId },
    lock: { mode: "pessimistic_write" },
  });
  if (!task) {
    throw new NotFoundError("Task not found");
  }
  return task;
};

const closePendingRequest = (
  em: EntityManager,
  where: { goalId: string } | { taskId: string },
  actor: User,
  reviewNote: string | null
) =>
  requestsRepo(em).update(
    { ...where, status: CompletionRequestStatus.Pending },
    {
      status: CompletionRequestStatus.Approved,
      reviewedByName: fullNameOf(actor),
      reviewedAt: new Date(),
      reviewNote,
    }
  );

const outcomeFor = (
  staff: StaffMember,
  title: string,
  outcome: { approved: boolean; note: string | null }
): { message: string; subject: string; paragraphs: string[] } => {
  const message = outcome.approved
    ? `"${title}" was marked complete.`
    : `"${title}" was sent back for more work.`;
  return {
    message,
    subject: outcome.approved ? "Your work was marked complete" : "Your work was sent back",
    paragraphs: [
      `Hi ${staff.fullName}. ${message}`,
      ...(outcome.note ? [`Their note: ${outcome.note}`] : []),
    ],
  };
};

const tellEmployee = async (
  em: EntityManager,
  staff: StaffMember,
  title: string,
  outcome: { approved: boolean; note: string | null },
  emails: PendingEmail[]
): Promise<void> => {
  if (!staff.userId) return;
  const { message, subject, paragraphs } = outcomeFor(staff, title, outcome);
  await em.getRepository(Notification).save(
    em.getRepository(Notification).create({
      userId: staff.userId,
      title: subject,
      message,
      type: NOTIFICATION_TYPE_COMPLETION,
      link: MY_WORK_LINK,
    })
  );
  emails.push({
    userId: staff.userId,
    subject,
    paragraphs,
    ctaLabel: "Open My work",
    ctaUrl: siteUrl(MY_WORK_LINK),
  });
};

export const approveCompletionRequest = async (
  scope: PerformanceScope,
  requestId: string,
  input: { version?: number; note: string | null }
): Promise<ReviewResult> => {
  const emails: PendingEmail[] = [];
  const { staffId, item } = await AppDataSource.transaction(async (em) => {
    const staff = await openForReview(scope, em);
    assertWritable(staff);
    const request = await requestsRepo(em).findOne({
      where: { id: requestId, staffId: staff.id },
      lock: { mode: "pessimistic_write" },
    });
    if (!request) {
      throw new NotFoundError("Request not found");
    }
    if (request.status !== CompletionRequestStatus.Pending) {
      throw new ConflictError("This request has already been dealt with. Reload to see it.");
    }

    let title: string;
    if (request.goalId) {
      const goal = await lockGoal(em, staff.id, request.goalId);
      if (input.version !== goal.version) {
        throw new ConflictError(
          "This goal changed after you opened it. Reload and check it again."
        );
      }
      await completeGoal(em, goal, scope.actor);
      title = goal.title;
    } else {
      const task = await lockTask(em, staff.id, request.taskId!);
      await em.getRepository(StaffChecklistTask).update(task.id, {
        doneAt: new Date(),
        completedByName: fullNameOf(scope.actor),
      });
      title = task.title;
    }

    await requestsRepo(em).update(request.id, {
      status: CompletionRequestStatus.Approved,
      reviewedByName: fullNameOf(scope.actor),
      reviewedAt: new Date(),
      reviewNote: input.note,
    });
    await recordActivities(em, staff, [
      activityEntry(StaffActivityType.CompletionApproved, scope.actor, { title }),
    ]);
    await tellEmployee(em, staff, title, { approved: true, note: input.note }, emails);
    return {
      staffId: staff.id,
      item: request.goalId ? { goalId: request.goalId } : { taskId: request.taskId! },
    };
  });
  await sendEmails(emails);
  return reviewResult(staffId, item);
};

export const returnCompletionRequest = async (
  scope: PerformanceScope,
  requestId: string,
  note: string
): Promise<ReviewResult> => {
  const emails: PendingEmail[] = [];
  const { staffId, itemRef } = await AppDataSource.transaction(async (em) => {
    const staff = await openForReview(scope, em);
    assertWritable(staff);
    const request = await requestsRepo(em).findOne({
      where: { id: requestId, staffId: staff.id },
      lock: { mode: "pessimistic_write" },
    });
    if (!request) {
      throw new NotFoundError("Request not found");
    }
    if (request.status !== CompletionRequestStatus.Pending) {
      throw new ConflictError("This request has already been dealt with. Reload to see it.");
    }
    await requestsRepo(em).update(request.id, {
      status: CompletionRequestStatus.Returned,
      reviewedByName: fullNameOf(scope.actor),
      reviewedAt: new Date(),
      reviewNote: note,
    });
    const item = request.goalId
      ? await lockGoal(em, staff.id, request.goalId)
      : await lockTask(em, staff.id, request.taskId!);
    await recordActivities(em, staff, [
      activityEntry(StaffActivityType.CompletionReturned, scope.actor, { title: item.title }),
    ]);
    await tellEmployee(em, staff, item.title, { approved: false, note }, emails);
    return {
      staffId: staff.id,
      itemRef: request.goalId ? { goalId: request.goalId } : { taskId: request.taskId! },
    };
  });
  await sendEmails(emails);
  return reviewResult(staffId, itemRef);
};

export const completeGoalDirectly = async (
  scope: PerformanceScope,
  goalId: string,
  version: number
): Promise<ReviewResult> => {
  const emails: PendingEmail[] = [];
  const staffId = await AppDataSource.transaction(async (em) => {
    const staff = await openForReview(scope, em);
    assertWritable(staff);
    const goal = await lockGoal(em, staff.id, goalId);
    if (goal.status !== GoalStatus.Approved) {
      throw new ConflictError("Approve this goal before marking it complete");
    }
    if (goal.completedAt) {
      throw new ConflictError("This goal is already complete");
    }
    if (version !== goal.version) {
      throw new ConflictError("This goal changed after you opened it. Reload and check it again.");
    }
    await completeGoal(em, goal, scope.actor);
    await closePendingRequest(em, { goalId: goal.id }, scope.actor, null);
    await recordActivities(em, staff, [
      activityEntry(StaffActivityType.CompletionApproved, scope.actor, { title: goal.title }),
    ]);
    await tellEmployee(em, staff, goal.title, { approved: true, note: null }, emails);
    return staff.id;
  });
  await sendEmails(emails);
  return reviewResult(staffId, { goalId });
};

export const completeTaskDirectly = async (
  scope: PerformanceScope,
  taskId: string
): Promise<ReviewResult> => {
  const emails: PendingEmail[] = [];
  const staffId = await AppDataSource.transaction(async (em) => {
    const staff = await openForReview(scope, em);
    assertWritable(staff);
    const task = await lockTask(em, staff.id, taskId);
    if (task.doneAt) {
      throw new ConflictError("This task is already complete");
    }
    await em.getRepository(StaffChecklistTask).update(task.id, {
      doneAt: new Date(),
      completedByName: fullNameOf(scope.actor),
    });
    await closePendingRequest(em, { taskId: task.id }, scope.actor, null);
    await recordActivities(em, staff, [
      activityEntry(StaffActivityType.CompletionApproved, scope.actor, { title: task.title }),
    ]);
    await tellEmployee(em, staff, task.title, { approved: true, note: null }, emails);
    return staff.id;
  });
  await sendEmails(emails);
  return reviewResult(staffId, { taskId });
};

export const reopenGoal = async (
  scope: PerformanceScope,
  goalId: string
): Promise<ReviewResult> => {
  const staffId = await AppDataSource.transaction(async (em) => {
    const staff = await openForReview(scope, em);
    assertWritable(staff);
    const goal = await lockGoal(em, staff.id, goalId);
    if (!goal.completedAt) {
      throw new ConflictError("This goal isn't complete");
    }
    const lastCompleted = await em.getRepository(StaffGoalProgressEvent).findOne({
      where: { goalId: goal.id, toProgress: 100 },
      order: { createdAt: "DESC" },
    });
    const progress = Math.min(lastCompleted?.fromProgress ?? 0, 99);
    await em.getRepository(StaffGoalProgressEvent).insert({
      goalId: goal.id,
      fromProgress: goal.progress,
      toProgress: progress,
    });
    await em.getRepository(StaffGoal).update(goal.id, {
      progress,
      completedAt: null,
      completedByName: null,
    });
    await recordActivities(em, staff, [
      activityEntry(StaffActivityType.CompletionReopened, scope.actor, { title: goal.title }),
    ]);
    return staff.id;
  });
  return reviewResult(staffId, { goalId });
};

export const reopenTask = async (
  scope: PerformanceScope,
  taskId: string
): Promise<ReviewResult> => {
  const staffId = await AppDataSource.transaction(async (em) => {
    const staff = await openForReview(scope, em);
    assertWritable(staff);
    const task = await lockTask(em, staff.id, taskId);
    if (!task.doneAt) {
      throw new ConflictError("This task isn't complete");
    }
    await em.getRepository(StaffChecklistTask).update(task.id, {
      doneAt: null,
      completedByName: null,
    });
    await recordActivities(em, staff, [
      activityEntry(StaffActivityType.CompletionReopened, scope.actor, { title: task.title }),
    ]);
    return staff.id;
  });
  return reviewResult(staffId, { taskId });
};

export const listScopedTasks = async (
  scope: PerformanceScope,
  ip: string
): Promise<StaffChecklistTask[]> => {
  const staff = await openPerformance(scope, ip);
  return AppDataSource.getRepository(StaffChecklistTask).find({
    where: { staffId: staff.id },
    order: { dueOn: "ASC", createdAt: "ASC", id: "ASC" },
  });
};

/** A record that ends can't be reviewed any more, so nothing stays waiting on it. */
export const withdrawPendingForStaff = (em: EntityManager, staffId: string) =>
  requestsRepo(em).update(
    { staffId, status: CompletionRequestStatus.Pending },
    { status: CompletionRequestStatus.Withdrawn }
  );
