import { body, param, type ValidationChain } from "express-validator";
import { MAX_JOB_DESCRIPTION } from "../services/goals.js";
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
export const goalIdValidator = [goalParam];
export const goalProgressValidator = [
  ...selfParams,
  goalParam,
  body("progress")
    .custom(
      (value: unknown) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 100
    )
    .withMessage("Progress must be a whole number from 0 to 100"),
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
