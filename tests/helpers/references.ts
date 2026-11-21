import request from "supertest";
import type { Application } from "express";
import { testDataSource } from "./db.js";
import { Organization } from "../../src/entities/Organization.js";
import type { ReferenceQuestion } from "../../src/types/referenceQuestion.js";

export const SIX_QUESTIONS: ReferenceQuestion[] = [
  { key: "worked_together", question: "How did you work together?", type: "text", required: true },
  { key: "strengths", question: "What are their strengths?", type: "text", required: true },
  { key: "improve", question: "What could they improve?", type: "text", required: true },
  { key: "reliability", question: "How reliable are they?", type: "text", required: true },
  { key: "hire_again", question: "Would you hire them again?", type: "yesno", required: true },
  {
    key: "anything_else",
    question: "Anything else you want us to know?",
    type: "text",
    required: false,
  },
];

export const setCompanyQuestions = (
  organizationId: string,
  questions: ReferenceQuestion[] = SIX_QUESTIONS
) =>
  testDataSource
    .getRepository(Organization)
    .update(organizationId, { referenceQuestions: questions });

export const sendCompanyQuestions = (
  app: Application,
  token: string,
  organizationId: string,
  jobIds: string[]
) =>
  request(app)
    .post(`/v1/organizations/${organizationId}/reference-questions/send`)
    .set("Authorization", `Bearer ${token}`)
    .send({ jobIds });
