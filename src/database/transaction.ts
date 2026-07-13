import { QueryRunner, QueryFailedError } from "typeorm";
import { AppDataSource } from "./dataSource.js";
import { AppError, DatabaseError } from "../utils/errors";
import logger from "../utils/logger.js";

export async function withTransaction<T>(fn: (queryRunner: QueryRunner) => Promise<T>): Promise<T> {
  const queryRunner = AppDataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();
  try {
    const result = await fn(queryRunner);
    await queryRunner.commitTransaction();
    return result;
  } catch (error) {
    await queryRunner.rollbackTransaction();
    // Re-throw domain errors (NotFoundError, ConflictError, ValidationError, etc.)
    // unchanged so controllers and the global error handler see the correct status code.
    if (error instanceof AppError) throw error;
    if (error instanceof QueryFailedError) {
      logger.error("DB query failed inside transaction", { message: error.message });
      throw new DatabaseError("A database error occurred");
    }
    throw error;
  } finally {
    await queryRunner.release();
  }
}
