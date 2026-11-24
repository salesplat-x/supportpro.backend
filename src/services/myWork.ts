import { In, IsNull } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Department } from "../entities/Department.js";
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
  declineLockedDocument,
  signLockedDocument,
  signingViewOf,
} from "./contracts.js";
import { PayView, loadPay } from "./pay.js";
import { openDepartmentMember } from "./performanceAccess.js";
import { logStaffAccess } from "./staffAudit.js";
import { loadManagerNames } from "./staffRecord.js";
import { type CompletionRequestView, loadLatestRequests } from "./completionRequests.js";

export interface MyWorkRecord {
  staffId: string;
  companyName: string;
  companyLogoUrl: string | null;
  jobTitle: string;
  managerName: string | null;
  startDate: string;
  documentsToSign: { id: string; title: string; sentAt: Date | null }[];
  signedDocuments: { id: string; title: string; signedAt: Date | null }[];
  hasTeam: boolean;
  tasks: StaffChecklistTask[];
  completionRequests: CompletionRequestView[];
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

  const [orgs, documents, signedDocuments, tasks, managerNames, managers, requests, headed] =
    await Promise.all([
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
      AppDataSource.getRepository(StaffMember).find({
        where: { managerId: In(staffIds), endDate: IsNull() },
        select: { id: true, managerId: true },
      }),
      loadLatestRequests(staffIds),
      AppDataSource.getRepository(Department).find({
        where: { headStaffId: In(staffIds) },
        select: { id: true, headStaffId: true },
      }),
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
      completionRequests: requests.filter(
        (request) =>
          request.itemType === "task" &&
          tasks.some((task) => task.id === request.itemId && task.staffId === staff.id)
      ),
      hasTeam:
        managers.some((report) => report.managerId === staff.id) ||
        headed.some((department) => department.headStaffId === staff.id),
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
  const pay = await loadPay(staff.id);
  if (pay.grants.length > 0) {
    await logStaffAccess({
      organizationId: staff.organizationId,
      actor,
      staff,
      resource: StaffAccessResource.ShareOptions,
      ip,
    });
  }
  return pay;
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

export const declineMyDocument = async (
  userId: string,
  documentId: string,
  ip: string
): Promise<void> => {
  await AppDataSource.transaction(async (em) => {
    const { doc } = await findOwnDocument(userId, documentId, em, true);
    await declineLockedDocument(em, doc, ip);
  });
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

export interface TeamMemberDetails {
  staffId: string;
  fullName: string;
  jobTitle: string;
  department: string | null;
  managerName: string | null;
  email: string;
  phone: string | null;
  startDate: string;
  status: StaffMember["status"];
  joinedAt: Date | null;
}

/** What a department head may see about someone in their department. Never address, pay or contracts. */
export const getTeamMemberDetails = async (
  actor: User,
  headStaffId: string,
  staffId: string,
  ip: string
): Promise<TeamMemberDetails> => {
  const member = await openDepartmentMember(actor, headStaffId, staffId, ip);
  const managerNames = await loadManagerNames([member]);
  return {
    staffId: member.id,
    fullName: member.fullName,
    jobTitle: member.jobTitle,
    department: member.department,
    managerName: member.managerId ? (managerNames.get(member.managerId) ?? null) : null,
    email: member.email,
    phone: member.phone,
    startDate: member.startDate,
    status: member.status,
    joinedAt: member.joinedAt,
  };
};
