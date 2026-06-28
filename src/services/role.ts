import { AppDataSource } from "../database/dataSource.js";
import { Role } from "../entities/Role.js";
import { Question } from "../entities/Question.js";
import { NotFoundError, ConflictError } from "../utils/errors/index.js";
import { sortDirection } from "../utils/text.js";

function roleRepo() {
  return AppDataSource.getRepository(Role);
}

function questionRepo() {
  return AppDataSource.getRepository(Question);
}

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
