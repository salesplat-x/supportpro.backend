import { MigrationInterface, QueryRunner } from "typeorm";

export class AddVectorSupportAndIndexes1783837661580 implements MigrationInterface {
  name = "AddVectorSupportAndIndexes1783837661580";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Not dropped in down() — other objects may depend on it and dropping a
    // shared extension on rollback is unsafe.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector`);

    await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS idx_users_talent_score
              ON users("userRole", "prescreeningScore" DESC)
              WHERE "userRole" = 'talent'
        `);

    // cv_embedding/job_embedding are stored as text (pgvector literal format);
    // index the cast expression rather than requiring a column type change.
    await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS idx_talent_embeddings_hnsw
              ON talent_embeddings USING hnsw ((cv_embedding::vector(512)) vector_cosine_ops)
        `);

    await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS idx_jobs_hnsw
              ON jobs USING hnsw ((job_embedding::vector(512)) vector_cosine_ops)
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_jobs_hnsw`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_talent_embeddings_hnsw`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_users_talent_score`);
  }
}
