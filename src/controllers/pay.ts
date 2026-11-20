import { Request, Response } from "express";
import * as commission from "../services/commission.js";
import * as payService from "../services/pay.js";
import { getClientIp } from "../utils/clientIp.js";
import { sendSuccessResponse } from "../utils/response.js";

const orgId = (req: Request) => req.params["_id"]!;
const staffId = (req: Request) => req.params["staffId"]!;
const benefitId = (req: Request) => req.params["benefitId"]!;
const DEFAULT_HEADCOUNT_MONTHS = 12;

const packageInput = (req: Request): payService.PayPackageInput => {
  const {
    currency,
    period,
    baseSalary,
    bonusPerYear,
    commissionTargetPerYear,
    startsOn,
    benefitIds,
    commissionPlanId,
  } = req.body;
  return {
    currency,
    period,
    baseSalary,
    bonus: bonusPerYear,
    commissionTarget: commissionTargetPerYear,
    startsOn,
    benefitIds: benefitIds ?? [],
    commissionPlanId: commissionPlanId ?? null,
  };
};

export const getPay = async (req: Request, res: Response) => {
  const pay = await payService.getPay(req.user, orgId(req), staffId(req), getClientIp(req));
  sendSuccessResponse(res, "Pay fetched", pay);
};

export const setPay = async (req: Request, res: Response) => {
  const pay = await payService.setPayPackage(req.user, orgId(req), staffId(req), packageInput(req));
  sendSuccessResponse(res, "Pay saved", pay);
};

export const addShareGrant = async (req: Request, res: Response) => {
  const { shares, grantedOn, cliffMonths, vestingMonths, strikePrice, currency } = req.body;
  const grant = await payService.addShareGrant(req.user, orgId(req), staffId(req), {
    shares,
    grantedOn,
    cliffMonths,
    vestingMonths,
    strikePrice,
    currency,
  });
  sendSuccessResponse(res, "Share grant added", { grant }, 201);
};

export const deleteShareGrant = async (req: Request, res: Response) => {
  await payService.deleteShareGrant(req.user, orgId(req), staffId(req), req.params["grantId"]!);
  sendSuccessResponse(res, "Share grant removed");
};

export const headcountCost = async (req: Request, res: Response) => {
  const cost = await payService.getHeadcountCost(
    req.user,
    orgId(req),
    getClientIp(req),
    Number(req.query["months"] ?? DEFAULT_HEADCOUNT_MONTHS)
  );
  sendSuccessResponse(res, "Headcount cost fetched", cost);
};

export const listBenefits = async (req: Request, res: Response) => {
  const benefits = await payService.listBenefits(req.user.id, orgId(req));
  sendSuccessResponse(res, "Benefits fetched", { benefits });
};

export const createBenefit = async (req: Request, res: Response) => {
  const { name, description } = req.body;
  const benefit = await payService.createBenefit(req.user.id, orgId(req), {
    name,
    description: description ?? null,
  });
  sendSuccessResponse(res, "Benefit added", { benefit }, 201);
};

export const updateBenefit = async (req: Request, res: Response) => {
  const { name, description } = req.body;
  const benefit = await payService.updateBenefit(req.user.id, orgId(req), benefitId(req), {
    name,
    description,
  });
  sendSuccessResponse(res, "Benefit updated", { benefit });
};

export const deleteBenefit = async (req: Request, res: Response) => {
  await payService.deleteBenefit(req.user.id, orgId(req), benefitId(req));
  sendSuccessResponse(res, "Benefit deleted");
};

const planInput = (req: Request): commission.CommissionPlanInput => {
  const { name, paidOn, frequency, bands } = req.body;
  return {
    name,
    paidOn,
    frequency,
    bands: (bands as commission.CommissionPlanInput["bands"]).map(
      ({ fromAmount, toAmount, ratePercent }) => ({ fromAmount, toAmount, ratePercent })
    ),
  };
};

export const listCommissionPlans = async (req: Request, res: Response) => {
  const plans = await commission.listPlans(req.user.id, orgId(req));
  sendSuccessResponse(res, "Commission plans fetched", { plans });
};

export const createCommissionPlan = async (req: Request, res: Response) => {
  const plan = await commission.createPlan(req.user.id, orgId(req), planInput(req));
  sendSuccessResponse(res, "Commission plan added", { plan }, 201);
};

export const updateCommissionPlan = async (req: Request, res: Response) => {
  const plan = await commission.updatePlan(
    req.user.id,
    orgId(req),
    req.params["planId"]!,
    planInput(req)
  );
  sendSuccessResponse(res, "Commission plan saved", { plan });
};

export const deleteCommissionPlan = async (req: Request, res: Response) => {
  await commission.deletePlan(req.user.id, orgId(req), req.params["planId"]!);
  sendSuccessResponse(res, "Commission plan deleted");
};
