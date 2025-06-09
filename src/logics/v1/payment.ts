import * as paymentRepository from "../../repository/v1/payment";
import * as paystackService from "../../services/v1/paystack";
import { makeResponse } from "../../helpers/response";
import { IUser } from "../../typings/user";
import { PaymentMethod, PaymentStatus } from "../../typings/payment";
import { PaymentVerificationStatus } from "../../typings/paystack";
import Email from "../../services/v1/email";
import { findUserById } from "../../repository/v1/user";
import * as repository from "../../repository/v1/plan";


export const verify = async (payload: { reference?: string }) => {
    const payment = await paymentRepository.findPaymentByMatch({
        $or: [{ paystackRef: payload.reference }, { reference: payload.reference }],
    });
    if (!payment) {
        return makeResponse(false, "Payment not found for reference!", {}, 404);
    }
    if (payment.status === PaymentStatus.Completed) {
        return makeResponse(false, "Payment already verified!", {}, 400);
    }

    const user = await findUserById(payment.user);
    if (!user) {
        return makeResponse(false, "User not found!", {}, 404);
    }

    const response = await paystackService.verifyTransaction({
        reference: payload.reference!,
    });

    if (!response || !response.status) {
        return makeResponse(false, "Unable to verify payment!", {});
    }

    const plan = await repository.findPlanByMatch({ paystackPlanCode: response.data.plan })

    if (
        response.data.status === "success" &&
        response.data.currency === "NGN" &&
        response.data.amount / 100 >= payment.amount
    ) {
        await paymentRepository.findPaymentByIdAndUpdate(payment._id!, {
            status: PaymentStatus.Completed,
            finalConfig: response,
            paidAt: new Date(),
            $push: {
                history: {
                    description: "Payment made",
                    author: payment.user,
                    date: new Date(),
                },
            },
        });


        // TODO: Send email notification to user
        // await new Email().paymentSuccessful(user, plan);
        return makeResponse(true, "Payment successful.");
    } else if (response.data.status === PaymentVerificationStatus.Failed) {
        await paymentRepository.findPaymentByIdAndUpdate(payment._id!, {
            status: PaymentStatus.Failed,
            finalConfig: response,
            history: {
                description: "Payment failed!",
                createdAt: new Date(),
                author: payment.user,
            },
        });


        return makeResponse(false, "Payment failed!", {});
    }

    return makeResponse(false, "Payment failed!", {});
};

export const paystackWebhook = async (payload: {
    event: string;
    data: Record<string, string>;
}) => {
    const { event, data } = payload;
    if (event === "charge.success" && data.status === "success") {
        const payment = await paymentRepository.findPaymentByMatch({
            $or: [{ paystackRef: data.id }, { reference: data.id }],
        });
        if (!payment) {
            return makeResponse(false, "Payment not found for reference!", {}, 404);
        }
        if (payment.status === PaymentStatus.Completed) {
            return makeResponse(false, "Payment already verified!", {}, 200);
        }

        const user = await findUserById(payment.user);
        if (!user) {
            return makeResponse(false, "User not found!", {}, 404);
        }

        await paymentRepository.findPaymentByIdAndUpdate(payment._id!, {
            status: PaymentStatus.Completed,
            finalConfig: data,
            paidAt: new Date(),
            $push: {
                history: {
                    description: "Payment made",
                    author: payment.user,
                    date: new Date(),
                },
            },
        });


        // TODO: Send email notification to user
        //await new Email().paymentSuccessful(user, order);
        return makeResponse(true, "Payment successful.");
    }
};

export const initiateTransaction = async (user: IUser, planId: string) => {
    let plan = await repository.findPlanById(planId);
    if (!plan) {
        return makeResponse(false, `Plan not found`, {}, 404);
    }

    const initialConfig = paystackService.generatePaymentObject(
        plan,
        user
    );

    const paymentResponse = await paystackService.makePayment(initialConfig);

    // create payment
    const payment = await paymentRepository.createPayment({
        ...initialConfig,
        method: PaymentMethod.Paystack,
        paymentLink: paymentResponse.data.authorization_url,
        reference:
            initialConfig.reference ||
            `supportpro-${Date.now()}-${Math.floor(Math.random() * 9999999)}`,
        paystackRef: paymentResponse.data.reference,
        user: user.id,
        amount: plan.amount,
        plan: plan._id
    });

    return makeResponse(true, "Payment link generated", {
        payment,
        charge: initialConfig,
        link: paymentResponse.data.authorization_url,
    });
};

// export const verifyFlw = async (payload: { tx_ref?: string }) => {
//   const payment = await paymentRepository.findPaymentByMatch({
//     reference: payload.tx_ref,
//   });
//   if (!payment) {
//     return makeResponse(false, "Payment not found for reference!", {}, 404);
//   }
//   if (payment.status === PaymentStatus.Completed) {
//     return makeResponse(false, "Payment already verified!", {}, 400);
//   }

//   const user = await findUserById(payment.user);
//   if (!user) {
//     return makeResponse(false, "User not found!", {}, 404);
//   }

//   const response = await verifyTransaction({
//     reference: payload.tx_ref!,
//   });

//   if (!response || response.status === FlutterwaveStatus.Error) {
//     return makeResponse(false, "Transaction not found for reference!", {});
//   }

//   if (
//     response.status === FlutterwaveStatus.Success &&
//     response.data.status === FlutterwaveStatus.Successful &&
//     response.data.currency === "NGN" &&
//     response.data.charged_amount >= payment.amount
//   ) {
//     await paymentRepository.findPaymentByIdAndUpdate(payment._id!, {
//       status: PaymentStatus.Completed,
//       finalConfig: response,
//       paidAt: new Date(),
//       $push: {
//         history: {
//           description: "Payment made",
//           author: payment.user,
//           date: new Date(),
//         },
//       },
//     });

//     const order = await findOrderByIdAndUpdate(payment.order as string, {
//       status: OrderStatus.Paid,
//       $push: {
//         history: {
//           description: "Payment made",
//           author: payment.user,
//           date: new Date(),
//         },
//       },
//     });
//     if (!order) {
//       return makeResponse(false, "Order not found!", {}, 404);
//     }

//     // TODO: Send email notification to user
//     await new Email().paymentSuccessful(user, order);
//     return makeResponse(true, "Payment successful.", {});
//   } else if (response.data.status === FlutterwaveStatus.Failed) {
//     await paymentRepository.findPaymentByIdAndUpdate(payment._id!, {
//       status: PaymentStatus.Failed,
//       finalConfig: response,
//       history: {
//         description: "Payment failed!",
//         createdAt: new Date(),
//         author: payment.user,
//       },
//     });

//     await findOrderByIdAndUpdate(payment.order as string, {
//       status: OrderStatus.Failed,
//       $push: {
//         history: {
//           description: "Payment failed",
//           author: payment.user,
//           date: new Date(),
//         },
//       },
//     });

//     return makeResponse(false, "Payment failed!", {});
//   }

//   return makeResponse(false, "Payment failed!", {});
// };