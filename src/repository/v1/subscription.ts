import Subscription from "../../models/v1/subscription";
import { ISubscription } from "../../typings/subscription";
import { FilterQuery, HydratedDocument, Types, UpdateQuery } from "mongoose";

export const createSubscription = async (subscription: ISubscription) => {
  return new Subscription(subscription).save();
};

export const findSubscriptionById = async (id: Types.ObjectId | string) => {
  return Subscription.findById(id);
};

export const findSubscriptionByMatch = async (data: FilterQuery<ISubscription>) => {
  return Subscription.findOne(data);
};

export const findSubscriptionsByMatch = async (data: FilterQuery<ISubscription>) => {
  return Subscription.find(data);
};

export const findAllSubscription = async () => {
  return Subscription.find();
};

export const findSubscriptionByIdAndUpdate = async (
  subscription: string | Types.ObjectId,
  data: UpdateQuery<ISubscription>
) => {
  return Subscription.findByIdAndUpdate(subscription, data, { new: true });
};

export const findSubscriptionByIdAndDelete = async (subscription: string | Types.ObjectId) => {
  return Subscription.findByIdAndDelete(subscription);
};
