# Deploying the backend

## How a deploy works

1. A push to `main` runs **CI** (tests, lint, types, migrations check, audit, secret scan, semgrep, Trivy).
2. Only if CI passed, **Continuous Build and Deployment Engine** (`.github/workflows/main.yml`):
   - builds the image with the commit baked in (`GIT_SHA` → `APP_VERSION`) and pushes **only** `salesplat/supportpro-backend:<commit-sha>`;
   - runs [`scripts/deploy.sh`](scripts/deploy.sh) on the droplet for that exact SHA;
   - moves `:latest` on Docker Hub to that SHA **only after** the deploy is healthy, so `:latest` always means "last good release".
3. `scripts/deploy.sh` runs migrations, seeds and plan sync from the new image while the old container keeps serving, swaps the container, and polls `GET /health` until it answers 200 **and** reports `version` equal to the deployed SHA.
4. If the new release is unhealthy, the script re-points `:latest` on the droplet at the previous image, starts it again, checks its health, and fails the Actions run. Every outcome is appended to `~/app-stack/deploy-history.log`.

`GET /health` returns `{ "status", "db", "version", "timestamp" }`; `version` is the commit SHA of the running image (`unknown` for local runs).

## Manual redeploy or rollback

GitHub → Actions → **Continuous Build and Deployment Engine** → **Run workflow**, and enter the full 40-character SHA of a commit whose image was already built (any commit deployed since this workflow went in). It skips the build and runs the same deploy and health check.

## Migrations must stay backward-compatible

**A rollback restores the previous code, not the previous database.** Migrations run before the new container starts and are never undone automatically. After a rollback, the previous release runs against the new schema, so every migration must keep working with the release before it:

- **Expand, then contract.** Add new columns or tables (nullable or with a default) in one release. Remove or rename old ones only in a later release, once nothing reads them.
- Don't rename or drop a column, table or enum value in the same release that stops using it.
- Don't add a `NOT NULL` column without a default.
- Backfill data in a separate step, not in a migration that the old code can't survive.
- If a change truly can't be backward-compatible, deploy it deliberately with the team watching, and have a written revert plan (`npm run migration:revert`) ready.

## Testing the deploy logic

- `tests/deploy.test.ts` runs `scripts/deploy.sh` against a fake `docker`/`curl` (`tests/fixtures/fake-docker/`) and proves: deploy by SHA (never `:latest`), healthy release stays and becomes `:latest`, unhealthy or wrong-version release is rolled back with `:latest` re-pointed, failed migrations leave production untouched.
- `tests/deployConfig.test.ts` checks the workflow, Dockerfile and compose wiring.
- `bash scripts/demo-rollback.sh` is the demo: v2 deploys, broken v3 is rolled back to v2.
