import { body, param, query, type ValidationChain } from "express-validator";
import { MAX_JOB_DESCRIPTION } from "../services/goals.js";
import { DevelopmentStatus } from "../entities/StaffDevelopmentItem.js";
import { Currency } from "../types/enums.js";
import { MAX_COMPLETION_SUMMARY, MAX_REVIEW_NOTE } from "../services/completionRequests.js";
import { MAX_FEEDBACK_NOTES } from "../services/monthlyFeedback.js";
import { MAX_NOTE, MAX_REPORT_FIELD } from "../services/weeklyReports.js";
import { NO_NUL, dateOnly, orgParam, pagination, staffParam } from "./staff.js";

const NO_LINE_BREAKS = /^[^\r\n]*$/;
const MAX_KEY_RESULTS = 5;

export const reportParam = param("reportId").isUUID().withMessage("Invalid person");

export const hrParams = [orgParam, staffParam];
export const managerParams = [staffParam, reportParam];
export const selfParams = [staffParam];

export const goalParam = param("goalId").isUUID().withMessage("Invalid goal id");

export const longText = (
  chain: ValidationChain,
  label: string,
  max: number,
  allowEmpty = false
): ValidationChain =>
  chain
    .isString()
    .withMessage(`${label} must be text`)
    .bail()
    .trim()
    .isLength({ min: allowEmpty ? 0 : 1, max })
    .withMessage(
      allowEmpty
        ? `${label} must be at most ${max} characters`
        : `${label} must be between 1 and ${max} characters`
    )
    .bail()
    .matches(NO_NUL)
    .withMessage(`${label} can't contain control characters`);

export const oneLine = (chain: ValidationChain, label: string, max: number): ValidationChain =>
  longText(chain, label, max)
    .bail()
    .matches(NO_LINE_BREAKS)
    .withMessage(`${label} can't contain line breaks`);

export const versionField = (field = "version"): ValidationChain =>
  body(field).isInt({ min: 0 }).withMessage("Reload and try again").toInt();

export const nullableVersion = (field = "version"): ValidationChain =>
  body(field)
    .custom((value: unknown) => value === null || (Number.isInteger(value) && Number(value) >= 0))
    .withMessage("Reload and try again");

const goalFields = [
  oneLine(body("title"), "Goal", 200),
  body("keyResults")
    .isArray({ max: MAX_KEY_RESULTS })
    .withMessage(`Add at most ${MAX_KEY_RESULTS} key results`),
  oneLine(body("keyResults.*"), "Key result", 300),
  body("target")
    .optional({ values: "null" })
    .isString()
    .withMessage("Target must be text")
    .bail()
    .trim()
    .isLength({ max: 200 })
    .withMessage("Target must be at most 200 characters")
    .bail()
    .matches(NO_NUL)
    .withMessage("Target can't contain control characters"),
  dateOnly(body("dueOn"), "Due date"),
];

export const addGoalValidator = goalFields;
export const editGoalValidator = [goalParam, ...goalFields, versionField()];
export const approveGoalValidator = [goalParam, versionField()];
export const approveGoalsValidator = [
  body("goals")
    .isArray({ min: 1, max: 20 })
    .withMessage("Approve between 1 and 20 goals at a time"),
  body("goals.*.id").isUUID().withMessage("Invalid goal id"),
  body("goals.*.version")
    .isInt({ min: 1 })
    .withMessage("Send the version of each goal you read")
    .toInt(),
];
export const goalIdValidator = [goalParam];
export const goalProgressValidator = [
  ...selfParams,
  goalParam,
  body("progress")
    .custom(
      (value: unknown) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 99
    )
    .withMessage("Progress must be a whole number from 0 to 99. Ask for completion when it's done"),
];

export const saveJobDescriptionValidator = [
  ...hrParams,
  longText(body("body"), "Job description", MAX_JOB_DESCRIPTION),
  nullableVersion(),
];

const reportIdParam = param("weeklyReportId").isUUID().withMessage("Invalid report id");

export const reportsPageValidator = pagination;

export const reportNoteValidator = [
  reportIdParam,
  longText(body("note"), "Note", MAX_NOTE),
  versionField("textVersion"),
  versionField("noteVersion"),
];

export const myReportsValidator = [...selfParams, ...pagination];

export const submitReportValidator = [
  ...selfParams,
  dateOnly(param("weekStart"), "Week"),
  longText(body("did"), "What you did", MAX_REPORT_FIELD),
  longText(body("blocked"), "What blocked you", MAX_REPORT_FIELD, true),
  longText(body("nextWeek"), "Next week", MAX_REPORT_FIELD, true),
];

export const adviceValidator = [...selfParams, reportIdParam];

const itemParam = param("itemId").isUUID().withMessage("Invalid plan item id");

const developmentFields = [
  oneLine(body("weakArea"), "Weak area", 200),
  longText(body("action"), "Action", 1000),
  dateOnly(body("dueOn").optional({ values: "null" }), "Due date"),
];

export const addDevelopmentValidator = developmentFields;

export const editDevelopmentValidator = [
  itemParam,
  ...developmentFields,
  body("status").isIn(Object.values(DevelopmentStatus)).withMessage("Choose a valid status"),
  versionField(),
];

export const developmentIdValidator = [itemParam];

export const developmentDoneValidator = [
  ...selfParams,
  itemParam,
  body("done").isBoolean({ strict: true }).withMessage("done must be true or false").toBoolean(),
];

export const feedbackValidator = [
  param("month")
    .matches(/^\d{4}-(0[1-9]|1[0-2])$/)
    .withMessage("Month must look like 2026-11"),
  body("rating")
    .custom((value: unknown) => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 5)
    .withMessage("Rating must be a whole number from 1 to 5"),
  longText(body("notes"), "Notes", MAX_FEEDBACK_NOTES, true),
  nullableVersion(),
];

const MAX_REVENUE = 99_999_999_999_999;
const QUARTER = /^(19|20|21)\d{2}-Q[1-4]$/;
const money = (field: string, label: string, min: number) =>
  body(field)
    .custom((value: unknown) => typeof value === "number" && value >= min && value <= MAX_REVENUE)
    .withMessage(`${label} must be a number from ${min} to ${MAX_REVENUE}`);

export const quarterlyReviewValidator = [
  orgParam,
  query("quarter")
    .optional()
    .custom((value: unknown) => typeof value === "string" && QUARTER.test(value))
    .withMessage("Quarter must look like 2026-Q4"),
];

export const quarterGoalValidator = [
  orgParam,
  body("quarter")
    .custom((value: unknown) => typeof value === "string" && QUARTER.test(value))
    .withMessage("Quarter must look like 2026-Q4"),
  body("currency").isIn(Object.values(Currency)).withMessage("Choose a valid currency"),
  money("revenueGoal", "Revenue goal", 0.01),
  money("revenueSoFar", "Revenue so far", 0),
  nullableVersion(),
];

const requestParam = param("requestId").isUUID().withMessage("Invalid request id");
const fileParam = param("fileId").isUUID().withMessage("Invalid file id");
const taskParam = param("taskId").isUUID().withMessage("Invalid task id");

export const submitCompletionValidator = [
  ...selfParams,
  body("itemType").isIn(["goal", "task"]).withMessage("Choose a goal or a task"),
  body("itemId").isUUID().withMessage("Choose a goal or a task"),
  longText(body("summary"), "Summary", MAX_COMPLETION_SUMMARY),
];

export const myCompletionRequestValidator = [...selfParams, requestParam];
export const myEvidenceValidator = [...selfParams, requestParam, fileParam];

export const evidenceValidator = [requestParam, fileParam];
export const approveCompletionValidator = [
  requestParam,
  body("version").optional().isInt({ min: 0 }).withMessage("Reload and try again").toInt(),
  longText(body("note").optional({ values: "null" }), "Note", MAX_REVIEW_NOTE, true),
];
export const returnCompletionValidator = [
  requestParam,
  longText(body("note"), "Note", MAX_REVIEW_NOTE),
];
export const completeGoalValidator = [goalParam, versionField()];
export const reopenGoalValidator = [goalParam];
export const taskActionValidator = [taskParam];
