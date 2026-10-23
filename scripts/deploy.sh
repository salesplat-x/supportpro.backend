#!/usr/bin/env bash
# Production deploy for the backend, run on the droplet by .github/workflows/main.yml
# (appleboy/ssh-action `script_path`, with DEPLOY_SHA passed through `envs`).
#
# What it does, in order:
#   1. Remembers the image ID that is serving now (the rollback target).
#   2. Pulls salesplat/supportpro-backend:<DEPLOY_SHA>, the exact commit CI tested.
#      Never :latest, so a moved tag can't decide what goes live.
#   3. Runs migrations, seedAdmin and syncPlans from that image while the old
#      container keeps serving. Any failure stops here and production is untouched.
#   4. Replaces the container and polls /health until it answers 200 AND reports
#      version == DEPLOY_SHA.
#   5. Healthy: tags the image as :latest on the droplet (so a manual
#      `docker compose up` or restart brings back this good release).
#      Unhealthy: re-points :latest at the previous image, starts it again,
#      health-checks it and exits non-zero so the Actions run goes red.
#
# Rollback restores CODE only. Migrations from step 3 are not undone, so every
# migration must stay backward-compatible with the previous release (see DEPLOYMENT.md).
#
# Tests: tests/deploy.test.ts runs this script against a fake docker/curl.
# Demo:  scripts/demo-rollback.sh
set -euo pipefail

IMAGE_REPO="${IMAGE_REPO:-salesplat/supportpro-backend}"
CONTAINER_NAME="${CONTAINER_NAME:-supportpro-backend}"
APP_DIR="${APP_DIR:-$HOME/app-stack}"
HOST_PORT="${HOST_PORT:-8000}"
HEALTH_URL="${HEALTH_URL:-http://localhost:${HOST_PORT}/health}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-3}"
DEPLOY_SHA="${DEPLOY_SHA:-}"

if ! printf '%s' "${DEPLOY_SHA}" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "DEPLOY_SHA must be the full 40-character commit SHA of a CI-tested build (got '${DEPLOY_SHA}')" >&2
  exit 2
fi

cd "${APP_DIR}"

target="${IMAGE_REPO}:${DEPLOY_SHA}"

record() {
  printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${DEPLOY_SHA}" "$*" >>deploy-history.log
}

# Image ID (not tag) of what is serving now, so rollback survives any tag moving.
previous_image="$(docker inspect -f '{{.Image}}' "${CONTAINER_NAME}" 2>/dev/null || true)"
echo "==> Currently running image: ${previous_image:-none}"

echo "==> Pulling ${target}"
if ! docker pull "${target}"; then
  echo "==> Image ${target} could not be pulled (was it built and pushed for this commit?); production untouched"
  record "failed-pull"
  exit 1
fi

# Gate the cutover: these must succeed while the old container is still serving.
run_once() {
  label="$1"
  script="$2"
  echo "==> ${label}"
  if ! docker run --rm \
    --network app-network \
    --env-file .env \
    --entrypoint node \
    "${target}" \
    "${script}"; then
    return 1
  fi
}

if ! run_once "Running migrations (must succeed before server restart)" dist/scripts/migrate.js; then
  echo "==> Migrations failed; the current release keeps serving"
  record "failed-migrations"
  exit 1
fi
if ! run_once "Seeding admin (no-op if already present)" dist/scripts/seedAdmin.js; then
  echo "==> Seeding admin failed; the current release keeps serving"
  record "failed-seed"
  exit 1
fi
# Upsert Paystack plan codes from pricing.yaml into the plans table.
if ! run_once "Syncing subscription plans to Paystack" dist/scripts/syncPlans.js; then
  echo "==> Plan sync failed; the current release keeps serving"
  record "failed-plan-sync"
  exit 1
fi

unique_ids() {
  printf '%s\n' "$@" | awk 'NF && !seen[$0]++'
}

free_host_port() {
  docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true
  docker compose stop app 2>/dev/null || true
  docker compose rm -f -s app 2>/dev/null || true

  published="$(docker ps -aq --filter "publish=${HOST_PORT}" 2>/dev/null || true)"
  mapped="$(docker ps -a --format '{{.ID}} {{.Ports}}' | awk -v p=":${HOST_PORT}->" 'index($0, p) { print $1 }' || true)"
  latest_ctr="$(docker ps -q --filter "ancestor=${IMAGE_REPO}:latest" 2>/dev/null || true)"
  target_ctr="$(docker ps -q --filter "ancestor=${target}" 2>/dev/null || true)"
  # shellcheck disable=SC2086 # word-splitting the ID lists is intended
  ids="$(unique_ids ${published:-} ${mapped:-} ${latest_ctr:-} ${target_ctr:-})"

  if [ -n "${ids}" ]; then
    echo "Releasing :${HOST_PORT} / old backend containers:"
    echo "${ids}"
    for cid in ${ids}; do
      docker update --restart=no "${cid}" >/dev/null 2>&1 || true
      docker rm -f "${cid}" >/dev/null 2>&1 || true
    done
  fi
}

wait_for_port_free() {
  i=1
  while [ "${i}" -le 15 ]; do
    if command -v ss >/dev/null 2>&1; then
      if [ -z "$(ss -H -ltn "sport = :${HOST_PORT}" 2>/dev/null || true)" ]; then
        return 0
      fi
    else
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  echo "Host :${HOST_PORT} still listed; retrying docker run"
  ss -ltnp | grep "${HOST_PORT}" || true
}

start_container() {
  image="$1"
  attempt=1
  while [ "${attempt}" -le 20 ]; do
    free_host_port
    wait_for_port_free
    docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true

    set +e
    docker run -d \
      --name "${CONTAINER_NAME}" \
      --network app-network \
      -p "${HOST_PORT}:8000" \
      --env-file .env \
      --restart always \
      "${image}"
    rc=$?
    set -e

    if [ "${rc}" -eq 0 ]; then
      return 0
    fi

    echo "docker run exit ${rc} (attempt ${attempt}/20)"
    docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true
    if [ "${attempt}" -ge 8 ]; then
      fuser -k "${HOST_PORT}/tcp" 2>/dev/null || true
    fi
    if [ "${attempt}" -lt 5 ]; then
      sleep 2
    else
      sleep 5
    fi
    attempt=$((attempt + 1))
  done

  echo "Failed to bind host :${HOST_PORT} after retries"
  docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
  ss -ltnp | grep "${HOST_PORT}" || true
  return 1
}

reported_version=""

# Polls /health. With an expected version, a 200 from any other version is a failure:
# it means the wrong release is answering. The entrypoint re-runs migrations before
# listening, so the default allows about 90 s.
wait_for_health() {
  expected="$1"
  reported_version=""
  i=1
  while [ "${i}" -le "${HEALTH_RETRIES}" ]; do
    if body="$(curl -fsS "${HEALTH_URL}" 2>/dev/null)"; then
      reported_version="$(printf '%s' "${body}" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
      if [ -n "${expected}" ] && [ "${reported_version}" != "${expected}" ]; then
        echo "/health answered, but it is serving version '${reported_version:-none}', expected ${expected}"
        return 1
      fi
      return 0
    fi
    restarts="$(docker inspect -f '{{.RestartCount}}' "${CONTAINER_NAME}" 2>/dev/null || echo 0)"
    if [ "${restarts}" -gt 0 ]; then
      echo "Container restarted ${restarts} time(s); treating as crash loop"
      return 1
    fi
    sleep "${HEALTH_INTERVAL}"
    i=$((i + 1))
  done
  echo "/health did not return 200 after ${HEALTH_RETRIES} checks"
  return 1
}

echo "==> Replacing running server with ${DEPLOY_SHA}"
if start_container "${target}" && wait_for_health "${DEPLOY_SHA}"; then
  # Only a healthy release becomes "current".
  docker tag "${target}" "${IMAGE_REPO}:latest"
  record "deployed"
  echo "==> Deploy complete; now serving ${DEPLOY_SHA}"
  exit 0
fi

echo "==> New release is unhealthy; last 100 log lines:"
docker logs --tail 100 "${CONTAINER_NAME}" 2>&1 || true

if [ -z "${previous_image}" ]; then
  record "failed-no-previous"
  echo "==> No previous image recorded; nothing to roll back to"
  exit 1
fi

echo "==> Rolling back to ${previous_image}"
# Point :latest back at the good image first, so nothing can resurrect the broken one.
docker tag "${previous_image}" "${IMAGE_REPO}:latest"
if start_container "${previous_image}" && wait_for_health ""; then
  record "rolled-back-to ${previous_image}"
  echo "==> Rollback complete; serving ${reported_version:-${previous_image}}"
else
  record "rollback-failed ${previous_image}"
  echo "==> Rollback also failed; production needs manual attention"
fi
exit 1
