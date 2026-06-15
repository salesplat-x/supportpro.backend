import Plan from "../../models/v1/plan";
import { IPlan } from "../../typings/plan";
import { FilterQuery, Types, UpdateQuery } from "mongoose";

export const createPlan = async (plan: Partial<IPlan>) => {
  return new Plan(plan).save();
};

export const findPlanById = async (id: Types.ObjectId | string) => {
  return Plan.findById(id);
};

export const findPlanByMatch = async (data: FilterQuery<IPlan>) => {
  return Plan.findOne(data);
};

export const findPlansByMatch = async (data: FilterQuery<IPlan>) => {
  return Plan.find(data);
};

export const findAllPlan = async () => {
  return Plan.find().sort({ name: 1 });
};

export const findPlanByIdAndUpdate = async (
  planId: string | Types.ObjectId,
  data: UpdateQuery<IPlan>
) => {
  return Plan.findByIdAndUpdate(planId, data, { new: true });
};
