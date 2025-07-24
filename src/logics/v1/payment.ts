import * as paymentRepository from "../../repository/v1/payment";
import * as subscriptionRepository from "../../repository/v1/subscription";
import * as paystackService from "../../services/v1/paystack";
import * as planRepository from "../../repository/v1/plan"
import { makeResponse } from "../../helpers/response";
import { IUser } from "../../typings/user";
import { PaymentStatus } from "../../typings/payment";
import { IPaystackConfig, PaymentVerificationStatus } from "../../typings/paystack";
import {findUserById, findUserByMatch} from "../../repository/v1/user";
import * as repository from "../../repository/v1/plan";
import { generateReference } from "../../helpers/func";
import { IPlan } from "../../typings/plan";
import { SubscriptionStatus } from "../../typings/subscription";
import { createSubscription } from "./subscription";
import { hasRunningSubscription } from "./subscription";

export const paymentRecords = async (user: IUser) => {
    const payments = await paymentRepository.findPaymentsByMatch({user: user.id});

    return makeResponse(true, "Payment history fetched", {payments});
};

export const verify = async (payload: {reference: string}) => {
    const payment = await paymentRepository.findPaymentByMatch({paystackRef: payload.reference});
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

    if (!response || !response.status) {
        return makeResponse(false, "Unable to verify payment!", {});
    }


    if (
        response.data.status === "success" &&
        response.data.currency === payment.currency &&
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

        // create subscription if payment was for a plan
        if ( response.data.plan && payment.plan ){
            const result = await createSubscription(user, payment.plan as string, response.data.authorization.authorization_code)

            if (!result.status) return result
        }

        return makeResponse(true, "Verification successful.");
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

        // If payment is for a plan, create Paystack subscription
        if (payment.plan) {     
            const authorizationCode = data.authorization?.authorization_code;
            await createSubscription(user, payment.plan as string, authorizationCode)         
        }
        return makeResponse(true, "Payment processed successfully.", {});
    }

    if (event === "subscription.create" && data.status === "active") {
        try {
            const existingSubscription = await subscriptionRepository.findSubscriptionByMatch({
                paystackSubscriptionCode: data.subscription_code
            });
            
            if (existingSubscription) {
                await subscriptionRepository.findSubscriptionByIdAndUpdate(existingSubscription._id!, {
                    status: data.status,
                    startDate: new Date(data.start),
                    nextPaymentDate: data.next_payment_date,
                    cron_expression: data.cron_expression,
                    email_token: data.email_token,
                    $push: {
                        history: {
                            description: "Subscription activated",
                            author: existingSubscription.user,
                            date: new Date(),
                        },
                    },
                });
            } else {
                const plan = await planRepository.findPlanByMatch({
                    paystackPlanCode: data.plan.plan_code,
                });
                
                if (!plan) {
                    return makeResponse(false, "Plan not found for subscription!", {}, 404);
                }
                
                const user = await findUserByMatch({
                    email: data.customer.email
                });
                
                if (!user) {
                    return makeResponse(false, "User not found for subscription!", {}, 404);
                }
                
                await subscriptionRepository.createSubscription({
                    user: user._id,
                    plan: plan._id,
                    paystackSubscriptionCode: data.subscription_code,
                    authorizationCode: data.authorization?.authorization_code,
                    status: data.status,
                    startDate: new Date(data.start),
                    nextPaymentDate: data.next_payment_date,
                    cron_expression: data.cron_expression,
                    email_token: data.email_token
                });
            }
            
            return makeResponse(true, "Subscription created and stored successfully.", {});
            
        } catch (err) {
            return makeResponse(false, "Error processing subscription.create webhook", { error: err }, 500);
        }
    }

    if (event === "subscription.disable") {
        const subscription = await subscriptionRepository.findSubscriptionByMatch({
            paystackSubscriptionCode: data.subscription_code
        });
        
        if (subscription) {
            await subscriptionRepository.findSubscriptionByIdAndUpdate(subscription._id!, {
                status: SubscriptionStatus.Cancelled,
                $push: {
                    history: {
                        description: "Subscription disabled",
                        author: subscription.user,
                        date: new Date(),
                    },
                },
            });
        }
        
        return makeResponse(true, "Subscription disabled successfully.", {});
    }
    
    if (event === "subscription.enable") {
        const subscription = await subscriptionRepository.findSubscriptionByMatch({
            paystackSubscriptionCode: data.subscription_code
        });
        
        if (subscription) {
            await subscriptionRepository.findSubscriptionByIdAndUpdate(subscription._id!, {
                status: SubscriptionStatus.Active,
                $push: {
                    history: {
                        description: "Subscription enabled",
                        author: subscription.user,
                        date: new Date(),
                    },
                },
            });
        }
        
        return makeResponse(true, "Subscription enabled successfully.", {});
    }
};

export const initiateTransaction = async (user: IUser, payload: { amount?: number, planId?: string }) => {
    let plan: IPlan | null = null;
    let initialConfig: IPaystackConfig;
    const reference = await generateReference();

    if (payload.planId) {
        plan = await planRepository.findPlanByMatch({ _id: payload.planId, isDeleted: false });
        if (!plan) {
            return makeResponse(false, `Plan not found`, {}, 404);
        }

        const alreadySubscribed = await hasRunningSubscription(user, plan.id);
        if (alreadySubscribed) {
            return makeResponse(false, "You already have an active subscription for this plan.", {}, 409);
        }

        payload.amount = plan.paystackAmount;
        initialConfig = paystackService.generatePaymentObject(payload.amount, user.email, plan.paystackPlanCode);
    } else {
        if (!payload.amount) {
            return makeResponse(false, `Amount is required`);
        }
        initialConfig = paystackService.generatePaymentObject(payload.amount, user.email);
    }

    const paymentResponse = await paystackService.initializePayment(initialConfig);

    // create payment
    await paymentRepository.createPayment({
        ...initialConfig,
        paymentLink: paymentResponse.data.authorization_url,
        reference,
        paystackRef: paymentResponse.data.reference,
        user: user.id,
        ...{ plan: plan ? plan.id : undefined }
    });

    return makeResponse(true, "Payment link generated", {
        link: paymentResponse.data.authorization_url,
    });
};
