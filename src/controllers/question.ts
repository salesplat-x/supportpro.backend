import { Request, Response } from "express";
import * as questionService from "../services/question.js";
import * as answerService from "../services/answer.js";
import { sendSuccessResponse } from "../utils/response.js";
import { QuestionType, UserRole } from "../types/enums.js";
import { hideAssessmentResultsFromCandidate } from "../services/application.js";

export const create = async (req: Request, res: Response) => {
  const result = await questionService.createQuestion(req.body);
  sendSuccessResponse(res, "Question created", { question: result }, 201);
};

export const fetchQuestions = async (req: Request, res: Response) => {
  const result = await questionService.fetchQuestions(
    req.user,
    req.query as Record<string, string>
  );
  sendSuccessResponse(res, "Questions fetched", { questions: result });
};

export const fetch = async (req: Request, res: Response) => {
  const result = await questionService.fetchQuestion(req.params["_id"]!, req.user);
  sendSuccessResponse(res, "Question fetched", { question: result });
};

export const generatePersonalizedQuestions = async (req: Request, res: Response) => {
  const result = await questionService.generatePersonalizedQuestions(req.body);
  if (req.user.userRole === UserRole.Talent) hideAssessmentResultsFromCandidate(result.application);
  sendSuccessResponse(res, "Personalized questions generated", result);
};

export const answerPersonalizedQuestions = async (req: Request, res: Response) => {
  const result = await answerService.answerPersonalizedQuestions(req.user.id, req.body);
  hideAssessmentResultsFromCandidate(result.application);
  sendSuccessResponse(res, "Personalized answers submitted", result);
};

export const generatePersonalityQuestion = async (req: Request, res: Response) => {
  const result = await questionService.generatePersonalityQuestion(req.body);
  sendSuccessResponse(res, "Personality question generated", { questions: result });
};

export const ensurePersonalityQuestions = async (req: Request, res: Response) => {
  const result = await questionService.ensurePersonalityQuestions(req.body.jobId);
  sendSuccessResponse(res, "Personality questions ready", { questions: result });
};

export const generateProblemSolvingQuestions = async (req: Request, res: Response) => {
  const result = await questionService.generateProblemSolvingQuestions(req.user, req.body);
  sendSuccessResponse(res, "Problem-solving questions generated", result);
};

export const generateCultureFitQuestions = async (req: Request, res: Response) => {
  const result = await questionService.generateCultureFitQuestions(req.user, req.body);
  sendSuccessResponse(res, "Culture-fit questions generated", result);
};

const candidateAssessmentHandler =
  (type: QuestionType.ProblemSolving | QuestionType.CultureFit, message: string) =>
  async (req: Request, res: Response) => {
    const result = await questionService.getOrAssignAssessmentQuestionsForApplicant(
      req.user.id,
      type,
      String(req.query.jobId)
    );
    sendSuccessResponse(res, message, result);
  };

export const candidateProblemSolvingQuestions = candidateAssessmentHandler(
  QuestionType.ProblemSolving,
  "Problem-solving questions loaded"
);

export const candidateCultureFitQuestions = candidateAssessmentHandler(
  QuestionType.CultureFit,
  "Culture-fit questions loaded"
);

const companyAssessmentAnswerHandler =
  (type: QuestionType.ProblemSolving | QuestionType.CultureFit, message: string) =>
  async (req: Request, res: Response) => {
    const result = await answerService.submitCompanyAssessmentAnswers(req.user.id, type, req.body);
    sendSuccessResponse(res, message, result);
  };

export const answerProblemSolving = companyAssessmentAnswerHandler(
  QuestionType.ProblemSolving,
  "Problem-solving answers submitted"
);

export const answerCultureFit = companyAssessmentAnswerHandler(
  QuestionType.CultureFit,
  "Culture-fit answers submitted"
);

export const evaluatePersonalityType = async (req: Request, res: Response) => {
  const result = await answerService.evaluatePersonalityType(req.user.id, req.body);
  hideAssessmentResultsFromCandidate(result.application);
  sendSuccessResponse(res, "Personality evaluated", result);
};

export const deleteQuestion = async (req: Request, res: Response) => {
  await questionService.deleteQuestion(req.user.id, req.params["_id"]!);
  sendSuccessResponse(res, "Question deleted", {});
};
