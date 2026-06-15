import { Organization } from "../../models/v1/organization";
import { Page, Paging } from "../../typings/customs";
import { IOrganization } from "../../typings/organization";
import { HydratedDocument, Types } from "mongoose";
import * as func from "../../helpers/func";

export const createOrganization = async (
  organization: IOrganization
): Promise<HydratedDocument<IOrganization>> => {
  return await new Organization(organization).save();
};

export const findOrganizationById = async (id: Types.ObjectId | string) => {
  return await Organization.findById(id);
};

export const findOrganizationAndScoreById = async (id: Types.ObjectId | string) => {
  return await Organization.findById(id);
};

export const findOrganizationByEmail = async (email: string) => {
  return await Organization.findOne({ email });
};

export const findOrganizationByMatch = async (data: IOrganization | Record<string, any>) => {
  return await Organization.findOne(data);
};

export const findOrganizationsByMatch = async (
  data: IOrganization | Record<string, any>,
  paging: Paging = {}
) => {
  return await Organization.find(data)
    .sort({ updatedAt: func.sortDirection(paging.sort!) || Page.Sort })
    .skip(Number(paging.offset) || Page.Offset)
    .limit(Number(paging.limit) || Page.Limit)
    .select("-password");
};

export const findOrganizationByIdAndUpdate = async (
  organizationId: string | Types.ObjectId,
  data: Partial<IOrganization>
) => {
  return await Organization.findByIdAndUpdate(organizationId, data, {
    new: true,
  });
};
