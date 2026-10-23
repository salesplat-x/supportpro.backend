import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

// Exercises scripts/deploy.sh (the script the production deploy runs on the
// droplet) against a fake docker/curl on PATH, so every branch of the
// deploy/rollback logic is proven without a real server.
const REPO = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO, "scripts/deploy.sh");
const FAKE_BIN = path.join(REPO, "tests/fixtures/fake-docker");
const IMAGE = "salesplat/supportpro-backend";

const OLD_SHA = "1111111111111111111111111111111111111111";
const NEW_SHA = "2222222222222222222222222222222222222222";
const OLD_ID = "sha256:0ld0ld";
const NEW_ID = "sha256:new0new";

const key = (ref: string): string => ref.replace(/[/:]/g, "_");

interface World {
  state: string;
  appDir: string;
}

interface RunResult {
  code: number | null;
  output: string;
}

function makeWorld(opts: { running?: boolean } = {}): World {
  const root = mkdtempSync(path.join(tmpdir(), "deploy-test-"));
  const state = path.join(root, "state");
  const appDir = path.join(root, "app-stack");
  for (const dir of ["refs", "remote", "versions"]) {
    mkdirSync(path.join(state, dir), { recursive: true });
  }
  mkdirSync(appDir);
  writeFileSync(path.join(appDir, ".env"), "PORT=8000\n");

  // The registry holds both releases; the old one is what's serving now.
  writeFileSync(path.join(state, "remote", key(`${IMAGE}:${OLD_SHA}`)), `${OLD_ID}\n`);
  writeFileSync(path.join(state, "remote", key(`${IMAGE}:${NEW_SHA}`)), `${NEW_ID}\n`);
  writeFileSync(path.join(state, "versions", key(OLD_ID)), `${OLD_SHA}\n`);
  writeFileSync(path.join(state, "versions", key(NEW_ID)), `${NEW_SHA}\n`);
  if (opts.running !== false) {
    writeFileSync(path.join(state, "refs", key(`${IMAGE}:latest`)), `${OLD_ID}\n`);
    writeFileSync(path.join(state, "container"), `${OLD_ID}\n`);
  }
  return { state, appDir };
}

function deploy(world: World, sha: string | undefined): RunResult {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${FAKE_BIN}:${process.env.PATH ?? ""}`,
    FAKE_DOCKER_STATE: world.state,
    APP_DIR: world.appDir,
    HEALTH_RETRIES: "3",
    HEALTH_INTERVAL: "0",
  };
  delete env.DEPLOY_SHA;
  if (sha !== undefined) env.DEPLOY_SHA = sha;
  const res = spawnSync("bash", [SCRIPT], { env, encoding: "utf8", timeout: 30_000 });
  return { code: res.status, output: `${res.stdout}${res.stderr}` };
}

const read = (file: string): string => (existsSync(file) ? readFileSync(file, "utf8").trim() : "");
const running = (w: World): string => read(path.join(w.state, "container"));
const latest = (w: World): string => read(path.join(w.state, "refs", key(`${IMAGE}:latest`)));
const calls = (w: World): string[] =>
  read(path.join(w.state, "calls.log"))
    .split("\n")
    .filter((line) => line.startsWith("docker "));
const markUnhealthy = (w: World, id: string): void =>
  writeFileSync(path.join(w.state, "unhealthy"), `${id}\n`);

describe("scripts/deploy.sh", () => {
  const worlds: World[] = [];
  const world = (opts?: { running?: boolean }): World => {
    const w = makeWorld(opts);
    worlds.push(w);
    return w;
  };

  afterAll(() => {
    for (const w of worlds) rmSync(path.dirname(w.state), { recursive: true, force: true });
  });

  it("deploys the exact commit tag, never :latest", () => {
    const w = world();

    const res = deploy(w, NEW_SHA);

    expect(res.code).toBe(0);
    const log = calls(w);
    expect(log).toContain(`docker pull ${IMAGE}:${NEW_SHA}`);
    const pullsAndRuns = log.filter(
      (c) => c.startsWith("docker pull") || c.startsWith("docker run")
    );
    expect(pullsAndRuns.length).toBeGreaterThan(0);
    for (const c of pullsAndRuns) {
      expect(c).not.toContain(":latest");
    }
    // Migrations run from the same image that is about to go live.
    expect(log.some((c) => c.includes(`${IMAGE}:${NEW_SHA}`) && c.includes("migrate.js"))).toBe(
      true
    );
  });

  it("keeps a healthy release and makes it the current (:latest) image", () => {
    const w = world();

    const res = deploy(w, NEW_SHA);

    expect(res.code).toBe(0);
    expect(running(w)).toBe(NEW_ID);
    expect(latest(w)).toBe(NEW_ID);
    expect(res.output).toContain(`now serving ${NEW_SHA}`);
  });

  it("rolls back to the previous image when the new release fails its health check", () => {
    const w = world();
    markUnhealthy(w, NEW_ID);

    const res = deploy(w, NEW_SHA);

    expect(res.code).not.toBe(0);
    expect(running(w)).toBe(OLD_ID);
    expect(res.output).toContain("Rolling back");
    expect(res.output).toContain(`Rollback complete; serving ${OLD_SHA}`);
  });

  it("re-points :latest at the good image after a rollback", () => {
    const w = world();
    markUnhealthy(w, NEW_ID);
    // Something (the old pipeline, a manual pull) already moved :latest to the broken image.
    writeFileSync(path.join(w.state, "refs", key(`${IMAGE}:latest`)), `${NEW_ID}\n`);

    deploy(w, NEW_SHA);

    expect(latest(w)).toBe(OLD_ID);
  });

  it("treats a release that reports a different version as unhealthy", () => {
    const w = world();
    // The new image answers /health but claims to be some other commit.
    writeFileSync(path.join(w.state, "versions", key(NEW_ID)), "3333333\n");

    const res = deploy(w, NEW_SHA);

    expect(res.code).not.toBe(0);
    expect(res.output).toContain(`expected ${NEW_SHA}`);
    expect(running(w)).toBe(OLD_ID);
    expect(latest(w)).toBe(OLD_ID);
  });

  it("leaves production untouched when migrations fail", () => {
    const w = world();
    writeFileSync(path.join(w.state, "fail_migrate"), `${NEW_ID}\n`);

    const res = deploy(w, NEW_SHA);

    expect(res.code).not.toBe(0);
    expect(res.output).toContain("Migrations failed");
    expect(running(w)).toBe(OLD_ID);
    expect(latest(w)).toBe(OLD_ID);
    expect(calls(w).some((c) => c.startsWith("docker run -d"))).toBe(false);
  });

  it("refuses to run without a full 40-character commit SHA", () => {
    for (const sha of [undefined, "", "latest", "abc1234"]) {
      const w = world();

      const res = deploy(w, sha);

      expect(res.code).toBe(2);
      expect(res.output).toContain("DEPLOY_SHA");
      expect(calls(w)).toEqual([]);
    }
  });

  it("stops before touching the server when the commit's image does not exist", () => {
    const w = world();
    const missing = "4444444444444444444444444444444444444444";

    const res = deploy(w, missing);

    expect(res.code).not.toBe(0);
    expect(res.output).toContain(`Image ${IMAGE}:${missing} could not be pulled`);
    expect(running(w)).toBe(OLD_ID);
    expect(calls(w).some((c) => c.startsWith("docker run"))).toBe(false);
  });

  it("fails clearly when a broken first release has nothing to roll back to", () => {
    const w = world({ running: false });
    markUnhealthy(w, NEW_ID);

    const res = deploy(w, NEW_SHA);

    expect(res.code).not.toBe(0);
    expect(res.output).toContain("nothing to roll back to");
  });

  it("records each outcome in deploy-history.log", () => {
    const ok = world();
    deploy(ok, NEW_SHA);
    expect(read(path.join(ok.appDir, "deploy-history.log"))).toMatch(
      new RegExp(`\\s${NEW_SHA}\\s+deployed$`)
    );

    const bad = world();
    markUnhealthy(bad, NEW_ID);
    deploy(bad, NEW_SHA);
    expect(read(path.join(bad.appDir, "deploy-history.log"))).toMatch(
      new RegExp(`\\s${NEW_SHA}\\s+rolled-back-to\\s+${OLD_ID}$`)
    );
  });
});
