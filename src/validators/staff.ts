import { body, param, query, type ValidationChain } from "express-validator";
import { PayPeriod } from "../entities/PayPackage.js";
import { DocumentTemplate } from "../entities/StaffDocument.js";
import type { CommissionTier } from "../entities/CommissionPlan.js";
import { StaffStatus } from "../entities/StaffMember.js";
import { Currency } from "../types/enums.js";

const NO_LINE_BREAKS = /^[^\r\n]*$/;
export const NO_NUL = /^[^\0]*$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;
const MAX_TEXT = 120;
const MAX_EMAIL = 254;
const MAX_OFFSET = 1_000_000;

export const orgParam = param("_id").isUUID().withMessage("Invalid company id");
export const staffParam = param("staffId").isUUID().withMessage("Invalid staff id");
const benefitParam = param("benefitId").isUUID().withMessage("Invalid benefit id");
const grantParam = param("grantId").isUUID().withMessage("Invalid share grant id");
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
const MAX_DESCRIPTION = 500;
const MAX_BENEFITS = 50;
const MAX_MONTHS = 240;

const text = (chain: ValidationChain, label: string): ValidationChain =>
  chain
    .isString()
    .withMessage(`${label} must be text`)
    .bail()
    .trim()
    .isLength({ min: 1, max: MAX_TEXT })
    .withMessage(`${label} must be between 1 and ${MAX_TEXT} characters`)
    .bail()
    .matches(NO_LINE_BREAKS)
    .withMessage(`${label} can't contain line breaks`)
    .bail()
    .matches(NO_NUL)
    .withMessage(`${label} can't contain control characters`);

const nullableText = (chain: ValidationChain, label: string): ValidationChain =>
  chain
    .optional({ values: "null" })
    .isString()
    .withMessage(`${label} must be text`)
    .bail()
    .trim()
    .isLength({ max: MAX_TEXT })
    .withMessage(`${label} must be at most ${MAX_TEXT} characters`)
    .bail()
    .matches(NO_LINE_BREAKS)
    .withMessage(`${label} can't contain line breaks`)
    .bail()
    .matches(NO_NUL)
    .withMessage(`${label} can't contain control characters`);

export const dateOnly = (chain: ValidationChain, label: string): ValidationChain =>
  chain
    .isString()
    .matches(DATE_ONLY)
    .withMessage(`${label} must be a date like 2026-01-31`)
    .bail()
    .isISO8601({ strict: true, strictSeparator: true })
    .withMessage(`${label} is not a real date`)
    .bail()
    .custom((value: string) => {
      const year = Number(value.slice(0, 4));
      return year >= MIN_YEAR && year <= MAX_YEAR;
    })
    .withMessage(`${label} must be between ${MIN_YEAR} and ${MAX_YEAR}`);

const flag = (field: string, label: string): ValidationChain =>
  body(field)
    .optional()
    .isBoolean({ strict: true })
    .withMessage(`${label} must be true or false`)
    .bail()
    .toBoolean();

const once = (chain: ValidationChain, label: string): ValidationChain =>
  chain
    .optional()
    .custom((value: unknown) => typeof value === "string")
    .withMessage(`${label} can only be given once`)
    .bail();

export const pagination = [
  once(query("limit"), "limit")
    .isInt({ min: 1, max: 100 })
    .withMessage("limit must be 1-100")
    .toInt(),
  once(query("offset"), "offset")
    .isInt({ min: 0, max: MAX_OFFSET })
    .withMessage(`offset must be 0-${MAX_OFFSET}`)
    .toInt(),
];

const staffEmail = (chain: ValidationChain): ValidationChain =>
  chain
    .isString()
    .isLength({ max: MAX_EMAIL })
    .isEmail()
    .normalizeEmail()
    .withMessage("A valid email is required");

export const companyParamValidator = [orgParam];

export const staffOptionsValidator = [
  orgParam,
  once(query("includeEnded"), "includeEnded")
    .isIn(["true", "false"])
    .withMessage("includeEnded must be true or false")
    .bail()
    .toBoolean(),
];

export const listStaffValidator = [
  orgParam,
  ...pagination,
  query("assignedToMe").optional().isBoolean().withMessage("assignedToMe must be true or false"),
  once(query("status"), "status")
    .isIn(Object.values(StaffStatus))
    .withMessage(`status must be one of: ${Object.values(StaffStatus).join(", ")}`),
  query("search")
    .optional()
    .isString()
    .trim()
    .isLength({ max: 100 })
    .bail()
    .matches(NO_NUL)
    .withMessage("search can't contain control characters"),
];

export const createStaffValidator = [
  orgParam,
  text(body("fullName"), "Full name"),
  staffEmail(body("email")),
  text(body("jobTitle"), "Job title"),
  nullableText(body("department"), "Department"),
  body("managerId").optional({ values: "null" }).isUUID().withMessage("Invalid manager"),
  dateOnly(body("startDate"), "Start date"),
  flag("isExecutive", "isExecutive"),
  flag("sendInvite", "sendInvite"),
];

export const staffIdValidator = [orgParam, staffParam];

const MAX_ASSIGNMENT_BATCH = 200;

const uuidList = (field: "add" | "remove") => [
  body(field)
    .optional()
    .isArray({ max: MAX_ASSIGNMENT_BATCH })
    .withMessage(`You can change up to ${MAX_ASSIGNMENT_BATCH} people at a time`),
  body(`${field}.*`).isUUID().withMessage("Choose people from your list"),
];

export const assignedStaffValidator = [
  orgParam,
  query("assigneeUserId").isUUID().withMessage("Choose a teammate"),
];

export const setHrAssignmentsValidator = [
  orgParam,
  body("assigneeUserId").isUUID().withMessage("Choose a teammate"),
  ...uuidList("add"),
  ...uuidList("remove"),
];

export const updateStaffValidator = [
  orgParam,
  staffParam,
  text(body("fullName").optional(), "Full name"),
  text(body("jobTitle").optional(), "Job title"),
  nullableText(body("department"), "Department"),
  body("managerId").optional({ values: "null" }).isUUID().withMessage("Invalid manager"),
  dateOnly(body("startDate").optional(), "Start date"),
  flag("isExecutive", "isExecutive"),
];

export const endStaffValidator = [
  orgParam,
  staffParam,
  dateOnly(body("endDate").optional(), "End date"),
];

export const accessLogValidator = [
  orgParam,
  ...pagination,
  once(query("staffId"), "staffId").isUUID().withMessage("Invalid staff id"),
  once(query("actorId"), "actorId").isUUID().withMessage("Invalid person id"),
  dateOnly(query("from").optional(), "From date"),
  dateOnly(query("to").optional(), "To date"),
];

export const staffInviteTokenValidator = [
  param("token")
    .matches(/^[a-f0-9]{64}$/)
    .withMessage("This invite link is not valid"),
];

const amount = (field: string, label: string): ValidationChain =>
  body(field)
    .custom((value: unknown) => typeof value === "number" && MONEY.test(String(value)))
    .withMessage(`${label} must be an amount with at most 2 decimals`)
    .bail()
    .toFloat();

const optionalAmount = (field: string, label: string): ValidationChain =>
  amount(field, label).optional({ values: "null" });

const currency = (field: string): ValidationChain =>
  body(field)
    .isIn(Object.values(Currency))
    .withMessage(`Currency must be one of: ${Object.values(Currency).join(", ")}`);

const wholeNumber = (field: string, label: string, min: number, max: number): ValidationChain =>
  body(field)
    .isInt({ min, max })
    .withMessage(`${label} must be a whole number from ${min} to ${max}`)
    .bail()
    .toInt();

const payTerms = [
  currency("currency"),
  body("period").isIn(Object.values(PayPeriod)).withMessage("Choose monthly or yearly"),
  amount("baseSalary", "Base salary"),
  optionalAmount("bonus", "Bonus"),
  optionalAmount("commissionTarget", "Commission target"),
  dateOnly(body("startsOn"), "Start date"),
  body("benefitIds")
    .optional()
    .isArray({ max: MAX_BENEFITS })
    .withMessage(`Choose at most ${MAX_BENEFITS} benefits`),
  body("benefitIds.*").isUUID().withMessage("Invalid benefit"),
  body("commissionPlanId")
    .optional({ values: "null" })
    .isUUID()
    .withMessage("Invalid commission plan"),
];

export const payPreviewValidator = [orgParam, ...payTerms];

export const setPayValidator = [orgParam, staffParam, ...payTerms];

const benefitDescription = body("description")
  .optional({ values: "null" })
  .isString()
  .withMessage("Description must be text")
  .bail()
  .trim()
  .isLength({ max: MAX_DESCRIPTION })
  .withMessage(`Description must be at most ${MAX_DESCRIPTION} characters`)
  .bail()
  .matches(NO_NUL)
  .withMessage("Description can't contain control characters");

export const createBenefitValidator = [orgParam, text(body("name"), "Name"), benefitDescription];

export const updateBenefitValidator = [
  orgParam,
  benefitParam,
  text(body("name").optional(), "Name"),
  benefitDescription,
];

export const benefitIdValidator = [orgParam, benefitParam];

export const addShareGrantValidator = [
  orgParam,
  staffParam,
  wholeNumber("shares", "Number of shares", 1, 1_000_000_000),
  dateOnly(body("grantedOn"), "Grant date"),
  wholeNumber("vestingMonths", "Vesting period", 1, MAX_MONTHS),
  wholeNumber("cliffMonths", "Cliff", 0, MAX_MONTHS)
    .bail()
    .custom((cliff: number, { req }) => cliff <= Number(req.body.vestingMonths))
    .withMessage("The cliff can't be longer than the vesting period"),
  amount("strikePrice", "Strike price"),
  currency("currency"),
];

export const shareGrantIdValidator = [orgParam, staffParam, grantParam];

const MAX_TIERS = 10;
const MAX_PERCENT = 1000;

const isPercent = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;

const tiersProblem = (tiers: unknown): string | null => {
  if (!Array.isArray(tiers) || tiers.length < 1 || tiers.length > MAX_TIERS) {
    return `Add between 1 and ${MAX_TIERS} tiers`;
  }
  for (const [index, tier] of (tiers as CommissionTier[]).entries()) {
    const isLast = index === tiers.length - 1;
    const expectedFrom = index === 0 ? 0 : (tiers[index - 1] as CommissionTier).toPercent;
    if (typeof tier !== "object" || tier === null) return "Each tier needs its values";
    if (!isPercent(tier.fromPercent, MAX_PERCENT) || tier.fromPercent !== expectedFrom) {
      return index === 0
        ? "The first tier must start at 0% of target"
        : `Tier ${index + 1} must start where tier ${index} ends`;
    }
    if (isLast ? tier.toPercent !== null : !isPercent(tier.toPercent, MAX_PERCENT)) {
      return isLast ? "The last tier has no upper limit" : `Tier ${index + 1} needs an upper limit`;
    }
    if (!isLast && (tier.toPercent as number) <= tier.fromPercent) {
      return `Tier ${index + 1} must end above where it starts`;
    }
    if (!isPercent(tier.ratePercent, 100)) {
      return `Tier ${index + 1} needs a commission rate from 0% to 100%`;
    }
    if (tier.boost !== null && !(isPercent(tier.boost, 10) && tier.boost >= 1)) {
      return `Tier ${index + 1} boost must be from 1x to 10x`;
    }
  }
  return null;
};

const planBody = [
  text(body("name"), "Plan name"),
  body("tiers").custom((tiers: unknown) => {
    const problem = tiersProblem(tiers);
    if (problem) throw new Error(problem);
    return true;
  }),
];

const planParam = param("planId").isUUID().withMessage("Invalid commission plan id");

export const createCommissionPlanValidator = [orgParam, ...planBody];

export const updateCommissionPlanValidator = [orgParam, planParam, ...planBody];

export const commissionPlanIdValidator = [orgParam, planParam];

const templateValue = (chain: ValidationChain): ValidationChain =>
  chain
    .isIn(Object.values(DocumentTemplate))
    .withMessage(`Template must be one of: ${Object.values(DocumentTemplate).join(", ")}`);

const documentParam = param("documentId").isUUID().withMessage("Invalid document id");

export const previewDocumentValidator = [orgParam, staffParam, templateValue(query("template"))];

export const sendDocumentValidator = [orgParam, staffParam, templateValue(body("template"))];

export const staffDocumentValidator = [orgParam, staffParam, documentParam];

export const documentTokenValidator = [
  param("token")
    .matches(/^[a-f0-9]{64}$/)
    .withMessage("This link has expired or was already used"),
];

export const documentCheckValidator = [
  body("documentId").isUUID().withMessage("Enter the document ID from the signature page"),
  body("checkCode")
    .isString()
    .trim()
    .matches(/^[a-fA-F0-9]{64}$/)
    .withMessage("Enter the 64-character check code from the signature page"),
];

export const signDocumentValidator = [
  ...documentTokenValidator,
  text(body("fullName"), "Full name"),
  body("agree").equals("true").withMessage("Tick the box to agree to sign electronically"),
];

export const MAX_IMPORT_ROWS = 200;

export const importRowValidator = [
  text(body("fullName"), "Full name"),
  staffEmail(body("email")),
  text(body("jobTitle"), "Job title"),
  nullableText(body("department"), "Department"),
  staffEmail(body("managerEmail").optional({ values: "falsy" })).withMessage(
    "Manager email is not a valid email"
  ),
  dateOnly(body("startDate"), "Start date"),
];

export const importStaffValidator = [
  orgParam,
  body("rows")
    .isArray({ min: 1, max: MAX_IMPORT_ROWS })
    .withMessage(`Import between 1 and ${MAX_IMPORT_ROWS} rows at a time`),
  body("commit")
    .isBoolean({ strict: true })
    .withMessage("commit must be true or false")
    .toBoolean(),
];

const MAX_CHECKLIST_ITEMS = 30;
const MAX_DUE_IN_DAYS = 365;
const MAX_STATEMENT = 2000;
const MAX_GOALS = 10;
const MAX_GOAL = 500;

const taskParam = param("taskId").isUUID().withMessage("Invalid task id");

export const checklistDefaultsValidator = [
  orgParam,
  body("items")
    .isArray({ max: MAX_CHECKLIST_ITEMS })
    .withMessage(`Use at most ${MAX_CHECKLIST_ITEMS} tasks`),
  text(body("items.*.title"), "Task"),
  body("items.*.dueInDays")
    .isInt({ min: 0, max: MAX_DUE_IN_DAYS })
    .withMessage(`Due days must be a whole number from 0 to ${MAX_DUE_IN_DAYS}`)
    .toInt(),
];

export const addTaskValidator = [
  orgParam,
  staffParam,
  text(body("title"), "Task"),
  dateOnly(body("dueOn").optional({ values: "null" }), "Due date"),
];

export const taskIdValidator = [orgParam, staffParam, taskParam];

export const notarizationValidator = [
  ...staffDocumentValidator,
  body("needsNotarization")
    .isBoolean({ strict: true })
    .withMessage("needsNotarization must be true or false")
    .toBoolean(),
];

const statement = (field: string, label: string): ValidationChain =>
  body(field)
    .optional({ values: "null" })
    .isString()
    .withMessage(`${label} must be text`)
    .bail()
    .trim()
    .isLength({ max: MAX_STATEMENT })
    .withMessage(`${label} must be at most ${MAX_STATEMENT} characters`)
    .bail()
    .matches(NO_NUL)
    .withMessage(`${label} can't contain control characters`);

export const companyProfileValidator = [
  orgParam,
  statement("mission", "Mission"),
  statement("vision", "Vision"),
  body("yearlyGoals").isArray({ max: MAX_GOALS }).withMessage(`Add at most ${MAX_GOALS} goals`),
  body("yearlyGoals.*")
    .isString()
    .bail()
    .trim()
    .isLength({ min: 1, max: MAX_GOAL })
    .withMessage(`Each goal must be between 1 and ${MAX_GOAL} characters`)
    .bail()
    .matches(NO_NUL)
    .withMessage("Goals can't contain control characters"),
];

export const myStaffValidator = [staffParam];

export const myDocumentValidator = [documentParam];

export const signMyDocumentValidator = [
  documentParam,
  text(body("fullName"), "Full name"),
  body("agree").equals("true").withMessage("Tick the box to agree to sign electronically"),
];
