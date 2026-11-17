import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

export default async function globalTeardown(): Promise<void> {
  await (globalThis as { __TEST_PG__?: StartedPostgreSqlContainer }).__TEST_PG__?.stop();
}
