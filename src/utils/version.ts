// The commit SHA this build was made from. The Docker build bakes it in
// (`--build-arg GIT_SHA=<sha>` → `ENV APP_VERSION`), so /health can say which
// release is serving. Local runs without it report "unknown".
export function getAppVersion(): string {
  return process.env.APP_VERSION?.trim() || "unknown";
}
