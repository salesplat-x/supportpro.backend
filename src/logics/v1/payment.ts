import * as paymentRepository from "../../repository/v1/payment";
import * as subscriptionRepository from "../../repository/v1/subscription";
import * as paystackService from "../../services/v1/paystack";
import * as planRepository from "../../repository/v1/plan"
import { makeResponse } from "../../helpers/response";
import { IUser } from "../../typings/user";
import { PaymentMethod, PaymentStatus } from "../../typings/payment";
import { PaymentVerificationStatus } from "../../typings/paystack";
import Email from "../../services/v1/email";
import {findUserById, findUserByMatch} from "../../repository/v1/user";
import * as repository from "../../repository/v1/plan";


export const verify = async (payload: {id: string}) => {
    const payment = await paymentRepository.findPaymentById(payload.id);
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
        reference: payment.paystackRef!,
    });

    console.log(response)

    if (!response || !response.status) {
        return makeResponse(false, "Unable to verify payment!", {});
    }

    const plan = await repository.findPlanByMatch({ paystackPlanCode: response.data.plan })

    if (
        response.data.status === "success" &&
        response.data.currency === "NGN" &&
        response.data.amount >= payment.amount
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
    data: Record<string, any>;
}) => {
    const { event, data } = payload;
    if (event === "charge.success" && data.status === "success") {
        const payment = await paymentRepository.findPaymentByMatch({
            $or: [{ paystackRef: data.reference }, { reference: data.reference }],
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
        //return makeResponse(true, "Payment successful.");
    }

    if (event === "subscription.create" && data.status === "active"){
        const plan = await planRepository.findPlanByMatch({
            paystackPlanCode: data.plan.plan_code,
        })
        const user = await findUserByMatch({
            email: data.customer.email
        });
        if (!user) {
            return makeResponse(false, "User not found!", {}, 404);
        }
        const payment = await paymentRepository.findPaymentByMatch({
            plan: plan?._id,
            user: user?._id
        })
        if (!payment) {
            return makeResponse(false, "Payment not found for reference!", {}, 404);
        }


        console.log("enter db");
        const reply =  await subscriptionRepository.createSubscription({
            user: payment?.user.toString(),
            plan: payment?.plan.toString(),
            paystackSubscriptionCode: data.subscription_code,
            authorizationCode: data.authorization?.authorization_code,
            status: data.status,
            startDate: data.createdAt,
            nextPaymentDate: data.next_payment_date,
            cron_expression: data.cron_expression
        });
        //return makeResponse(true, "Subscription created successful.");
    }

};

export const initiateTransaction = async (user: IUser, payload: { planId: string }) => {
    let plan = await repository.findPlanById(payload.planId);
    if (!plan) {
        return makeResponse(false, `Plan ${plan}not found`, {}, 404);
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
