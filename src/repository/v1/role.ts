import Role from "../../models/v1/role";
import { Page, Paging } from "../../typings/customs";
import { IRole } from "../../typings/role";
import { FilterQuery, HydratedDocument, Types } from "mongoose";

export const createRole = async (role: Partial<IRole>): Promise<HydratedDocument<IRole>> => {
  return await new Role(role).save();
};

export const findRoleById = async (id: Types.ObjectId | string) => {
  return await Role.findById(id);
};

export const findAllRoles = async (paging: Paging = {}) => {
  return await Role.find()
    .sort({ name: 1 })
    .skip(Number(paging.offset) || Page.Offset)
    .limit(Number(paging.limit) || Page.Limit);
};

export const findRoleByMatch = async (data: FilterQuery<IRole>) => {
  return await Role.findOne(data);
};

export const findRoleByIdAndUpdate = async (
  RoleId: string | Types.ObjectId,
  data: Partial<IRole>
) => {
  return await Role.findByIdAndUpdate(RoleId, data, { new: true });
};
