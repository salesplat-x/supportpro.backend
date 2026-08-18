import { AppDataSource } from "../database/dataSource.js";
import { Feedback } from "../entities/Feedback.js";
import { NotFoundError } from "../utils/errors";

const feedbackRepo = () => AppDataSource.getRepository(Feedback);

export const submitFeedback = async (
  userId: string,
  data: { subject?: string; message: string }
): Promise<Feedback> => {
  const feedback = feedbackRepo().create({
    userId,
    subject: data.subject ?? null,
    message: data.message,
  });
  return feedbackRepo().save(feedback);
};

export const listFeedback = async (
  filters: { isRead?: boolean; limit?: number; skip?: number } = {}
): Promise<{ feedback: Feedback[]; total: number }> => {
  const qb = feedbackRepo()
    .createQueryBuilder("feedback")
    .leftJoinAndSelect("feedback.user", "user");

  if (filters.isRead !== undefined)
    qb.andWhere("feedback.isRead = :isRead", { isRead: filters.isRead });

  const total = await qb.getCount();
  const feedback = await qb
    .orderBy("feedback.createdAt", "DESC")
    .skip(filters.skip ?? 0)
    .take(filters.limit ?? 50)
    .getMany();

  return { feedback, total };
};

const setFeedbackRead = async (id: string, isRead: boolean): Promise<Feedback> => {
  const feedback = await feedbackRepo().findOne({ where: { id }, relations: { user: true } });
  if (!feedback) {
    throw new NotFoundError("Feedback not found");
  }
  feedback.isRead = isRead;
  return feedbackRepo().save(feedback);
};

export const markFeedbackRead = (id: string): Promise<Feedback> => setFeedbackRead(id, true);

export const markFeedbackUnread = (id: string): Promise<Feedback> => setFeedbackRead(id, false);
