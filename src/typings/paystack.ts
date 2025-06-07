export interface IPaystackConfig {
    amount: number;
    email: string;
    currency?: string;
    reference?: string;
    callback_url?: string;
    metadata?: Record<string, string>;
    channels?: string[];
    split_code?: string;
    subaccount?: string;
    transaction_charge?: string;
    bearer?: string;
    plan?: string;
}

export interface IPaystackInitRes {
    status: boolean;
    message: string;
    data: {
        authorization_url: string;
        access_code: string;
        reference: string;
    };
}

export const PaymentVerificationStatus = {
    ChargeCompleted: "charge.completed",
    TransferCompleted: "transfer.completed",
    Successful: "successful",
    Success: "success",
    Failed: "failed",
    Error: "error",
} as const;