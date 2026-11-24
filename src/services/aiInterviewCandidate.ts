import { AppDataSource } from "../database/dataSource.js";
import { AiInterview } from "../entities/AiInterview.js";
import { AiInterviewQuestion } from "../entities/AiInterviewQuestion.js";
import { AuthorizationError, ConflictError, NotFoundError } from "../utils/errors";

export interface CandidateInterviewQuestion {
  id: string;
  position: number;
  isFollowUp: boolean;
  question: string;
  answered: boolean;
  recordedAt: Date | null;
}

export const getCandidateInterview = async (userId: string, interviewId: string) => {
  const interview = await AppDataSource.getRepository(AiInterview).findOne({
    where: { id: interviewId },
  });
  if (!interview) throw new NotFoundError("Interview not found");
  if (interview.talentId !== userId) {
    throw new AuthorizationError("Only the candidate can open this interview");
  }
  if (interview.status === "pending") {
    throw new ConflictError("Your interview is still being prepared. Try again in a minute.");
  }
  if (interview.status === "failed") {
    throw new ConflictError(
      "This interview isn't available right now. Please contact the hiring team."
    );
  }
  const rows = await AppDataSource.getRepository(AiInterviewQuestion).find({
    where: { interviewId },
    order: { position: "ASC", isFollowUp: "ASC" },
  });
  const questions: CandidateInterviewQuestion[] = rows.map((row) => ({
    id: row.id,
    position: row.position,
    isFollowUp: row.isFollowUp,
    question: row.question,
    answered: row.recordedAt !== null,
    recordedAt: row.recordedAt,
  }));
  const next = questions.find((question) => !question.answered);
  return {
    id: interview.id,
    jobId: interview.jobId,
    mode: interview.mode,
    status: interview.status,
    totalQuestions: questions.length,
    answeredCount: questions.filter((question) => question.answered).length,
    nextQuestionId: next?.id ?? null,
    /** True while a main answer is still being turned into text, so a follow-up may yet appear. */
    checking: rows.some(
      (row) => !row.isFollowUp && row.recordedAt !== null && row.transcriptStatus === "pending"
    ),
    questions,
  };
};
