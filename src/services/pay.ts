import { EntityManager, In } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Benefit } from "../entities/Benefit.js";
import { PayPackage, PayPeriod } from "../entities/PayPackage.js";
import { ShareGrant } from "../entities/ShareGrant.js";
import { StaffAccessResource } from "../entities/StaffAccessLog.js";
import { StaffActivityType } from "../entities/StaffActivity.js";
import { StaffMember, StaffStatus } from "../entities/StaffMember.js";
import type { User } from "../entities/User.js";
import { ConflictError, NotFoundError, ValidationError } from "../utils/errors";
import { assertCanManagePeople } from "./peopleAccess.js";
import { activityEntry, openStaff, recordActivities } from "./staffAudit.js";
import { findStaff, isUniqueViolation } from "./staffRecord.js";

export interface PayTerms {
  currency: string;
  period: PayPeriod;
  baseSalary: number;
  bonus: number;
  commissionTarget: number;
  startsOn: string;
}

export interface PayPackageInput extends PayTerms {
  benefitIds: string[];
}

export interface BenefitInput {
  name?: string;
  description?: string | null;
}

export interface ShareGrantInput {
  shares: number;
  grantedOn: string;
  cliffMonths: number;
  vestingMonths: number;
  strikePrice: number;
  currency: string;
}

export interface PayPackageView extends PayTerms {
  id: string;
  benefits: { id: string; name: string }[];
  paragraph: string;
  createdAt: Date;
}

export interface PayView {
  currentPackageId: string | null;
  packages: PayPackageView[];
  grants: ShareGrant[];
}

const PERIOD_WORDS: Record<PayPeriod, string> = {
  [PayPeriod.Monthly]: "per month",
  [PayPeriod.Yearly]: "per year",
};

const wholeAmount = new Intl.NumberFormat("en-NG", { maximumFractionDigits: 0 });
const fractionalAmount = new Intl.NumberFormat("en-NG", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const money = (currency: string, amount: number): string =>
  `${currency} ${(Number.isInteger(amount) ? wholeAmount : fractionalAmount).format(amount)}`;

const longDate = (dateOnly: string): string =>
  new Date(`${dateOnly}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

export const payParagraph = (terms: PayTerms, benefitNames: string[]): string => {
  const per = PERIOD_WORDS[terms.period];
  const sentences = [`Your base salary is ${money(terms.currency, terms.baseSalary)} ${per}.`];
  if (terms.bonus > 0) {
    sentences.push(`You are eligible for a bonus of ${money(terms.currency, terms.bonus)} ${per}.`);
  }
  if (terms.commissionTarget > 0) {
    sentences.push(
      `Your commission target is ${money(terms.currency, terms.commissionTarget)} ${per}.`
    );
  }
  sentences.push(`This package starts on ${longDate(terms.startsOn)}.`);
  if (benefitNames.length > 0) {
    sentences.push(`You also receive: ${benefitNames.join(", ")}.`);
  }
  return sentences.join(" ");
};

const todayUtc = (): string => new Date().toISOString().slice(0, 10);

export const currentPackage = <T extends Pick<PayPackage, "startsOn">>(packages: T[]): T | null => {
  const today = todayUtc();
  const byStart = [...packages].sort((a, b) => a.startsOn.localeCompare(b.startsOn));
  const started = byStart.filter((pkg) => pkg.startsOn <= today);
  return started[started.length - 1] ?? byStart[0] ?? null;
};

const toPackageView = (pkg: PayPackage): PayPackageView => {
  const benefits = [...pkg.benefits]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ id, name }) => ({ id, name }));
  return {
    id: pkg.id,
    currency: pkg.currency,
    period: pkg.period,
    baseSalary: pkg.baseSalary,
    bonus: pkg.bonus,
    commissionTarget: pkg.commissionTarget,
    startsOn: pkg.startsOn,
    benefits,
    paragraph: payParagraph(
      pkg,
      benefits.map((benefit) => benefit.name)
    ),
    createdAt: pkg.createdAt,
  };
};

export const loadPay = async (staffId: string): Promise<PayView> => {
  const [packages, grants] = await Promise.all([
    AppDataSource.getRepository(PayPackage).find({
      where: { staffId },
      relations: { benefits: true },
      order: { startsOn: "DESC" },
    }),
    AppDataSource.getRepository(ShareGrant).find({
      where: { staffId },
      order: { grantedOn: "DESC", createdAt: "DESC" },
    }),
  ]);
  return {
    currentPackageId: currentPackage(packages)?.id ?? null,
    packages: packages.map(toPackageView),
    grants,
  };
};

const assertNotEnded = (staff: StaffMember): void => {
  if (staff.status === StaffStatus.Ended) {
    throw new ConflictError("This person's employment has ended");
  }
};

const loadBenefits = async (
  em: EntityManager,
  organizationId: string,
  benefitIds: string[]
): Promise<Benefit[]> => {
  const ids = [...new Set(benefitIds)];
  if (ids.length === 0) return [];
  const benefits = await em.getRepository(Benefit).find({ where: { id: In(ids), organizationId } });
  if (benefits.length !== ids.length) {
    throw new ValidationError("Choose benefits from your company's list");
  }
  return benefits;
};

export const getPay = async (
  actor: User,
  organizationId: string,
  staffId: string,
  ip: string
): Promise<PayView> => {
  await openStaff(actor, organizationId, staffId, StaffAccessResource.Pay, ip);
  return loadPay(staffId);
};

export const previewPayParagraph = async (
  actor: User,
  organizationId: string,
  input: PayPackageInput
): Promise<string> => {
  await assertCanManagePeople(actor.id, organizationId);
  const benefits = await loadBenefits(AppDataSource.manager, organizationId, input.benefitIds);
  return payParagraph(
    input,
    benefits.map((benefit) => benefit.name).sort((a, b) => a.localeCompare(b))
  );
};

export const setPayPackage = async (
  actor: User,
  organizationId: string,
  staffId: string,
  input: PayPackageInput
): Promise<PayView> => {
  await assertCanManagePeople(actor.id, organizationId);
  await AppDataSource.transaction(async (em) => {
    const staff = await findStaff(organizationId, staffId, { em, lock: true });
    assertNotEnded(staff);
    const benefits = await loadBenefits(em, organizationId, input.benefitIds);
    const repo = em.getRepository(PayPackage);
    const existing = await repo.findOne({ where: { staffId, startsOn: input.startsOn } });
    const pkg =
      existing ?? repo.create({ staffId, startsOn: input.startsOn, createdById: actor.id });
    Object.assign(pkg, {
      currency: input.currency,
      period: input.period,
      baseSalary: input.baseSalary,
      bonus: input.bonus,
      commissionTarget: input.commissionTarget,
      benefits,
    });
    await repo.save(pkg);
    await recordActivities(em, staff, [
      activityEntry(StaffActivityType.PaySet, actor, { startsOn: input.startsOn }),
    ]);
  });
  return loadPay(staffId);
};

export const addShareGrant = async (
  actor: User,
  organizationId: string,
  staffId: string,
  input: ShareGrantInput
): Promise<ShareGrant> => {
  await assertCanManagePeople(actor.id, organizationId);
  return AppDataSource.transaction(async (em) => {
    const staff = await findStaff(organizationId, staffId, { em, lock: true });
    assertNotEnded(staff);
    const grant = await em
      .getRepository(ShareGrant)
      .save(em.getRepository(ShareGrant).create({ staffId, ...input }));
    await recordActivities(em, staff, [
      activityEntry(StaffActivityType.ShareGrantAdded, actor, { shares: input.shares }),
    ]);
    return grant;
  });
};

export const deleteShareGrant = async (
  actor: User,
  organizationId: string,
  staffId: string,
  grantId: string
): Promise<void> => {
  await assertCanManagePeople(actor.id, organizationId);
  await AppDataSource.transaction(async (em) => {
    const staff = await findStaff(organizationId, staffId, { em, lock: true });
    const grant = await em.getRepository(ShareGrant).findOne({ where: { id: grantId, staffId } });
    if (!grant) {
      throw new NotFoundError("Share grant not found");
    }
    await em.getRepository(ShareGrant).delete(grant.id);
    await recordActivities(em, staff, [
      activityEntry(StaffActivityType.ShareGrantRemoved, actor, { shares: grant.shares }),
    ]);
  });
};

export const listBenefits = async (userId: string, organizationId: string): Promise<Benefit[]> => {
  await assertCanManagePeople(userId, organizationId);
  return AppDataSource.getRepository(Benefit).find({
    where: { organizationId },
    order: { name: "ASC" },
  });
};

const assertBenefitNameFree = async (
  organizationId: string,
  name: string,
  exceptId?: string
): Promise<void> => {
  const clash = await AppDataSource.getRepository(Benefit)
    .createQueryBuilder("benefit")
    .where("benefit.organizationId = :organizationId", { organizationId })
    .andWhere("LOWER(benefit.name) = LOWER(:name)", { name })
    .andWhere(exceptId ? "benefit.id <> :exceptId" : "TRUE", { exceptId })
    .getExists();
  if (clash) {
    throw new ConflictError("Your company already has a benefit with this name");
  }
};

const saveBenefit = async (benefit: Benefit): Promise<Benefit> => {
  try {
    return await AppDataSource.getRepository(Benefit).save(benefit);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError("Your company already has a benefit with this name");
    }
    throw err;
  }
};

export const createBenefit = async (
  userId: string,
  organizationId: string,
  input: Required<BenefitInput>
): Promise<Benefit> => {
  await assertCanManagePeople(userId, organizationId);
  await assertBenefitNameFree(organizationId, input.name);
  return saveBenefit(
    AppDataSource.getRepository(Benefit).create({
      organizationId,
      name: input.name,
      description: input.description || null,
    })
  );
};

const findBenefit = async (organizationId: string, benefitId: string): Promise<Benefit> => {
  const benefit = await AppDataSource.getRepository(Benefit).findOne({
    where: { id: benefitId, organizationId },
  });
  if (!benefit) {
    throw new NotFoundError("Benefit not found");
  }
  return benefit;
};

export const updateBenefit = async (
  userId: string,
  organizationId: string,
  benefitId: string,
  input: BenefitInput
): Promise<Benefit> => {
  await assertCanManagePeople(userId, organizationId);
  const benefit = await findBenefit(organizationId, benefitId);
  if (input.name !== undefined) {
    await assertBenefitNameFree(organizationId, input.name, benefitId);
    benefit.name = input.name;
  }
  if (input.description !== undefined) {
    benefit.description = input.description || null;
  }
  return saveBenefit(benefit);
};

export const deleteBenefit = async (
  userId: string,
  organizationId: string,
  benefitId: string
): Promise<void> => {
  await assertCanManagePeople(userId, organizationId);
  const benefit = await findBenefit(organizationId, benefitId);
  await AppDataSource.getRepository(Benefit).delete(benefit.id);
};
