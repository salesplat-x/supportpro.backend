import { AppDataSource } from "../database/dataSource.js";
import { AiInterview } from "../entities/AiInterview.js";
import { AiInterviewQuestion } from "../entities/AiInterviewQuestion.js";
import {
  AiInterviewScreenEvent,
  type ScreenEventKind,
} from "../entities/AiInterviewScreenEvent.js";
import { AuthorizationError, NotFoundError } from "../utils/errors";

export const MAX_SCREEN_EVENTS = 100;

const RECORD_IF_ROOM_SQL = `
  INSERT INTO "ai_interview_screen_events" ("interview_id", "question_id", "kind")
  SELECT $1, $2, $3
  WHERE (SELECT COUNT(*) FROM "ai_interview_screen_events" WHERE "interview_id" = $1) < $4
`;

/**
 * Records that the candidate left the interview screen. Only the candidate can, only while a
 * question is still unanswered, and past the cap further events are dropped quietly.
 */
export const recordScreenEvent = async (
  userId: string,
  interviewId: string,
  input: { kind: ScreenEventKind; questionId: string | null }
): Promise<void> => {
  const interview = await AppDataSource.getRepository(AiInterview).findOne({
    where: { id: interviewId },
    select: { id: true, talentId: true },
  });
  if (!interview) throw new NotFoundError("Interview not found");
  if (interview.talentId !== userId) {
    throw new AuthorizationError("Only the candidate can report this");
  }
  const questions = await AppDataSource.getRepository(AiInterviewQuestion).find({
    where: { interviewId },
    select: { id: true, recordedAt: true },
  });
  if (input.questionId && !questions.some((question) => question.id === input.questionId)) {
    throw new NotFoundError("Question not found in this interview");
  }
  if (!questions.some((question) => question.recordedAt === null)) return;
  await AppDataSource.query(RECORD_IF_ROOM_SQL, [
    interviewId,
    input.questionId,
    input.kind,
    MAX_SCREEN_EVENTS,
  ]);
};

export interface ScreenLeaves {
  count: number;
  events: Array<{
    kind: ScreenEventKind;
    at: Date;
    position: number | null;
    isFollowUp: boolean;
  }>;
}

export const loadScreenLeaves = async (
  interviewId: string,
  questions: Pick<AiInterviewQuestion, "id" | "position" | "isFollowUp">[]
): Promise<ScreenLeaves> => {
  const rows = await AppDataSource.getRepository(AiInterviewScreenEvent).find({
    where: { interviewId },
    order: { occurredAt: "ASC" },
  });
  const byId = new Map(questions.map((question) => [question.id, question]));
  return {
    count: rows.length,
    events: rows.map((row) => {
      const question = row.questionId ? byId.get(row.questionId) : undefined;
      return {
        kind: row.kind,
        at: row.occurredAt,
        position: question?.position ?? null,
        isFollowUp: question?.isFollowUp ?? false,
      };
    }),
  };
};
