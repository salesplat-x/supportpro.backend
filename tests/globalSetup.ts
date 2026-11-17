import { PostgreSqlContainer } from "@testcontainers/postgresql";

export default async function globalSetup(): Promise<void> {
  const container = await new PostgreSqlContainer("pgvector/pgvector:pg16")
    .withCommand(["postgres", "-c", "max_connections=500", "-c", "fsync=off"])
    .withStartupTimeout(120_000)
    .start();

  (globalThis as { __TEST_PG__?: unknown }).__TEST_PG__ = container;
  process.env.TEST_PG_HOST = container.getHost();
  process.env.TEST_PG_PORT = String(container.getPort());
  process.env.TEST_PG_USER = container.getUsername();
  process.env.TEST_PG_PASSWORD = container.getPassword();
}
