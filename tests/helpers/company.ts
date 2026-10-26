import { testDataSource } from "./db.js";
import { Organization, OrganizationMember, User } from "../../src/entities";
import { createOrganization, createRecruiter } from "./fixtures.js";

export const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

export async function setupCompany(name = "Acme Ltd") {
  const owner = await createRecruiter({ firstName: "Olu", lastName: "Owner" });
  const org = await createOrganization(owner.user, { name });
  return { owner, org };
}

export async function addMember(
  org: Organization,
  options: { canManagePeople?: boolean; firstName?: string; lastName?: string } = {}
) {
  const member = await createRecruiter({
    firstName: options.firstName ?? "Hana",
    lastName: options.lastName ?? "Resources",
  });
  const repo = testDataSource.getRepository(OrganizationMember);
  const row = await repo.save(
    repo.create({
      userId: member.user.id,
      organizationId: org.id,
      workEmail: member.user.email,
      role: "member",
      canManagePeople: options.canManagePeople ?? false,
    })
  );
  await testDataSource.getRepository(User).update(member.user.id, { activeOrganizationId: org.id });
  return { ...member, memberId: row.id };
}
