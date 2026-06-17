import { Types } from "mongoose";
import { PreScreening } from "../../models/v1/prescreening";
import { CvEmbedding } from "../../models/v1/cvEmbedding";
import { IGeneratedQuestion, IPreScreening } from "../../typings/prescreening";

export const findPreScreeningByUserId = async (
  userId: string | Types.ObjectId
): Promise<IPreScreening | null> => {
  return PreScreening.findOne({ userId }).lean<IPreScreening>();
};

export const findActivePreScreeningByUser = async (
  userId: string | Types.ObjectId
): Promise<IPreScreening | null> => {
  return PreScreening.findOne({ userId, status: "pending" }).lean<IPreScreening>();
};

export const upsertPreScreening = async (
  userId: string | Types.ObjectId,
  roles: string[],
  questions: IGeneratedQuestion[],
  attemptCount: number
): Promise<IPreScreening> => {
  return PreScreening.findOneAndUpdate(
    { userId },
    {
      $set: {
        roles,
        questions,
        score: null,
        status: "pending",
        attemptCount,
        maxAttempts: 2,
        generatedAt: new Date(),
        completedAt: undefined,
      },
    },
    { upsert: true, new: true }
  ) as unknown as IPreScreening;
};

export const markPreScreeningCompleted = async (
  id: string | Types.ObjectId,
  score: number
): Promise<IPreScreening | null> => {
  return PreScreening.findByIdAndUpdate(
    id,
    {
      $set: {
        score,
        status: "completed",
        completedAt: new Date(),
      },
    },
    { new: true }
  ).lean<IPreScreening>();
};

export const upsertCvEmbeddingRecord = async (
  profileId: string | Types.ObjectId,
  cvPublicId: string
) => {
  return CvEmbedding.findOneAndUpdate(
    { profileId },
    { $set: { cvPublicId, generatedAt: new Date() } },
    { upsert: true, new: true }
  );
};
