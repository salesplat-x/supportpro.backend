import {
  buildCandidatePipelines,
  loadTalentApplications,
  type PipelineStep,
} from "./candidatePipeline.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface TalentTodo {
  applicationId: string;
  jobId: string;
  jobTitle: string;
  company: { name: string; logoUrl: string | null } | null;
  step: PipelineStep;
}

export interface TalentDashboard {
  applications: { sent: number; sentThisWeek: number };
  tests: { toTake: number; nextDueAt: string | null };
  interviews: { toRecord: number; nextDueAt: string | null };
  todo: TalentTodo[];
}

const earliest = (dates: Array<string | null>): string | null =>
  dates.filter((date): date is string => !!date).sort()[0] ?? null;

export const getTalentDashboard = async (talentId: string): Promise<TalentDashboard> => {
  const applications = await loadTalentApplications(talentId);
  const pipelines = await buildCandidatePipelines(talentId, applications);
  const weekAgo = Date.now() - WEEK_MS;

  const todo: TalentTodo[] = pipelines
    .filter((pipeline) => pipeline.application.group === "needs_you" && pipeline.nextStep)
    .map((pipeline) => ({
      applicationId: pipeline.application.id,
      jobId: pipeline.application.jobId,
      jobTitle: pipeline.application.job.title,
      company: pipeline.application.job.organization
        ? {
            name: pipeline.application.job.organization.name,
            logoUrl: pipeline.application.job.organization.logoUrl,
          }
        : null,
      step: pipeline.nextStep!,
    }))
    .sort((a, b) => (a.step.dueAt ?? "~").localeCompare(b.step.dueAt ?? "~"));

  const tests = todo.filter((item) => item.step.key !== "ai_interview");
  const interviews = todo.filter((item) => item.step.key === "ai_interview");

  return {
    applications: {
      sent: pipelines.length,
      sentThisWeek: pipelines.filter(
        (pipeline) => new Date(pipeline.application.appliedAt).getTime() >= weekAgo
      ).length,
    },
    tests: { toTake: tests.length, nextDueAt: earliest(tests.map((item) => item.step.dueAt)) },
    interviews: {
      toRecord: interviews.length,
      nextDueAt: earliest(interviews.map((item) => item.step.dueAt)),
    },
    todo,
  };
};
