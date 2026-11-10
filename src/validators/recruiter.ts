import { query } from "express-validator";
import {
  APPLICANTS_MAX_LIMIT,
  SUMMARY_CHARTS,
  SUMMARY_RANGES,
} from "../services/recruiterDashboardSummary.js";

export const dashboardSummaryValidator = [
  query("range")
    .optional()
    .isIn(SUMMARY_RANGES.map(String))
    .withMessage(`range must be one of: ${SUMMARY_RANGES.join(", ")}`),
  query("chart")
    .optional()
    .isIn([...SUMMARY_CHARTS])
    .withMessage(`chart must be one of: ${SUMMARY_CHARTS.join(", ")}`),
];

export const dashboardApplicantsValidator = [
  query("limit")
    .optional()
    .isInt({ min: 1, max: APPLICANTS_MAX_LIMIT })
    .withMessage(`limit must be between 1 and ${APPLICANTS_MAX_LIMIT}`)
    .toInt(),
  query("offset").optional().isInt({ min: 0 }).withMessage("offset must be 0 or more").toInt(),
];
