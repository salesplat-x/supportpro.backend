import "reflect-metadata";
import { DataSource } from "typeorm";
import databaseConfig from "../config/database.js";

export const AppDataSource = new DataSource(databaseConfig);

export async function initializeDatabase(): Promise<void> {
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize();

    await AppDataSource.query("CREATE EXTENSION IF NOT EXISTS vector;").catch(() => {});

    // Partial index on talent users — not expressible via @Index decorator
    await AppDataSource.query(`
      CREATE INDEX IF NOT EXISTS idx_users_talent_score
        ON users(user_role, prescreening_score DESC)
        WHERE user_role = 'talent'
    `).catch(() => {});

    // HNSW indexes — effective only once cv_embedding/job_embedding columns are vector(512) type
    await AppDataSource.query(`
      CREATE INDEX IF NOT EXISTS idx_talent_embeddings_hnsw
        ON talent_embeddings USING hnsw (cv_embedding vector_cosine_ops)
    `).catch(() => {});
    await AppDataSource.query(`
      CREATE INDEX IF NOT EXISTS idx_jobs_hnsw
        ON jobs USING hnsw (job_embedding vector_cosine_ops)
    `).catch(() => {});
  }
}
