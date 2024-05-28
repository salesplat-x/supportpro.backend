import { Types } from "mongoose";
import env from "../../config/env";
import { Pool } from "pg";
import OpenAI from "openai";
import logger from "../../config/logger";

const pool = new Pool({
  user: env.pg_user,
  host: env.pg_host,
  database: env.pg_db,
  password: env.pg_password,
  port: Number(env.pg_port),
  ssl: true,
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

// Function to save a talent cv embedding
export const saveTalentEmbedding = async (
  profileId: string,
  cvText: string[],
  cvEmbedding: OpenAI.Embeddings.Embedding[]
) => {
  let insertionString =
    "INSERT INTO talents (profile_id, cv_text, cv_embedding) VALUES ";
  const values = [];

  for (let j = 0; j < cvEmbedding.length; j++) {
    const embedding = `[${cvEmbedding[j]?.embedding.toString()}]`;

    // Calculate the positional placeholders
    const baseIndex = j * 3 + 1;
    insertionString += `($${baseIndex}, $${baseIndex + 1}, $${baseIndex + 2})`;

    // Add a comma between sets of values, except for the last set
    if (j < cvEmbedding.length - 1) {
      insertionString += ", ";
    }

    values.push(profileId, cvText[j], embedding);
  }

  insertionString += " RETURNING *;";

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
        job_description VARCHAR(255) NOT NULL,
        job_embedding VECTOR(512) NOT NULL
      );
    `);
    // Create talents table
    await client.query(`
    CREATE TABLE IF NOT EXISTS talents (
      id SERIAL PRIMARY KEY,
      profile_id VARCHAR(255) NOT NULL,
      cv_text VARCHAR(255) NOT NULL,
      cv_embedding VECTOR(512) NOT NULL
    );
    `);
    client.release();
    logger.log("Connected to Postgres successfully");
  } catch (error: any) {
    logger.logErrorMessage("Unable to connect to Postgres");
  }
};
