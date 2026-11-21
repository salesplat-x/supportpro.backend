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
import { findPlan } from "./commission.js";
import { assertOwner } from "./peopleAccess.js";
import { activityEntry, logStaffAccess, openStaff, recordActivities } from "./staffAudit.js";
import { findStaff, fullNameOf, isUniqueViolation } from "./staffRecord.js";

/** Salary follows the period; bonus and commission target are always yearly. */
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
  commissionPlanId: string | null;
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
  totalYearly: number;
  commissionPlanId: string | null;
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

export const money = (currency: string, amount: number): string =>
  `${currency} ${(Number.isInteger(amount) ? wholeAmount : fractionalAmount).format(amount)}`;

export const longDate = (dateOnly: string): string =>
  new Date(`${dateOnly}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

const periodFactor = (period: PayPeriod): number => (period === PayPeriod.Monthly ? 12 : 1);

const roundMoney = (amount: number): number => Math.round(amount * 100) / 100;

/** Older monthly rows stored bonus and target per month; reads always see yearly amounts. */
export const yearlyExtras = (
  pkg: Pick<PayPackage, "period" | "bonus" | "commissionTarget" | "extrasYearly">
): { bonus: number; commissionTarget: number } => {
  const factor = pkg.extrasYearly ? 1 : periodFactor(pkg.period);
  return {
    bonus: roundMoney(pkg.bonus * factor),
    commissionTarget: roundMoney(pkg.commissionTarget * factor),
  };
};

export const payParagraph = (terms: PayTerms, benefitNames: string[]): string => {
  const per = PERIOD_WORDS[terms.period];
  const sentences = [`Your base salary is ${money(terms.currency, terms.baseSalary)} ${per}.`];
  if (terms.bonus > 0) {
    sentences.push(
      `You are eligible for a bonus of ${money(terms.currency, terms.bonus)} per year.`
    );
  }
  if (terms.commissionTarget > 0) {
    sentences.push(
      `Your commission target is ${money(terms.currency, terms.commissionTarget)} per year.`
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
  const terms: PayTerms = {
    currency: pkg.currency,
    period: pkg.period,
    baseSalary: pkg.baseSalary,
    ...yearlyExtras(pkg),
    startsOn: pkg.startsOn,
  };
  return {
    id: pkg.id,
    commissionPlanId: pkg.commissionPlanId,
    ...terms,
    totalYearly: roundMoney(
      terms.baseSalary * periodFactor(terms.period) + terms.bonus + terms.commissionTarget
    ),
    benefits,
    paragraph: payParagraph(
      terms,
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

export const assertNotEnded = (staff: StaffMember): void => {
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
  const staff = await openStaff(actor, organizationId, staffId, StaffAccessResource.Pay, ip);
  const pay = await loadPay(staffId);
  if (pay.grants.length > 0) {
    await logStaffAccess({
      organizationId,
      actor,
      staff,
      resource: StaffAccessResource.ShareOptions,
      ip,
    });
  }
  return pay;
};

export const setPayPackage = async (
  actor: User,
  organizationId: string,
  staffId: string,
  input: PayPackageInput
): Promise<PayView> => {
  await assertOwner(actor.id, organizationId);
  await AppDataSource.transaction(async (em) => {
    const staff = await findStaff(organizationId, staffId, { em, lock: true });
    assertNotEnded(staff);
    const benefits = await loadBenefits(em, organizationId, input.benefitIds);
    if (input.commissionPlanId) {
      await findPlan(organizationId, input.commissionPlanId).catch((err: unknown) => {
        if (err instanceof NotFoundError) {
          throw new ValidationError("Choose a commission plan from your company's list");
        }
        throw err;
      });
    }
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
      extrasYearly: true,
      commissionPlanId: input.commissionPlanId,
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
  await assertOwner(actor.id, organizationId);
  return AppDataSource.transaction(async (em) => {
    const staff = await findStaff(organizationId, staffId, { em, lock: true });
    assertNotEnded(staff);
    const grant = await em.getRepository(ShareGrant).save(
      em.getRepository(ShareGrant).create({
        staffId,
        ...input,
        createdById: actor.id,
        createdByName: fullNameOf(actor),
      })
    );
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
  await assertOwner(actor.id, organizationId);
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

export interface BenefitView extends Benefit {
  givenTo: number;
}

export const listBenefits = async (
  userId: string,
  organizationId: string
): Promise<BenefitView[]> => {
  await assertOwner(userId, organizationId);
  const [benefits, counts]: [Benefit[], Array<{ benefit_id: string; given_to: string }>] =
    await Promise.all([
      AppDataSource.getRepository(Benefit).find({
        where: { organizationId },
        order: { name: "ASC" },
      }),
      AppDataSource.query(
        `WITH current_pay AS (
           SELECT DISTINCT ON (p.staff_id) p.id
           FROM pay_packages p
           JOIN staff_members s ON s.id = p.staff_id
           WHERE s.organization_id = $1 AND s.status <> 'ended' AND p.starts_on <= $2
           ORDER BY p.staff_id, p.starts_on DESC
         )
         SELECT pb.benefit_id, COUNT(*) AS given_to
         FROM pay_package_benefits pb
         JOIN current_pay cp ON cp.id = pb.pay_package_id
         GROUP BY pb.benefit_id`,
        [organizationId, todayUtc()]
      ),
    ]);
  const givenTo = new Map(counts.map((row) => [row.benefit_id, Number(row.given_to)]));
  return benefits.map((benefit) =>
    Object.assign(benefit, { givenTo: givenTo.get(benefit.id) ?? 0 })
  );
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
  await assertOwner(userId, organizationId);
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
  await assertOwner(userId, organizationId);
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
  await assertOwner(userId, organizationId);
  const benefit = await findBenefit(organizationId, benefitId);
  await AppDataSource.getRepository(Benefit).delete(benefit.id);
};

export interface HeadcountCostRow {
  currency: string;
  department: string | null;
  staffCount: number;
  baseSalary: number;
  bonus: number;
  commissionTarget: number;
  total: number;
}

export interface HeadcountPeople {
  count: number;
  names: string[];
}

export interface HeadcountCost {
  totals: HeadcountCostRow[];
  departments: HeadcountCostRow[];
  headcount: number;
  invited: HeadcountPeople;
  left: HeadcountPeople;
  byMonth: { month: string; headcount: number }[];
}

const HEADCOUNT_NAMES_SHOWN = 3;

const HEADCOUNT_ALL_STAFF = "all staff";

export const getHeadcountCost = async (
  actor: User,
  organizationId: string,
  ip: string,
  months: number
): Promise<HeadcountCost> => {
  await assertOwner(actor.id, organizationId);
  await logStaffAccess({
    organizationId,
    actor,
    staff: { id: null, fullName: HEADCOUNT_ALL_STAFF },
    resource: StaffAccessResource.HeadcountCost,
    ip,
  });

  const rows: Array<Record<string, string | null> & { is_total: boolean }> =
    await AppDataSource.query(
      `WITH current_pay AS (
         SELECT DISTINCT ON (p.staff_id)
           p.currency, s.department,
           p.base_salary * m.factor AS base_salary,
           p.bonus * m.extras_factor AS bonus,
           p.commission_target * m.extras_factor AS commission_target
         FROM pay_packages p
         JOIN staff_members s ON s.id = p.staff_id
         CROSS JOIN LATERAL (
           SELECT CASE p.period WHEN 'monthly' THEN 12 ELSE 1 END AS factor,
             CASE WHEN p.period = 'monthly' AND NOT p.extras_yearly THEN 12 ELSE 1 END
               AS extras_factor
         ) m
         WHERE s.organization_id = $1 AND s.status <> 'ended' AND p.starts_on <= $2
         ORDER BY p.staff_id, p.starts_on DESC
       )
       SELECT currency, department, GROUPING(department) = 1 AS is_total,
         COUNT(*) AS staff_count,
         SUM(base_salary) AS base_salary,
         SUM(bonus) AS bonus,
         SUM(commission_target) AS commission_target
       FROM current_pay
       GROUP BY GROUPING SETS ((currency, department), (currency))
       ORDER BY currency, is_total DESC, department NULLS LAST`,
      [organizationId, todayUtc()]
    );

  const toRow = (row: (typeof rows)[number]): HeadcountCostRow => {
    const baseSalary = Number(row["base_salary"]);
    const bonus = Number(row["bonus"]);
    const commissionTarget = Number(row["commission_target"]);
    return {
      currency: row["currency"]!,
      department: row["department"] ?? null,
      staffCount: Number(row["staff_count"]),
      baseSalary,
      bonus,
      commissionTarget,
      total: Math.round((baseSalary + bonus + commissionTarget) * 100) / 100,
    };
  };

  const today = todayUtc();
  const [byMonth, invited, left] = await Promise.all([
    AppDataSource.query(
      `WITH month_ends AS (
         SELECT LEAST(
           (date_trunc('month', $2::date) - (g * interval '1 month') + interval '1 month'
             - interval '1 day')::date,
           $2::date
         ) AS cutoff
         FROM generate_series($3::int - 1, 0, -1) AS g
       )
       SELECT to_char(m.cutoff, 'YYYY-MM') AS month, COUNT(s.id) AS headcount
       FROM month_ends m
       LEFT JOIN staff_members s ON s.organization_id = $1
         AND s.status <> 'invited'
         AND s.start_date <= m.cutoff
         AND (s.end_date IS NULL OR s.end_date > m.cutoff)
       GROUP BY m.cutoff
       ORDER BY m.cutoff`,
      [organizationId, today, months]
    ) as Promise<{ month: string; headcount: string }[]>,
    AppDataSource.query(
      `SELECT full_name FROM staff_members
       WHERE organization_id = $1 AND status = 'invited'
       ORDER BY start_date, full_name`,
      [organizationId]
    ) as Promise<{ full_name: string }[]>,
    AppDataSource.query(
      `SELECT full_name FROM staff_members
       WHERE organization_id = $1 AND status = 'ended'
         AND end_date <= $2::date AND end_date > $2::date - ($3::int * interval '1 month')
       ORDER BY end_date DESC, full_name`,
      [organizationId, today, months]
    ) as Promise<{ full_name: string }[]>,
  ]);
  const people = (list: { full_name: string }[]): HeadcountPeople => ({
    count: list.length,
    names: list.slice(0, HEADCOUNT_NAMES_SHOWN).map((row) => row.full_name),
  });

  return {
    totals: rows.filter((row) => row.is_total).map(toRow),
    departments: rows.filter((row) => !row.is_total).map(toRow),
    headcount: Number(byMonth[byMonth.length - 1]?.headcount ?? 0),
    invited: people(invited),
    left: people(left),
    byMonth: byMonth.map((row) => ({ month: row.month, headcount: Number(row.headcount) })),
  };
};
