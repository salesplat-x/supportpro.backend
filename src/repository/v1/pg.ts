import env from "../../config/env";
import { Pool } from "pg";
import OpenAI from "openai";
import logger from "../../config/logger";
import { TopTalents } from "../../typings/job";
import { Embedding } from "openai/resources/embeddings.mjs";

const isLocalHost = ["localhost", "127.0.0.1"].includes(env.pg_host ?? "");

const pool = new Pool({
  user: env.pg_user,
  host: env.pg_host,
  password: env.pg_password,
  ssl: isLocalHost ? false : { rejectUnauthorized: false },
  database: env.pg_db,
  port: Number(env.pg_port),
  connectionTimeoutMillis: 20000,
  idleTimeoutMillis: 30000,
  max: 20,
});

const query = async (text: string, params?: any[]) => {
  const res = await pool.query(text, params);
  return res;
};

// Function to save a job embedding
export const saveJobEmbedding = async (
  jobId: string,
  jobDescription: string,
  jobEmbedding: number[]
) => {
  const insertionString =
    "INSERT INTO jobs (job_id, job_description, job_embedding) VALUES ($1, $2, $3) RETURNING *";

  const embedding = `[${jobEmbedding.toString()}]`;

  const values = [jobId, jobDescription, embedding];

  const res = await query(insertionString, values);
  return res.rows[0];
};

// Function to save scout job embedding
export const saveScoutJobEmbedding = async (
  jobId: string,
  jobDescription: string,
  jobEmbedding: number[]
) => {
  const insertionString =
    "INSERT INTO scout_jobs (scout_job_id, job_description, job_embedding) VALUES ($1, $2, $3) RETURNING *";

  const embedding = `[${jobEmbedding.toString()}]`;

  const values = [jobId, jobDescription, embedding];

  const res = await query(insertionString, values);
  return res.rows[0];
};

// Delete all CV embedding rows for a profile before re-inserting
export const deleteTalentEmbeddings = async (profileId: string) => {
  await query("DELETE FROM talents WHERE profile_id = $1", [profileId]);
};

// Fetch all CV text chunks stored for a profile
export const getCvTextByProfileId = async (profileId: string): Promise<string[]> => {
  const res = await query("SELECT cv_text FROM talents WHERE profile_id = $1", [profileId]);
  return res.rows.map((r: { cv_text: string }) => r.cv_text);
};

// Function to save a talent cv embedding (deletes existing rows first to prevent duplicates)
export const saveTalentEmbedding = async (
  profileId: string,
  cvText: string[],
  cvEmbedding: OpenAI.Embeddings.Embedding[]
) => {
  await deleteTalentEmbeddings(profileId);

  let insertionString = "INSERT INTO talents (profile_id, cv_text, cv_embedding) VALUES ";
  const values = [];

  for (let j = 0; j < cvEmbedding.length; j++) {
    const embedding = `[${cvEmbedding[j]?.embedding.toString()}]`;

    const baseIndex = j * 3 + 1;
    insertionString += `($${baseIndex}, $${baseIndex + 1}, $${baseIndex + 2})`;

    if (j < cvEmbedding.length - 1) {
      insertionString += ", ";
    }

    values.push(profileId, cvText[j], embedding);
  }

  insertionString += " RETURNING *;";

  const res = await query(insertionString, values);
  return res.rows[0];
};

//  Function to get top cv_embeddings for a job
export const getTopCVEmbedding = async (input: TopTalents) => {
  const percentage = input.percentage ? input.percentage : 50;
  const limit = input.limit ? input.limit : 20;
  const strictness = (100 - percentage) / 100;
  const queryText = `
  WITH jd_cte AS (
    SELECT * 
    FROM public.jobs 
    WHERE job_id = $1
  ),
  similarity_cte AS (
    SELECT
        talents.profile_id,
        talents.cv_text,
        ABS ((SELECT job_embedding FROM jd_cte) <=> talents.cv_embedding) AS similarity
    FROM public.talents
)
SELECT
    profile_id,
    cv_text,
    similarity
FROM (
    SELECT
        profile_id,
        cv_text,
        similarity,
        ROW_NUMBER() OVER (PARTITION BY profile_id ORDER BY similarity DESC) AS rn
    FROM similarity_cte
) ranked
  WHERE rn = 1 AND similarity <= $2
  ORDER BY similarity
  LIMIT $3;
  `;
  const values = [input.jobId, strictness, limit];
  const res = await query(queryText, values);
  return res.rows;
};

//  Function to get top scout cv_embeddings for a job
export const getScoutCVEmbedding = async (scoutJobId: string, talentIds: string[]) => {
  const queryText = `
  WITH jd_cte AS (
    SELECT *
    FROM public.scout_jobs
    WHERE scout_job_id = $1
  ),
  similarity_cte AS (
    SELECT
        talents.profile_id,
        talents.cv_text,
        ABS ((SELECT job_embedding FROM jd_cte) <=> talents.cv_embedding) AS similarity
    FROM public.talents
    WHERE talents.profile_id = ANY($2)
  )
SELECT
    profile_id,
    similarity
FROM (
    SELECT
        profile_id,
        similarity,
        ROW_NUMBER() OVER (PARTITION BY profile_id ORDER BY similarity DESC) AS rn
    FROM similarity_cte
) ranked
  WHERE rn = 1
  `;
  const values = [scoutJobId, talentIds];
  const res = await query(queryText, values);
  return res.rows;
};

//Function to calculate similarity score for a single user
export const getCVSimilarityScore = async (profileId: string, jobId: string) => {
  const queryText = `
    WITH jd_cte AS (
      SELECT job_embedding 
      FROM public.jobs 
      WHERE job_id = $1
    ),
    talent_cte AS (
      SELECT cv_embedding 
      FROM public.talents 
      WHERE profile_id = $2
    )
    SELECT 
      ABS ((SELECT job_embedding FROM jd_cte) <=> (SELECT cv_embedding FROM talent_cte)) AS similarity_score;
  `;
  const values = [jobId, profileId];
  const res = await query(queryText, values);
  return res.rows[0].similarity_score;
};

//  Function to get a job
export const getJob = async (jobId: string) => {
  const queryText = `
  SELECT job_description
  FROM jobs
  WHERE job_id = $1;
`;
  const res = await query(queryText, [jobId]);
  return res.rows[0];
};

//  Function to get talents
export const getTalents = async (userId: string) => {
  const queryText = `
  SELECT cv_text
  FROM talents
  WHERE profile_id = $1;
`;
  const res = await query(queryText, [userId]);
  return res.rows;
};

// Function to save a job embedding
export const saveCvBatch = async (
  batchId: string,
  talentName: string,
  cvText: string,
  coverLetterText: string,
  combinedEmbedding: Embedding[]
) => {
  const insertionString =
    "INSERT INTO cv_batches (batch_id, talent_name, cv_text, cover_letter_text, combined_embedding) VALUES ($1, $2, $3) RETURNING *";

  const embedding = `[${combinedEmbedding.toString()}]`;

  const values = [batchId, talentName, cvText, coverLetterText, embedding];

  const res = await query(insertionString, values);
  return res.rows[0];
};

// Function to create necessary tables
export const setupPostgresDB = async () => {
  try {
    const client = await pool.connect();

    // Enable pgvector extension
    await client.query("CREATE EXTENSION IF NOT EXISTS vector;");
    // Create jobs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id SERIAL PRIMARY KEY,
        job_id VARCHAR(255) NOT NULL,
        job_description TEXT NOT NULL,
        job_embedding VECTOR(512) NOT NULL
      );
    `);
    // Create talents table
    await client.query(`
    CREATE TABLE IF NOT EXISTS talents (
      id SERIAL PRIMARY KEY,
      profile_id VARCHAR(255) NOT NULL,
      cv_text TEXT NOT NULL,
      cv_embedding VECTOR(512) NOT NULL
    );
    `);

    // Create talents table
    await client.query(`
    CREATE TABLE IF NOT EXISTS cv_batches (
      id SERIAL PRIMARY KEY,
      batch_id VARCHAR(255) NOT NULL,
      talent_name VARCHAR(255) NOT NULL,
      cv_text TEXT NOT NULL,
      cover_letter_text TEXT NOT NULL,
      combined_embedding VECTOR(512) NOT NULL
    );
    `);

    // Create scout jobs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS scout_jobs (
        id SERIAL PRIMARY KEY,
        scout_job_id VARCHAR(255) NOT NULL,
        job_description TEXT NOT NULL,
        job_embedding VECTOR(512) NOT NULL
      );
    `);
    client.release();
    logger.log("Connected to Postgres successfully");
  } catch (error) {
    logger.logErrorMessage("Unable to connect to Postgres");
    logger.logErrorToConsole(error as Error);
  }
};
