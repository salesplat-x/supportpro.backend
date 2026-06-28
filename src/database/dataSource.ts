import "reflect-metadata";
import { DataSource } from "typeorm";
import databaseConfig from "../config/database.js";

export const AppDataSource = new DataSource(databaseConfig);

export async function initializeDatabase(): Promise<void> {
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize();
    // Ensure pgvector extension is available
    await AppDataSource.query("CREATE EXTENSION IF NOT EXISTS vector;").catch(() => {
      // Extension might not be available in all environments; log but don't fail
    });
  }
}
