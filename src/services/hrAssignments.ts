import { EntityManager, In } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Notification } from "../entities/Notification.js";
import { Organization } from "../entities/Organization.js";
import { OrganizationMember } from "../entities/OrganizationMember.js";
import { StaffActivityType } from "../entities/StaffActivity.js";
import { StaffHrAssignment } from "../entities/StaffHrAssignment.js";
import { StaffMember } from "../entities/StaffMember.js";
import { User } from "../entities/User.js";
import { ConflictError, NotFoundError, ValidationError } from "../utils/errors";
import { assertOwner } from "./peopleAccess.js";
import { activityEntry, recordActivities } from "./staffAudit.js";
import { fullNameOf } from "./staffRecord.js";

export const NOTIFICATION_TYPE_HR_ASSIGNED = "hr_assigned";

const PEOPLE_LINK = "/recruiterDashboard/people/employees";

export interface HrAssigneeView {
  userId: string;
  fullName: string;
  email: string;
}

/**
 * A teammate's account or work email can match a staff row, because that's only checked when
 * an invite goes out. Tracking or approving your own record is never allowed, even for the creator.
 */
export const isOwnRecord = async (
  em: EntityManager,
  organizationId: string,
  userId: string,
  staff: Pick<StaffMember, "userId" | "email">
): Promise<boolean> => {
  if (staff.userId === userId) return true;
  const [user, member] = await Promise.all([
    em.getRepository(User).findOne({ where: { id: userId }, select: { id: true, email: true } }),
    em.getRepository(OrganizationMember).findOne({ where: { userId, organizationId } }),
  ]);
  const staffEmail = staff.email.toLowerCase();
  return user?.email.toLowerCase() === staffEmail || member?.workEmail.toLowerCase() === staffEmail;
};

export const listHrAssignees = async (
  actor: User,
  organizationId: string,
  staffId: string
): Promise<HrAssigneeView[]> => {
  await assertOwner(actor.id, organizationId);
  const staff = await AppDataSource.getRepository(StaffMember).findOne({
    where: { id: staffId, organizationId },
    select: { id: true },
  });
  if (!staff) {
    throw new NotFoundError("Staff member not found");
  }
  const rows = await AppDataSource.getRepository(StaffHrAssignment).find({
    where: { staffId },
    relations: { assignee: true },
    order: { createdAt: "ASC" },
  });
  return rows.map(({ assignee }) => ({
    userId: assignee.id,
    fullName: fullNameOf(assignee),
    email: assignee.email,
  }));
};

export const listAssignedStaffIds = async (
  actor: User,
  organizationId: string,
  assigneeUserId: string
): Promise<string[]> => {
  await assertOwner(actor.id, organizationId);
  const rows = await AppDataSource.getRepository(StaffHrAssignment)
    .createQueryBuilder("assignment")
    .innerJoin(StaffMember, "staff", "staff.id = assignment.staffId")
    .where("assignment.assigneeUserId = :assigneeUserId", { assigneeUserId })
    .andWhere("staff.organizationId = :organizationId", { organizationId })
    .getMany();
  return rows.map((row) => row.staffId);
};

const assertOnCompanyTeam = async (
  em: EntityManager,
  organizationId: string,
  assigneeUserId: string
): Promise<User> => {
  const organization = await em
    .getRepository(Organization)
    .findOneOrFail({ where: { id: organizationId }, select: { id: true, ownerId: true } });
  const onTeam =
    organization.ownerId === assigneeUserId ||
    (await em
      .getRepository(OrganizationMember)
      .exists({ where: { userId: assigneeUserId, organizationId } }));
  const assignee = onTeam
    ? await em.getRepository(User).findOne({ where: { id: assigneeUserId } })
    : null;
  if (!assignee) {
    throw new NotFoundError("This person isn't on your company team");
  }
  return assignee;
};

export const setHrAssignments = async (
  actor: User,
  organizationId: string,
  input: { assigneeUserId: string; add: string[]; remove: string[] }
): Promise<{ assignedStaffIds: string[] }> => {
  await assertOwner(actor.id, organizationId);
  const add = [...new Set(input.add)];
  const remove = [...new Set(input.remove)];
  if (add.some((staffId) => remove.includes(staffId))) {
    throw new ValidationError("A person can't be both added and removed");
  }

  await AppDataSource.transaction(async (em) => {
    const assignee = await assertOnCompanyTeam(em, organizationId, input.assigneeUserId);
    const assigneeName = fullNameOf(assignee);

    // Locking the people settles a change racing this one, and the id order avoids deadlocks.
    const ids = [...add, ...remove];
    const people =
      ids.length === 0
        ? []
        : await em.getRepository(StaffMember).find({
            where: { id: In(ids), organizationId },
            order: { id: "ASC" },
            lock: { mode: "pessimistic_write" },
          });
    if (people.length !== ids.length) {
      throw new NotFoundError("Staff member not found");
    }

    const repo = em.getRepository(StaffHrAssignment);
    const existing = new Set(
      (await repo.find({ where: { assigneeUserId: input.assigneeUserId, staffId: In(ids) } })).map(
        (row) => row.staffId
      )
    );

    const newlyAdded: StaffMember[] = [];
    for (const person of people) {
      const shouldAdd = add.includes(person.id);
      if (shouldAdd && !existing.has(person.id)) {
        if (person.endDate) {
          throw new ConflictError(`${person.fullName}'s employment has ended`);
        }
        if (await isOwnRecord(em, organizationId, input.assigneeUserId, person)) {
          throw new ConflictError(`${assigneeName} can't be assigned to their own record`);
        }
        await repo.insert({
          staffId: person.id,
          assigneeUserId: input.assigneeUserId,
          assignedById: actor.id,
        });
        await recordActivities(em, person, [
          activityEntry(StaffActivityType.HrAssigned, actor, { hrName: assigneeName }),
        ]);
        newlyAdded.push(person);
      }
      if (!shouldAdd && existing.has(person.id)) {
        await repo.delete({ staffId: person.id, assigneeUserId: input.assigneeUserId });
        await recordActivities(em, person, [
          activityEntry(StaffActivityType.HrRemoved, actor, { hrName: assigneeName }),
        ]);
      }
    }

    if (newlyAdded.length > 0 && input.assigneeUserId !== actor.id) {
      const [first] = newlyAdded;
      await em.getRepository(Notification).save(
        em.getRepository(Notification).create({
          userId: input.assigneeUserId,
          title: "You have people to track",
          message:
            newlyAdded.length === 1
              ? `You can now track ${first!.fullName}'s performance and activity.`
              : `You can now track performance and activity for ${newlyAdded.length} people.`,
          type: NOTIFICATION_TYPE_HR_ASSIGNED,
          link: PEOPLE_LINK,
          organizationId,
        })
      );
    }
  });

  return {
    assignedStaffIds: await listAssignedStaffIds(actor, organizationId, input.assigneeUserId),
  };
};
