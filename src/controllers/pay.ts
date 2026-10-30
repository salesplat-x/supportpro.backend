import { Request, Response } from "express";
import * as payService from "../services/pay.js";
import { getClientIp } from "../utils/clientIp.js";
import { sendSuccessResponse } from "../utils/response.js";

const orgId = (req: Request) => req.params["_id"]!;
const staffId = (req: Request) => req.params["staffId"]!;
const benefitId = (req: Request) => req.params["benefitId"]!;

const packageInput = (req: Request): payService.PayPackageInput => {
  const { currency, period, baseSalary, bonus, commissionTarget, startsOn, benefitIds } = req.body;
  return {
    currency,
    period,
    baseSalary,
    bonus: bonus ?? 0,
    commissionTarget: commissionTarget ?? 0,
    startsOn,
    benefitIds: benefitIds ?? [],
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

export const previewParagraph = async (req: Request, res: Response) => {
  const paragraph = await payService.previewPayParagraph(req.user, orgId(req), packageInput(req));
  sendSuccessResponse(res, "Pay paragraph ready", { paragraph });
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
