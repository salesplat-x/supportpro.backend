import { AppDataSource } from "../database/dataSource.js";
import { Scout, ScoutJob, User, Role } from "../entities";
import { NotFoundError, AuthorizationError, ValidationError } from "../utils/errors";
import { UserRole } from "../types/enums.js";
import { extractText, preprocessText, convertSimilarityToPercentage } from "../utils/text.js";
import * as AI from "../utils/integrations/openai.js";
import { v4 as uuidv4 } from "uuid";

const scoutRepo = () => AppDataSource.getRepository(Scout);

const scoutJobRepo = () => AppDataSource.getRepository(ScoutJob);

const MAX_PAGE_SIZE = 100;

const userRepo = () => AppDataSource.getRepository(User);

const roleRepo = () => AppDataSource.getRepository(Role);

export interface ScoutTalentsParams {
  scoutJobId: string;
  roleId?: string;
  experience?: string;
  country?: string;
  state?: string;
  city?: string;
  workMode?: string;
  limit?: number | string;
  offset?: number | string;
}

export const fetchScoutReports = async (batchId?: string): Promise<Scout[]> => {
  const where = batchId ? { batchId } : {};
  return scoutRepo().find({
    where,
    relations: { scoutJob: true, recruiter: true },
    order: { createdAt: "DESC" },
  });
};

export const fetchScoutReport = async (id: string): Promise<Scout | null> => {
  return scoutRepo().findOne({
    where: { id },
    relations: { scoutJob: true, recruiter: true },
  });
};

export const scoutTalents = async (
  payload: ScoutTalentsParams
): Promise<Array<User & { similarity: number | null }>> => {
  const qb = userRepo()
    .createQueryBuilder("user")
    .leftJoinAndSelect("user.userRoles", "userRoles")
    .where("user.userRole = :role", { role: UserRole.Talent })
    .andWhere("user.prescreeningScore IS NOT NULL");

  if (payload.roleId) {
    const role = await roleRepo().findOne({ where: { id: payload.roleId } });
    if (!role) {
      throw new NotFoundError("Role does not exist");
    }
    qb.andWhere("userRoles.id = :roleId", { roleId: payload.roleId });
  }

  if (payload.experience) {
    qb.andWhere("user.experience = :experience", { experience: payload.experience });
  }

  if (payload.country) {
    qb.andWhere("user.locationCountry = :country", { country: payload.country });
  }

  if (payload.state) {
    qb.andWhere("user.locationState = :state", { state: payload.state });
  }

  if (payload.city) {
    qb.andWhere("user.locationCity = :city", { city: payload.city });
  }

  if (payload.workMode) {
    qb.andWhere("user.workType LIKE :workMode", { workMode: `%${payload.workMode}%` });
  }

  const limit = Math.min(Number(payload.limit) || 50, MAX_PAGE_SIZE);
  const offset = Number(payload.offset) || 0;

  const users = await qb
    .orderBy("user.prescreeningScore", "DESC")
    .skip(offset)
    .take(limit)
    .getMany();

  const talentIds = users.map((u) => u.id);

  // Get CV similarity scores from pgvector
  const res: Array<{ user_id: string; similarity: number }> =
    talentIds.length > 0
      ? await AppDataSource.query(
          `
        WITH jd_cte AS (
          SELECT job_embedding::vector FROM scout_jobs WHERE id = $1
        ),
        similarity_cte AS (
          SELECT
            te.user_id,
            ABS((SELECT job_embedding::vector FROM jd_cte) <=> te.cv_embedding::vector) AS similarity
          FROM talent_embeddings te
          WHERE te.user_id = ANY($2)
        )
        SELECT user_id, similarity
        FROM (
          SELECT user_id, similarity,
            ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY similarity DESC) AS rn
          FROM similarity_cte
        ) ranked
        WHERE rn = 1
        `,
          [payload.scoutJobId, talentIds]
        )
      : [];

  const resMap = new Map(
    res.map((item) => [item.user_id, convertSimilarityToPercentage(item.similarity)])
  );

  return users.map((u) => ({
    ...u,
    similarity: resMap.get(u.id) ?? null,
  }));
};

export interface CvAndCoverLetterPayload {
  scoutJobId: string;
  batchId?: string;
  files: Record<string, Express.Multer.File[]>;
}

export const scoutCvAndCl = async (
  userId: string,
  payload: CvAndCoverLetterPayload
): Promise<{ evaluationScore: number; scout: Scout }> => {
  const job = await scoutJobRepo().findOne({
    where: { id: payload.scoutJobId },
    relations: { role: true },
  });
  if (!job) {
    throw new NotFoundError("Job not found");
  }

  if (job.postedById !== userId) {
    throw new AuthorizationError("You are not authorized to perform this action");
  }

  const recruiterGuide = job.recruiterGuide;
  const { files } = payload;

  if (!files || !files["cv"] || !files["coverLetter"]) {
    throw new ValidationError("No file uploaded");
  }

  const cv = files["cv"][0]!;
  const coverLetter = files["coverLetter"][0]!;

  const cvName = cv.originalname.split(".")[0] ?? cv.originalname;
  const coverLetterName = coverLetter.originalname.split(".")[0] ?? cv.originalname;

  let cvText = await extractText(cv.buffer, cv.mimetype);
  if (!cvText) {
    throw new ValidationError("Unable to extract CV text");
  }

  let coverLetterText = await extractText(coverLetter.buffer, coverLetter.mimetype);
  if (!coverLetterText) {
    throw new ValidationError("Unable to extract cover letter text");
  }

  cvText = preprocessText(cvText);
  coverLetterText = preprocessText(coverLetterText);

  const inputJson = JSON.stringify({
    cv: cvText,
    coverLetter: coverLetterText,
    jobDescription: job.jobBrief,
    recruiterGuide,
  });

  const response = await AI.assessCVandCoverLetter(inputJson);
  if (!response || !response.message || !response.message.content) {
    throw new ValidationError("Error with LLM");
  }

  const { cvScore, cvInsights, coverLetterScore, coverLetterInsights } = JSON.parse(
    response.message.content
  ) as {
    cvScore?: number;
    cvInsights?: string;
    coverLetterScore?: number;
    coverLetterInsights?: string;
  };
  if (!cvScore || !coverLetterScore) {
    throw new ValidationError("Error assessing CV and Cover Letter");
  }

  const evaluationScore = Number(((cvScore + coverLetterScore) / 2).toFixed(2));
  const batchId = payload.batchId ?? uuidv4();

  const scout = scoutRepo().create({
    batchId,
    cvName,
    coverLetterName,
    cvText,
    coverLetterText,
    cvScore,
    insights: cvInsights ?? null,
    coverLetterScore,
    coverLetterInsights: coverLetterInsights ?? null,
    evaluationScore,
    recruiterId: userId,
    scoutJobId: payload.scoutJobId,
  });

  const saved = await scoutRepo().save(scout);
  return { evaluationScore, scout: saved };
};

export interface ScoutCvPayload {
  scoutJobId: string;
  batchId?: string;
  file: Express.Multer.File;
}

export const scoutCv = async (
  userId: string,
  payload: ScoutCvPayload
): Promise<{ evaluationScore: number; scout: Scout }> => {
  const job = await scoutJobRepo().findOne({
    where: { id: payload.scoutJobId },
    relations: { role: true },
  });
  if (!job) {
    throw new NotFoundError("Job not found");
  }

  if (job.postedById !== userId) {
    throw new AuthorizationError("You are not authorized to perform this action");
  }

  const recruiterGuide = job.recruiterGuide;
  const file = payload.file;

  if (!file) {
    throw new ValidationError("No file uploaded");
  }

  const cvName = file.originalname.split(".")[0] ?? file.originalname;

  let cvText = await extractText(file.buffer, file.mimetype);
  if (!cvText) {
    throw new ValidationError("Unable to extract CV text");
  }

  cvText = preprocessText(cvText);

  const inputJson = JSON.stringify({
    cv: cvText,
    recruiterGuide,
  });

  const response = await AI.assessCV(inputJson);
  if (!response || !response.message || !response.message.content) {
    throw new ValidationError("Error with LLM");
  }

  const { cvScore, insights } = JSON.parse(response.message.content) as {
    cvScore?: number;
    insights?: string;
  };
  if (!cvScore) {
    throw new ValidationError("Error assessing CV");
  }

  const evaluationScore = cvScore;
  const batchId = payload.batchId ?? uuidv4();

  const scout = scoutRepo().create({
    batchId,
    cvName,
    cvText,
    cvScore,
    insights: insights ?? null,
    evaluationScore,
    scoutJobId: payload.scoutJobId,
    recruiterId: userId,
  });

  const saved = await scoutRepo().save(scout);
  return { evaluationScore, scout: saved };
};
