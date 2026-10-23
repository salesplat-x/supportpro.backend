#!/usr/bin/env bash
# Day 2 demo: "a broken version is replaced by the last good one".
#
# Runs the real scripts/deploy.sh three times against a simulated server
# (the fake docker/curl in tests/fixtures/fake-docker; no real Docker, server
# or registry is touched):
#   v1  is serving.
#   v2  is a good release: deployed, healthy, becomes :latest.
#   v3  is broken (its /health returns 503): the script rolls back to v2,
#       re-points :latest at v2, and fails the deploy.
#
# Usage: bash scripts/demo-rollback.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="salesplat/supportpro-backend"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

export FAKE_DOCKER_STATE="${WORK}/state"
export APP_DIR="${WORK}/app-stack"
export PATH="${REPO}/tests/fixtures/fake-docker:${PATH}"
export HEALTH_RETRIES=3 HEALTH_INTERVAL=0

key() { printf '%s' "$1" | tr '/:' '__'; }
# Stand-in commit SHAs (40 hex characters, like the real tags).
V1="1111111111111111111111111111111111111111"
V2="2222222222222222222222222222222222222222"
V3="3333333333333333333333333333333333333333"
sha_of() {
  case "$1" in v1) echo "${V1}" ;; v2) echo "${V2}" ;; v3) echo "${V3}" ;; esac
}

mkdir -p "${FAKE_DOCKER_STATE}/refs" "${FAKE_DOCKER_STATE}/remote" "${FAKE_DOCKER_STATE}/versions" "${APP_DIR}"
touch "${APP_DIR}/.env"
for v in v1 v2 v3; do
  sha="$(sha_of "${v}")"
  echo "sha256:image-${v}" >"${FAKE_DOCKER_STATE}/remote/$(key "${IMAGE}:${sha}")"
  echo "${sha}" >"${FAKE_DOCKER_STATE}/versions/$(key "sha256:image-${v}")"
done
# v1 is live, and v3's server never becomes healthy.
echo "sha256:image-v1" >"${FAKE_DOCKER_STATE}/container"
echo "sha256:image-v1" >"${FAKE_DOCKER_STATE}/refs/$(key "${IMAGE}:latest")"
echo "sha256:image-v3" >"${FAKE_DOCKER_STATE}/unhealthy"

name_of() {
  case "$1" in
    sha256:image-v1 | "${V1}") echo v1 ;;
    sha256:image-v2 | "${V2}") echo v2 ;;
    sha256:image-v3 | "${V3}") echo v3 ;;
    *) echo "unknown" ;;
  esac
}
serving() { name_of "$(cat "${FAKE_DOCKER_STATE}/container" 2>/dev/null || echo none)"; }
latest() { name_of "$(cat "${FAKE_DOCKER_STATE}/refs/$(key "${IMAGE}:latest")")"; }
health() { curl -fsS http://localhost:8000/health 2>&1 || true; }

banner() { printf '\n=============== %s ===============\n' "$*"; }

banner "Start"
echo "Serving: $(serving) | :latest = $(latest) | /health: $(health)"

banner "Deploy v2 (${V2}), a good release"
set +e
DEPLOY_SHA="${V2}" bash "${REPO}/scripts/deploy.sh" 2>&1 | grep '==>\|/health\|serving'
rc_v2=${PIPESTATUS[0]}
set -e
echo "deploy.sh exit code: ${rc_v2}"
echo "Serving: $(serving) | :latest = $(latest) | /health: $(health)"

banner "Deploy v3 (${V3}), a broken release (/health returns 503)"
set +e
DEPLOY_SHA="${V3}" bash "${REPO}/scripts/deploy.sh" 2>&1 | grep '==>\|/health\|serving\|crash'
rc_v3=${PIPESTATUS[0]}
set -e
echo "deploy.sh exit code: ${rc_v3} (non-zero, so the GitHub Actions run goes red)"
echo "Serving: $(serving) | :latest = $(latest) | /health: $(health)"

banner "Deploy history on the server (deploy-history.log)"
cat "${APP_DIR}/deploy-history.log"

banner "Result"
if [ "${rc_v2}" -eq 0 ] && [ "${rc_v3}" -ne 0 ] && [ "$(serving)" = v2 ] && [ "$(latest)" = v2 ]; then
  echo "Release v2 (${V2}) deployed and serving."
  echo "Release v3 (${V3}) was broken and was rolled back to v2; :latest points at v2 again."
  echo "DEMO OK"
else
  echo "DEMO FAILED: serving=$(serving) latest=$(latest) v2_exit=${rc_v2} v3_exit=${rc_v3}"
  exit 1
fi
