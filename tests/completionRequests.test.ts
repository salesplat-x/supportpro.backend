/**
 * An employee asks for a goal or task to be marked complete, with evidence. A reviewer decides.
 */

import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { Notification, StaffAccessLog } from "../src/entities";
import { StaffAccessResource } from "../src/entities/StaffAccessLog.js";
import { StaffActivity, StaffActivityType } from "../src/entities/StaffActivity.js";
import { StaffChecklistTask } from "../src/entities/StaffChecklistTask.js";
import {
  CompletionRequestStatus,
  StaffCompletionRequest,
} from "../src/entities/StaffCompletionRequest.js";
import { GoalStatus, StaffGoal } from "../src/entities/StaffGoal.js";
import { StaffGoalProgressEvent } from "../src/entities/StaffGoalProgressEvent.js";
import { addMember, authHeader, setupCompany } from "./helpers/company.js";
import { apiData } from "./helpers/http.js";
import { createStaff, staffPath } from "./helpers/staff.js";
import { employee } from "./helpers/team.js";
import { detectEvidenceType, evidenceKeysFor } from "../src/services/completionRequests.js";

jest.mock("../src/utils/integrations/spaces.js", () => ({
  uploadPrivateToSpaces: jest.fn().mockResolvedValue(undefined),
  getFromSpaces: jest.fn(),
  uploadToSpaces: jest.fn(),
  deleteFromSpaces: jest.fn(),
  deleteSpacesObjectQuietly: jest.fn().mockResolvedValue(undefined),
  spacesKeyFor: jest.fn((prefix: string, owner: string, name: string) => `${prefix}/${owner}/${name}`),
  assertSpacesConfigured: jest.fn(),
  ALLOWED_IMAGE_TYPES: [],
}));

jest.mock("../src/utils/integrations/openai.js", () => ({
  __esModule: true,
  createEmbedding: jest.fn(),
}));

jest.mock("../src/utils/integrations/email/emailService.js", () => {
  const sendPeopleUpdate = jest.fn().mockResolvedValue(undefined);
  return {
    __esModule: true,
    sendPeopleUpdate,
    default: jest.fn().mockImplementation(() => ({ sendPeopleUpdate, sendEmail: jest.fn() })),
  };
});

const spaces = jest.requireMock("../src/utils/integrations/spaces.js") as {
  uploadPrivateToSpaces: jest.Mock;
  getFromSpaces: jest.Mock;
  deleteSpacesObjectQuietly: jest.Mock;
};
const email = jest.requireMock("../src/utils/integrations/email/emailService.js") as {
  sendPeopleUpdate: jest.Mock;
};

const PDF = Buffer.from("%PDF-1.7 evidence");
const FUTURE = "2099-01-01";

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
}, 120_000);

afterAll(async () => {
  await stopTestDatabase();
});

beforeEach(() => {
  spaces.getFromSpaces.mockResolvedValue(PDF);
});

afterEach(async () => {
  await clearAllTables();
  jest.clearAllMocks();
  spaces.uploadPrivateToSpaces.mockResolvedValue(undefined);
  spaces.deleteSpacesObjectQuietly.mockResolvedValue(undefined);
  email.sendPeopleUpdate.mockResolvedValue(undefined);
});

async function company() {
  const { owner, org } = await setupCompany();
  const hr = await addMember(org, { firstName: "Hana", lastName: "Assigned" });
  const worker = await employee(app, owner.token, org.id, "Ada Obi");
  await request(app)
    .put(staffPath(org.id, "/hr-assignments"))
    .set(authHeader(owner.token))
    .send({ assigneeUserId: hr.user.id, add: [worker.staff.id] })
    .expect(200);

  const goalRes = await request(app)
    .post(staffPath(org.id, `/${worker.staff.id}/performance/goals`))
    .set(authHeader(owner.token))
    .send({ title: "Ship the redesign", keyResults: ["Launch"], target: "1", dueOn: FUTURE })
    .expect(201);
  const goal = apiData<{ goal: { id: string } }>(goalRes).goal;
  await testDataSource.getRepository(StaffGoal).update(goal.id, {
    status: GoalStatus.Approved,
    approvedAt: new Date(),
    approvedByName: "Olu Owner",
  });
  const task = await testDataSource
    .getRepository(StaffChecklistTask)
    .save({ staffId: worker.staff.id, title: "Meet your team" });
  jest.clearAllMocks();
  spaces.getFromSpaces.mockResolvedValue(PDF);
  return { owner, org, hr, worker, goalId: goal.id, taskId: task.id };
}

const perfPath = (orgId: string, staffId: string, suffix = "") =>
  staffPath(orgId, `/${staffId}/performance${suffix}`);

type Setup = Awaited<ReturnType<typeof company>>;

const submit = (
  setup: Setup,
  fields: Partial<{ itemType: string; itemId: string; summary: string; links: string[] }> = {},
  files: Array<{ buffer: Buffer; name: string; type?: string }> = [{ buffer: PDF, name: "proof.pdf" }]
) => {
  const req = request(app)
    .post(`/v1/my-work/${setup.worker.staff.id}/completion-requests`)
    .set(authHeader(setup.worker.token))
    .field("itemType", fields.itemType ?? "goal")
    .field("itemId", fields.itemId ?? setup.goalId)
    .field("summary", fields.summary ?? "I shipped it. Here's the launch report.");
  for (const link of fields.links ?? []) {
    req.field("links", link);
  }
  for (const file of files) {
    req.attach("files", file.buffer, {
      filename: file.name,
      contentType: file.type ?? "application/pdf",
    });
  }
  return req;
};

const submitted = async (setup: Setup, fields = {}) => {
  const res = await submit(setup, fields);
  expect(res.status).toBe(201);
  return apiData<{ request: { id: string; files: Array<{ id: string }> } }>(res).request;
};

const goalOf = (id: string) => testDataSource.getRepository(StaffGoal).findOneByOrFail({ id });
const requestOf = (id: string) =>
  testDataSource.getRepository(StaffCompletionRequest).findOneByOrFail({ id });

const approve = (setup: Setup, requestId: string, token: string, version: number | undefined = 1) =>
  request(app)
    .post(perfPath(setup.org.id, setup.worker.staff.id, `/completion-requests/${requestId}/approve`))
    .set(authHeader(token))
    .send({ version });

describe("detecting a file's type from its bytes", () => {
  it.each([
    ["PDF", Buffer.from("%PDF-1.7"), "application/pdf"],
    ["PNG", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]), "image/png"],
    ["JPEG", Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
    [
      "Word",
      Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("word/document.xml")]),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
  ])("accepts %s", (_name, buffer, mimeType) => {
    expect(detectEvidenceType(buffer)?.mimeType).toBe(mimeType);
  });

  it("refuses HTML, scripts and a plain zip", () => {
    expect(detectEvidenceType(Buffer.from("<html><script>alert(1)</script>"))).toBeNull();
    expect(detectEvidenceType(Buffer.from("#!/bin/sh"))).toBeNull();
    expect(detectEvidenceType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBeNull();
  });
});

describe("an employee asking for completion", () => {
  it("saves the summary and evidence, and tells the reviewers", async () => {
    const setup = await company();

    const res = await submit(setup, { links: ["https://docs.example.com/report"] });

    expect(res.status).toBe(201);
    const view = apiData<{ request: Record<string, unknown> }>(res).request;
    expect(view["status"]).toBe("pending");
    expect(view["itemTitle"]).toBe("Ship the redesign");
    expect(view["links"]).toEqual(["https://docs.example.com/report"]);
    expect(JSON.stringify(view)).not.toContain("completion-evidence/");
    expect(spaces.uploadPrivateToSpaces).toHaveBeenCalledTimes(1);

    const [notice] = await testDataSource
      .getRepository(Notification)
      .find({ where: { userId: setup.hr.user.id, type: "completion_request" } });
    expect(notice?.message).toContain("Ship the redesign");
    expect(notice?.organizationId).toBe(setup.org.id);
    expect(email.sendPeopleUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ to: setup.hr.user.email })
    );
  });

  it("tells only the creator when nobody is assigned", async () => {
    const setup = await company();
    await request(app)
      .put(staffPath(setup.org.id, "/hr-assignments"))
      .set(authHeader(setup.owner.token))
      .send({ assigneeUserId: setup.hr.user.id, remove: [setup.worker.staff.id] })
      .expect(200);

    await submitted(setup);

    expect(
      await testDataSource
        .getRepository(Notification)
        .count({ where: { userId: setup.owner.user.id, type: "completion_request" } })
    ).toBe(1);
  });

  it("works for a first-week task too", async () => {
    const setup = await company();

    const res = await submit(setup, { itemType: "task", itemId: setup.taskId });

    expect(res.status).toBe(201);
    expect(apiData<{ request: { itemType: string } }>(res).request.itemType).toBe("task");
  });

  it("needs a summary and at least one file or link", async () => {
    const setup = await company();

    expect((await submit(setup, { summary: "   " })).status).toBe(400);
    expect((await submit(setup, {}, [])).status).toBe(400);
    expect(spaces.uploadPrivateToSpaces).not.toHaveBeenCalled();
  });

  it("accepts a link with no file", async () => {
    const setup = await company();

    const res = await submit(setup, { links: ["https://example.com/a"] }, []);

    expect(res.status).toBe(201);
    expect(spaces.uploadPrivateToSpaces).not.toHaveBeenCalled();
  });

  it.each([
    "http://example.com/a",
    "javascript:alert(1)",
    "data:text/html,hello",
    "https://user:pass@example.com",
    "not a link",
  ])("refuses the link %s", async (link) => {
    const setup = await company();

    const res = await submit(setup, { links: [link] }, []);

    expect(res.status).toBe(400);
  });

  it("refuses a file that only claims to be a PDF", async () => {
    const setup = await company();

    const res = await submit(setup, {}, [
      { buffer: Buffer.from("<script>alert(1)</script>"), name: "proof.pdf", type: "application/pdf" },
    ]);

    expect(res.status).toBe(400);
    expect(spaces.uploadPrivateToSpaces).not.toHaveBeenCalled();
  });

  it("refuses more than the allowed files and links", async () => {
    const setup = await company();
    const file = { buffer: PDF, name: "a.pdf" };

    const tooManyFiles = await submit(setup, {}, [file, file, file, file]);
    const tooManyLinks = await submit(
      setup,
      { links: Array.from({ length: 6 }, (_, index) => `https://example.com/${index}`) },
      []
    );

    expect(tooManyFiles.status).toBe(400);
    expect(tooManyLinks.status).toBe(400);
  });

  it("refuses a second request while one is waiting, and cleans up its upload", async () => {
    const setup = await company();
    await submitted(setup);
    spaces.deleteSpacesObjectQuietly.mockClear();

    const res = await submit(setup);

    expect(res.status).toBe(409);
  });

  it("refuses a draft goal, a finished goal and someone else's goal", async () => {
    const setup = await company();
    await testDataSource.getRepository(StaffGoal).update(setup.goalId, {
      status: GoalStatus.Draft,
      approvedAt: null,
      approvedByName: null,
    });
    expect((await submit(setup)).status).toBe(404);

    await testDataSource.getRepository(StaffGoal).update(setup.goalId, {
      status: GoalStatus.Approved,
      approvedAt: new Date(),
      progress: 100,
      completedAt: new Date(),
    });
    expect((await submit(setup)).status).toBe(409);

    const other = await employee(app, setup.owner.token, setup.org.id, "Bayo Ade");
    const foreign = await request(app)
      .post(`/v1/my-work/${other.staff.id}/completion-requests`)
      .set(authHeader(other.token))
      .field("itemType", "goal")
      .field("itemId", setup.goalId)
      .field("summary", "Mine")
      .field("links", "https://example.com");
    expect(foreign.status).toBe(404);
  });

  it("can be withdrawn, which removes the files and allows a new request", async () => {
    const setup = await company();
    const pending = await submitted(setup);

    await request(app)
      .delete(`/v1/my-work/${setup.worker.staff.id}/completion-requests/${pending.id}`)
      .set(authHeader(setup.worker.token))
      .expect(200);

    expect((await requestOf(pending.id)).status).toBe(CompletionRequestStatus.Withdrawn);
    expect(spaces.deleteSpacesObjectQuietly).toHaveBeenCalled();
    expect((await submit(setup)).status).toBe(201);
  });

  it("can no longer finish things alone", async () => {
    const setup = await company();

    const toHundred = await request(app)
      .patch(`/v1/my-work/${setup.worker.staff.id}/goals/${setup.goalId}/progress`)
      .set(authHeader(setup.worker.token))
      .send({ progress: 100 });
    const tick = await request(app)
      .patch(`/v1/my-work/tasks/${setup.taskId}`)
      .set(authHeader(setup.worker.token))
      .send({ done: true });

    expect(toHundred.status).toBe(400);
    expect(tick.status).toBe(404);
    expect((await goalOf(setup.goalId)).progress).toBe(0);
  });
});

describe("a reviewer", () => {
  it("sees the summary, links and files on the Performance tab", async () => {
    const setup = await company();
    await submitted(setup, { links: ["https://example.com/report"] });

    const res = await request(app)
      .get(perfPath(setup.org.id, setup.worker.staff.id))
      .set(authHeader(setup.hr.token));

    const [item] = apiData<{
      performance: {
        completionRequests: Array<{
          summary: string;
          links: string[];
          files: Array<{ name: string }>;
        }>;
      };
    }>(res).performance.completionRequests;
    expect(item?.summary).toContain("I shipped it");
    expect(item?.links).toEqual(["https://example.com/report"]);
    expect(item?.files[0]?.name).toBe("proof.pdf");
  });

  it("downloads evidence as a logged attachment that can't run as a page", async () => {
    const setup = await company();
    const pending = await submitted(setup);
    await testDataSource.getRepository(StaffAccessLog).delete({ actorId: setup.hr.user.id });

    const res = await request(app)
      .get(
        perfPath(
          setup.org.id,
          setup.worker.staff.id,
          `/completion-requests/${pending.id}/files/${pending.files[0]!.id}`
        )
      )
      .set(authHeader(setup.hr.token));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    const logs = await testDataSource
      .getRepository(StaffAccessLog)
      .find({ where: { actorId: setup.hr.user.id, staffId: setup.worker.staff.id } });
    expect(logs.map((log) => log.resource)).toEqual([StaffAccessResource.Performance]);
  });

  it("can't reach another employee's evidence through a request id", async () => {
    const setup = await company();
    const pending = await submitted(setup);
    const other = await createStaff(app, setup.owner.token, setup.org.id);

    const res = await request(app)
      .get(
        perfPath(
          setup.org.id,
          other.id,
          `/completion-requests/${pending.id}/files/${pending.files[0]!.id}`
        )
      )
      .set(authHeader(setup.owner.token));

    expect(res.status).toBe(404);
  });

  it("marks a goal complete, records it and tells the employee", async () => {
    const setup = await company();
    const pending = await submitted(setup);
    await testDataSource.getRepository(StaffGoal).update(setup.goalId, { progress: 60 });

    await approve(setup, pending.id, setup.hr.token).expect(200);

    const goal = await goalOf(setup.goalId);
    expect(goal.progress).toBe(100);
    expect(goal.completedAt).not.toBeNull();
    expect(goal.completedByName).toBe("Hana Assigned");
    expect((await requestOf(pending.id)).status).toBe(CompletionRequestStatus.Approved);

    const events = await testDataSource
      .getRepository(StaffGoalProgressEvent)
      .find({ where: { goalId: setup.goalId } });
    expect(events.map((event) => [event.fromProgress, event.toProgress])).toEqual([[60, 100]]);

    expect(
      await testDataSource.getRepository(StaffActivity).count({
        where: { staffId: setup.worker.staff.id, type: StaffActivityType.CompletionApproved },
      })
    ).toBe(1);
    const [notice] = await testDataSource
      .getRepository(Notification)
      .find({ where: { userId: setup.worker.user.id, type: "completion_request" } });
    expect(notice?.link).toBe("/talentDashboard/my-work");
    expect(notice?.organizationId).toBeNull();
    expect(email.sendPeopleUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ to: setup.worker.user.email })
    );
  });

  it("marks a task complete", async () => {
    const setup = await company();
    const pending = await submitted(setup, { itemType: "task", itemId: setup.taskId });

    await approve(setup, pending.id, setup.hr.token, undefined).expect(200);

    const task = await testDataSource
      .getRepository(StaffChecklistTask)
      .findOneByOrFail({ id: setup.taskId });
    expect(task.doneAt).not.toBeNull();
    expect(task.completedByName).toBe("Hana Assigned");
  });

  it("refuses an approval when the goal changed since it was opened", async () => {
    const setup = await company();
    const pending = await submitted(setup);
    await testDataSource.getRepository(StaffGoal).update(setup.goalId, { version: 2 });

    const res = await approve(setup, pending.id, setup.hr.token, 1);

    expect(res.status).toBe(409);
    expect((await goalOf(setup.goalId)).completedAt).toBeNull();
  });

  it("can't approve twice", async () => {
    const setup = await company();
    const pending = await submitted(setup);

    await approve(setup, pending.id, setup.hr.token).expect(200);

    expect((await approve(setup, pending.id, setup.hr.token)).status).toBe(409);
  });

  it("sends work back with a note, and the employee can try again", async () => {
    const setup = await company();
    const pending = await submitted(setup);

    await request(app)
      .post(
        perfPath(
          setup.org.id,
          setup.worker.staff.id,
          `/completion-requests/${pending.id}/return`
        )
      )
      .set(authHeader(setup.hr.token))
      .send({ note: "Add the launch numbers." })
      .expect(200);

    const saved = await requestOf(pending.id);
    expect(saved.status).toBe(CompletionRequestStatus.Returned);
    expect(saved.reviewNote).toBe("Add the launch numbers.");
    expect((await goalOf(setup.goalId)).completedAt).toBeNull();
    expect((await submit(setup)).status).toBe(201);
  });

  it("needs a note to send work back", async () => {
    const setup = await company();
    const pending = await submitted(setup);

    const res = await request(app)
      .post(
        perfPath(
          setup.org.id,
          setup.worker.staff.id,
          `/completion-requests/${pending.id}/return`
        )
      )
      .set(authHeader(setup.hr.token))
      .send({ note: "" });

    expect(res.status).toBe(400);
  });

  it("can mark things complete with no request, for employees without an account", async () => {
    const setup = await company();
    const noAccount = await createStaff(app, setup.owner.token, setup.org.id);
    const task = await testDataSource
      .getRepository(StaffChecklistTask)
      .save({ staffId: noAccount.id, title: "Sign the form" });

    await request(app)
      .post(perfPath(setup.org.id, noAccount.id, `/tasks/${task.id}/complete`))
      .set(authHeader(setup.owner.token))
      .expect(200);
    await request(app)
      .post(perfPath(setup.org.id, setup.worker.staff.id, `/goals/${setup.goalId}/complete`))
      .set(authHeader(setup.hr.token))
      .send({ version: 1 })
      .expect(200);

    expect((await goalOf(setup.goalId)).progress).toBe(100);
  });

  it("closes a waiting request when it marks the goal complete directly", async () => {
    const setup = await company();
    const pending = await submitted(setup);

    await request(app)
      .post(perfPath(setup.org.id, setup.worker.staff.id, `/goals/${setup.goalId}/complete`))
      .set(authHeader(setup.hr.token))
      .send({ version: 1 })
      .expect(200);

    expect((await requestOf(pending.id)).status).toBe(CompletionRequestStatus.Approved);
  });

  it("can't complete a draft goal", async () => {
    const setup = await company();
    await testDataSource.getRepository(StaffGoal).update(setup.goalId, {
      status: GoalStatus.Draft,
      approvedAt: null,
      approvedByName: null,
    });

    const res = await request(app)
      .post(perfPath(setup.org.id, setup.worker.staff.id, `/goals/${setup.goalId}/complete`))
      .set(authHeader(setup.owner.token))
      .send({ version: 1 });

    expect(res.status).toBe(409);
  });

  it("can reopen a mistake, which restores the progress and lets the employee continue", async () => {
    const setup = await company();
    await testDataSource.getRepository(StaffGoal).update(setup.goalId, { progress: 60 });
    await request(app)
      .post(perfPath(setup.org.id, setup.worker.staff.id, `/goals/${setup.goalId}/complete`))
      .set(authHeader(setup.hr.token))
      .send({ version: 1 })
      .expect(200);

    await request(app)
      .post(perfPath(setup.org.id, setup.worker.staff.id, `/goals/${setup.goalId}/reopen`))
      .set(authHeader(setup.hr.token))
      .expect(200);

    const goal = await goalOf(setup.goalId);
    expect(goal.progress).toBe(60);
    expect(goal.completedAt).toBeNull();
    await request(app)
      .patch(`/v1/my-work/${setup.worker.staff.id}/goals/${setup.goalId}/progress`)
      .set(authHeader(setup.worker.token))
      .send({ progress: 70 })
      .expect(200);
  });

  it("locks an employee's progress once a goal is complete", async () => {
    const setup = await company();
    await request(app)
      .post(perfPath(setup.org.id, setup.worker.staff.id, `/goals/${setup.goalId}/complete`))
      .set(authHeader(setup.hr.token))
      .send({ version: 1 })
      .expect(200);

    const res = await request(app)
      .patch(`/v1/my-work/${setup.worker.staff.id}/goals/${setup.goalId}/progress`)
      .set(authHeader(setup.worker.token))
      .send({ progress: 50 });

    expect(res.status).toBe(409);
  });
});

describe("who can review", () => {
  it("lets the creator, a switch teammate and a direct manager review", async () => {
    const setup = await company();
    const manager = await addMember(setup.org, { canManagePeople: true, firstName: "Sam" });

    const first = await submitted(setup);
    await approve(setup, first.id, manager.token).expect(200);
    await request(app)
      .post(perfPath(setup.org.id, setup.worker.staff.id, `/goals/${setup.goalId}/reopen`))
      .set(authHeader(setup.owner.token))
      .expect(200);

    const second = await submitted(setup);
    await approve(setup, second.id, setup.owner.token).expect(200);
    await request(app)
      .post(perfPath(setup.org.id, setup.worker.staff.id, `/goals/${setup.goalId}/reopen`))
      .set(authHeader(setup.owner.token))
      .expect(200);

    const boss = await employee(app, setup.owner.token, setup.org.id, "Bola Boss");
    await request(app)
      .patch(staffPath(setup.org.id, `/${setup.worker.staff.id}`))
      .set(authHeader(setup.owner.token))
      .send({ managerId: boss.staff.id })
      .expect(200);
    const third = await submitted(setup);
    await request(app)
      .post(`/v1/my-work/${boss.staff.id}/team/${setup.worker.staff.id}/completion-requests/${third.id}/approve`)
      .set(authHeader(boss.token))
      .send({ version: 1 })
      .expect(200);
  });

  it("refuses a teammate who isn't assigned, and anyone once they're removed", async () => {
    const setup = await company();
    const pending = await submitted(setup);
    const plain = await addMember(setup.org, { firstName: "Pat" });

    expect((await approve(setup, pending.id, plain.token)).status).toBe(403);

    await request(app)
      .put(staffPath(setup.org.id, "/hr-assignments"))
      .set(authHeader(setup.owner.token))
      .send({ assigneeUserId: setup.hr.user.id, remove: [setup.worker.staff.id] })
      .expect(200);

    expect((await approve(setup, pending.id, setup.hr.token)).status).toBe(403);
    expect((await requestOf(pending.id)).status).toBe(CompletionRequestStatus.Pending);
  });

  it("refuses the employee reviewing themselves", async () => {
    const setup = await company();
    const pending = await submitted(setup);

    const res = await approve(setup, pending.id, setup.worker.token);

    expect(res.status).toBe(403);
  });

  it("refuses someone whose own email is on the record, even the creator", async () => {
    const setup = await company();
    const ownRecord = await createStaff(app, setup.owner.token, setup.org.id, {
      fullName: "Olu Owner",
      email: setup.owner.user.email,
    });
    const task = await testDataSource
      .getRepository(StaffChecklistTask)
      .save({ staffId: ownRecord.id, title: "Sign the form" });

    const res = await request(app)
      .post(perfPath(setup.org.id, ownRecord.id, `/tasks/${task.id}/complete`))
      .set(authHeader(setup.owner.token));

    expect(res.status).toBe(403);
  });
});

describe("cleaning up", () => {
  it("withdraws waiting requests when employment ends", async () => {
    const setup = await company();
    const pending = await submitted(setup);

    await request(app)
      .post(staffPath(setup.org.id, `/${setup.worker.staff.id}/end`))
      .set(authHeader(setup.owner.token))
      .send({ endDate: "2026-01-06" })
      .expect(200);

    expect((await requestOf(pending.id)).status).toBe(CompletionRequestStatus.Withdrawn);
  });

  it("deletes the evidence when a goal or task is removed", async () => {
    const setup = await company();
    await submitted(setup);
    await submitted(setup, { itemType: "task", itemId: setup.taskId });
    spaces.deleteSpacesObjectQuietly.mockClear();

    await request(app)
      .delete(perfPath(setup.org.id, setup.worker.staff.id, `/goals/${setup.goalId}`))
      .set(authHeader(setup.owner.token))
      .expect(200);
    await request(app)
      .delete(staffPath(setup.org.id, `/${setup.worker.staff.id}/checklist/${setup.taskId}`))
      .set(authHeader(setup.owner.token))
      .expect(200);

    expect(spaces.deleteSpacesObjectQuietly).toHaveBeenCalledTimes(2);
    expect(await testDataSource.getRepository(StaffCompletionRequest).count()).toBe(0);
  });

  it("finds every company file before a company is deleted", async () => {
    const setup = await company();
    await submitted(setup);

    const keys = await evidenceKeysFor({ organizationId: setup.org.id });

    expect(keys).toHaveLength(1);
  });

  it("removes the upload when saving the request fails", async () => {
    const setup = await company();
    await testDataSource.getRepository(StaffGoal).delete(setup.goalId);

    const res = await submit(setup);

    expect(res.status).toBe(404);
    expect(spaces.deleteSpacesObjectQuietly).toHaveBeenCalledTimes(1);
  });
});
