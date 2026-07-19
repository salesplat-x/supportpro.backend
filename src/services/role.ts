import { QueryFailedError } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Role, Question } from "../entities";
import { NotFoundError, ConflictError } from "../utils/errors";
import { sortDirection } from "../utils/text.js";

// Postgres foreign_key_violation code — thrown when a role still has Jobs
// (or other rows) referencing it.
const FOREIGN_KEY_VIOLATION = "23503";

const roleRepo = () => AppDataSource.getRepository(Role);

const questionRepo = () => AppDataSource.getRepository(Question);

export interface RolePayload {
  name: string;
  description?: string | null;
}

export interface PagingParams {
  limit?: number | string;
  offset?: number | string;
  sort?: string;
}

export const createRole = async (payload: RolePayload): Promise<Role> => {
  const name = payload.name.toLowerCase();
  const existing = await roleRepo().findOne({ where: { name } });
  if (existing) {
    throw new ConflictError("Role already exists");
  }
  const role = roleRepo().create({ name, description: payload.description ?? null });
  return roleRepo().save(role);
};

export const fetchAllRoles = async (paging: PagingParams): Promise<Role[]> => {
  const limit = Number(paging.limit) || 50;
  const offset = Number(paging.offset) || 0;
  const order = sortDirection(paging.sort ?? "desc");
  return roleRepo().find({
    skip: offset,
    take: limit,
    order: { name: order },
  });
};

export const fetchRole = async (roleId: string): Promise<Role> => {
  const role = await roleRepo().findOne({ where: { id: roleId } });
  if (!role) {
    throw new NotFoundError("Role not found");
  }
  return role;
};

export const updateRole = async (roleId: string, payload: RolePayload): Promise<Role> => {
  const role = await roleRepo().findOne({ where: { id: roleId } });
  if (!role) {
    throw new NotFoundError("Role not found");
  }

  if (payload.name) {
    const name = payload.name.toLowerCase();
    const existing = await roleRepo()
      .createQueryBuilder("role")
      .where("role.name = :name", { name })
      .andWhere("role.id != :id", { id: roleId })
      .getOne();
    if (existing) {
      throw new ConflictError("Role already exists");
    }
    role.name = name;
  }

  if (payload.description !== undefined) {
    role.description = payload.description ?? null;
  }

  return roleRepo().save(role);
};

export const deleteRole = async (roleId: string): Promise<void> => {
  const role = await roleRepo().findOne({ where: { id: roleId } });
  if (!role) {
    throw new NotFoundError("Role not found");
  }

  try {
    await roleRepo().remove(role);
  } catch (err) {
    if (
      err instanceof QueryFailedError &&
      (err as unknown as { code?: string }).code === FOREIGN_KEY_VIOLATION
    ) {
      throw new ConflictError("Role is in use and cannot be deleted");
    }
    throw err;
  }
};

export const fetchRoleQuestions = async (
  roleId: string,
  paging: PagingParams
): Promise<Question[]> => {
  const role = await roleRepo().findOne({ where: { id: roleId } });
  if (!role) {
    throw new NotFoundError("Role not found");
  }
  const limit = Number(paging.limit) || 50;
  const offset = Number(paging.offset) || 0;
  const order = sortDirection(paging.sort ?? "desc");
  return questionRepo().find({
    where: { roleId },
    skip: offset,
    take: limit,
    order: { createdAt: order },
  });
};
