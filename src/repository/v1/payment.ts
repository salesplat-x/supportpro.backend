import Payment from "../../models/v1/payment";
import { IPayment } from "../../typings/payment";
import { FilterQuery, Types, UpdateQuery } from "mongoose";

export const createPayment = async (payment: IPayment) => {
  return new Payment(payment).save();
};

export const findPaymentById = async (id: Types.ObjectId | string) => {
  return Payment.findById(id);
};

export const findPaymentByMatch = async (data: FilterQuery<IPayment>) => {
  return Payment.findOne(data);
};

export const findPaymentsByMatch = async (data: FilterQuery<IPayment>) => {
  return Payment.find(data);
};

export const findPaymentByIdAndUpdate = async (
  paymentId: string | Types.ObjectId,
  data: UpdateQuery<IPayment>
) => {
  return Payment.findByIdAndUpdate(paymentId, data, { new: true });
};

export const findPaymentByIdAndDelete = async (paymentId: string | Types.ObjectId) => {
  return Payment.findByIdAndDelete(paymentId);
};
