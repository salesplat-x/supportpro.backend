import "reflect-metadata";
import { DataSource } from "typeorm";
import databaseConfig from "../config/database.js";

export const AppDataSource = new DataSource(databaseConfig);

export async function initializeDatabase(): Promise<void> {
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize();
  }
}
