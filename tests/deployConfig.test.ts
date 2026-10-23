import { readFileSync } from "fs";
import path from "path";
import yaml from "js-yaml";

// Guards the wiring around scripts/deploy.sh: the image is built with its commit
// baked in, only the commit tag is pushed before the health check, the droplet
// runs the tested script for that exact SHA, and :latest moves only after a
// healthy deploy.
const REPO = path.resolve(__dirname, "..");
const IMAGE = "salesplat/supportpro-backend";

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}

interface Job {
  needs?: string | string[];
  if?: string;
  steps: Step[];
}

interface Workflow {
  on: Record<string, unknown>;
  env?: Record<string, string>;
  jobs: Record<string, Job>;
}

const workflow = yaml.load(
  readFileSync(path.join(REPO, ".github/workflows/main.yml"), "utf8")
) as Workflow;
const dockerfile = readFileSync(path.join(REPO, "Dockerfile"), "utf8");
const compose = readFileSync(path.join(REPO, "docker-compose.yml"), "utf8");

const job = (name: string): Job => {
  const found = workflow.jobs[name];
  if (!found) throw new Error(`main.yml has no "${name}" job`);
  return found;
};

const stepUsing = (job: Job, action: string): Step => {
  const step = job.steps.find((s) => s.uses?.startsWith(action));
  if (!step) throw new Error(`no step uses ${action}`);
  return step;
};

describe("Dockerfile", () => {
  const production = dockerfile.slice(dockerfile.indexOf("AS production"));

  it("bakes the commit SHA into the production image as APP_VERSION", () => {
    expect(production).toMatch(/^ARG GIT_SHA(=\S+)?$/m);
    expect(production).toMatch(/^ENV APP_VERSION=\$\{?GIT_SHA\}?$/m);
  });

  it("labels the image with its source revision", () => {
    expect(production).toMatch(/org\.opencontainers\.image\.revision=\$\{?GIT_SHA\}?/);
  });
});

describe("deploy workflow (.github/workflows/main.yml)", () => {
  it("derives one DEPLOY_SHA from the CI run or a manual input", () => {
    expect(workflow.env?.DEPLOY_SHA).toContain("github.event.workflow_run.head_sha");
    expect(workflow.env?.DEPLOY_SHA).toContain("inputs.sha");
  });

  it("can be run by hand to redeploy (roll back to) a known commit", () => {
    const dispatch = workflow.on.workflow_dispatch as
      { inputs?: Record<string, { required?: boolean } | undefined> } | undefined;
    expect(dispatch?.inputs?.sha?.required).toBe(true);
  });

  it("pushes only the commit tag at build time, with the SHA as a build arg", () => {
    const build = stepUsing(job("build-and-push"), "docker/build-push-action");
    const tags = build.with?.tags ?? "";
    expect(tags).toContain(`${IMAGE}:\${{ env.DEPLOY_SHA }}`);
    expect(tags).not.toContain(":latest");
    expect(build.with?.["build-args"]).toContain("GIT_SHA=${{ env.DEPLOY_SHA }}");
  });

  it("runs the tested scripts/deploy.sh on the droplet for that SHA", () => {
    const deploy = job("deploy");
    expect(deploy.steps.some((s) => s.uses?.startsWith("actions/checkout"))).toBe(true);
    const ssh = stepUsing(deploy, "appleboy/ssh-action");
    expect(ssh.with?.script_path).toBe("scripts/deploy.sh");
    expect(ssh.with?.script).toBeUndefined();
    expect(ssh.with?.envs).toContain("DEPLOY_SHA");
    expect(ssh.env?.DEPLOY_SHA).toBe("${{ env.DEPLOY_SHA }}");
  });

  it("moves :latest on Docker Hub only after a healthy deploy", () => {
    const promote = job("promote-latest");
    expect(promote.needs).toBe("deploy");
    expect(promote.if).toContain("needs.deploy.result == 'success'");
    const run = promote.steps.map((s) => s.run ?? "").join("\n");
    expect(run).toMatch(/docker buildx imagetools create/);
    expect(run).toContain(`${IMAGE}:latest`);
    expect(run).toContain(`${IMAGE}:\${DEPLOY_SHA}`);
  });

  it("never interpolates the manual input straight into a shell command", () => {
    for (const each of Object.values(workflow.jobs)) {
      for (const step of each.steps) {
        expect(step.run ?? "").not.toMatch(/\$\{\{\s*(github\.event\.)?inputs\./);
      }
    }
  });
});

describe("docker-compose.yml", () => {
  it("runs a pinned tag when IMAGE_TAG is set instead of always :latest", () => {
    expect(compose).not.toMatch(new RegExp(`image: ${IMAGE}:latest`));
    expect(compose).toContain(`image: ${IMAGE}:\${IMAGE_TAG:-latest}`);
  });
});
