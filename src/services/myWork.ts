import { In, IsNull } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Organization } from "../entities/Organization.js";
import { StaffAccessResource } from "../entities/StaffAccessLog.js";
import { StaffChecklistTask } from "../entities/StaffChecklistTask.js";
import { DocumentStatus, StaffDocument } from "../entities/StaffDocument.js";
import { StaffMember } from "../entities/StaffMember.js";
import type { User } from "../entities/User.js";
import { NotFoundError } from "../utils/errors";
import { CHECKLIST_ORDER } from "./checklist.js";
import {
  SignedCopy,
  SigningView,
  finishSigning,
  recordView,
  signedDocumentFile,
  signLockedDocument,
  signingViewOf,
} from "./contracts.js";
import { PayView, loadPay } from "./pay.js";
import { logStaffAccess } from "./staffAudit.js";
import { loadManagerNames } from "./staffRecord.js";

export interface MyWorkRecord {
  staffId: string;
  companyName: string;
  companyLogoUrl: string | null;
  jobTitle: string;
  managerName: string | null;
  startDate: string;
  documentsToSign: { id: string; title: string; sentAt: Date }[];
  signedDocuments: { id: string; title: string; signedAt: Date | null }[];
  tasks: StaffChecklistTask[];
}

const ownOpenRecords = (userId: string) =>
  AppDataSource.getRepository(StaffMember).find({
    where: { userId, endDate: IsNull() },
    order: { createdAt: "ASC" },
  });

const findOwnRecord = async (userId: string, staffId: string): Promise<StaffMember> => {
  const staff = await AppDataSource.getRepository(StaffMember).findOne({
    where: { id: staffId, userId, endDate: IsNull() },
  });
  if (!staff) {
    throw new NotFoundError("Record not found");
  }
  return staff;
};

export const getMyWork = async (userId: string): Promise<MyWorkRecord[]> => {
  const records = await ownOpenRecords(userId);
  if (records.length === 0) return [];
  const staffIds = records.map((staff) => staff.id);

  const [orgs, documents, signedDocuments, tasks, managerNames] = await Promise.all([
    AppDataSource.getRepository(Organization).find({
      where: { id: In(records.map((staff) => staff.organizationId)) },
      select: { id: true, name: true, logoUrl: true },
    }),
    AppDataSource.getRepository(StaffDocument).find({
      where: { staffId: In(staffIds), status: DocumentStatus.Sent },
      select: { id: true, staffId: true, title: true, sentAt: true },
      order: { sentAt: "DESC" },
    }),
    AppDataSource.getRepository(StaffDocument).find({
      where: { staffId: In(staffIds), status: DocumentStatus.Signed },
      select: { id: true, staffId: true, title: true, signedAt: true },
      order: { signedAt: "DESC" },
    }),
    AppDataSource.getRepository(StaffChecklistTask).find({
      where: { staffId: In(staffIds) },
      order: CHECKLIST_ORDER,
    }),
    loadManagerNames(records),
  ]);

  return records.map((staff) => {
    const org = orgs.find((item) => item.id === staff.organizationId);
    return {
      staffId: staff.id,
      companyName: org?.name ?? "",
      companyLogoUrl: org?.logoUrl ?? null,
      jobTitle: staff.jobTitle,
      managerName: staff.managerId ? (managerNames.get(staff.managerId) ?? null) : null,
      startDate: staff.startDate,
      documentsToSign: documents
        .filter((doc) => doc.staffId === staff.id)
        .map(({ id, title, sentAt }) => ({ id, title, sentAt })),
      signedDocuments: signedDocuments
        .filter((doc) => doc.staffId === staff.id)
        .map(({ id, title, signedAt }) => ({ id, title, signedAt })),
      tasks: tasks.filter((task) => task.staffId === staff.id),
    };
  });
};

export const getMyPay = async (actor: User, staffId: string, ip: string): Promise<PayView> => {
  const staff = await findOwnRecord(actor.id, staffId);
  await logStaffAccess({
    organizationId: staff.organizationId,
    actor,
    staff,
    resource: StaffAccessResource.Pay,
    ip,
  });
  return loadPay(staff.id);
};

export const setMyTaskDone = async (
  userId: string,
  taskId: string,
  done: boolean
): Promise<StaffChecklistTask> => {
  const task = await AppDataSource.getRepository(StaffChecklistTask)
    .createQueryBuilder("task")
    .innerJoin(StaffMember, "staff", "staff.id = task.staff_id")
    .where("task.id = :taskId", { taskId })
    .andWhere("staff.user_id = :userId AND staff.end_date IS NULL", { userId })
    .getOne();
  if (!task) {
    throw new NotFoundError("Task not found");
  }
  if (done !== !!task.doneAt) {
    task.doneAt = done ? new Date() : null;
    await AppDataSource.getRepository(StaffChecklistTask).update(task.id, {
      doneAt: task.doneAt,
    });
  }
  return task;
};

const findOwnDocument = async (
  userId: string,
  documentId: string,
  em = AppDataSource.manager,
  lock = false
): Promise<{ doc: StaffDocument; staff: StaffMember }> => {
  const doc = await em.getRepository(StaffDocument).findOne({
    where: { id: documentId, status: DocumentStatus.Sent },
    ...(lock ? { lock: { mode: "pessimistic_write" as const } } : {}),
  });
  const staff = doc
    ? await em.getRepository(StaffMember).findOne({
        where: { id: doc.staffId, userId, endDate: IsNull() },
      })
    : null;
  if (!doc || !staff) {
    throw new NotFoundError("This document is no longer waiting for your signature");
  }
  return { doc, staff };
};

export const openMyDocument = async (
  actor: User,
  documentId: string,
  ip: string
): Promise<SigningView> => {
  const { doc, staff } = await findOwnDocument(actor.id, documentId);
  await recordView(doc, staff, actor, ip);
  return signingViewOf(doc, staff);
};

export const downloadMySignedDocument = async (
  actor: User,
  documentId: string,
  ip: string
): Promise<{ fileName: string; pdf: Buffer }> => {
  const doc = await AppDataSource.getRepository(StaffDocument).findOne({
    where: { id: documentId, status: DocumentStatus.Signed },
  });
  const staff = doc
    ? await AppDataSource.getRepository(StaffMember).findOne({
        where: { id: doc.staffId, userId: actor.id, endDate: IsNull() },
      })
    : null;
  if (!doc || !staff) {
    throw new NotFoundError("Document not found");
  }
  await logStaffAccess({
    organizationId: staff.organizationId,
    actor,
    staff,
    resource: StaffAccessResource.Contract,
    ip,
  });
  const org = await AppDataSource.getRepository(Organization).findOneOrFail({
    where: { id: staff.organizationId },
  });
  return signedDocumentFile(org, doc);
};

export const signMyDocument = async (
  userId: string,
  documentId: string,
  signerName: string,
  ip: string
): Promise<SignedCopy> => {
  const { doc } = await AppDataSource.transaction(async (em) => {
    const owned = await findOwnDocument(userId, documentId, em, true);
    return signLockedDocument(em, owned.doc, signerName, ip);
  });
  return finishSigning(doc);
};
