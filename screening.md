# Pre-Assessment (Screening) System

## What it is

After a user signs up and completes their profile, they go through a multi-stage AI-powered screening process before they can apply to jobs and get shortlisted.

---

## The Full Flow

```
Signup → Complete Profile → Prescreening → Apply to Job → Personalized → Personality → Shortlisted
```

### Stage 1 — Prescreening (before applying to any job)

**Trigger:** User completes their profile and selects a role.

- User fetches questions: `GET /questions?questionType=prescreening&roleId=<id>`
- User submits answers: `POST /questions/answer/prescreening`
- Logic: [src/logics/v1/question.ts:146-245](src/logics/v1/question.ts#L146-L245)
- Each answer is sent to OpenAI to be graded (score 0–5 per question)
- Final score = `(totalScore / maxScore) * 100`
- Score is saved on the user's profile: `user.profile.prescreeningScore`
- If failed: user is blocked for **7 days** before retrying
- This score is a **gate to apply for jobs**

### Stage 2 — Personalized Questions (per job application)

**Trigger:** User applies to a job via `POST /questions/personalized`

- Logic: [src/logics/v1/question.ts:248-343](src/logics/v1/question.ts#L248-L343)
- OpenAI generates questions dynamically based on the job description, user CV, and bio
- An Application record is created with `currentStage: Prescreening`
- User answers: `POST /questions/answer/personalized`
- Logic: [src/logics/v1/question.ts:346-465](src/logics/v1/question.ts#L346-L465)
- If score < `minPersonalizedScore` → status set to `RetakeAssessment` (retry after N days)
- If score passes → advances to next stage

### Stage 3 — Personality (MBTI)

**Trigger:** After passing personalized questions.

- 4 questions generated, one per MBTI dichotomy: `EI, SN, TF, JP`
- `POST /questions/personality` → `POST /questions/answer/personality`
- Logic: [src/logics/v1/question.ts:468-591](src/logics/v1/question.ts#L468-L591)
- OpenAI determines the user's MBTI type from their answers
- Result stored as `application.mbtiType`
- After this → application is marked `Completed` and user is **Shortlisted**

### Final Ranking

- Logic: [src/logics/v1/applications.ts](src/logics/v1/applications.ts)
- Average of: `prescreeningScore + cvSimilarityScore + personalizedScore`
- Used to rank applicants against each other

---

## Key Files

| What                                    | File                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------- |
| Assessment pipeline (main logic)        | [src/logics/v1/question.ts](src/logics/v1/question.ts)                                 |
| Stage config per job                    | [src/logics/v1/aiconfig.ts](src/logics/v1/aiconfig.ts)                                 |
| Job apply gate (prescreening check)     | [src/logics/v1/job.ts](src/logics/v1/job.ts)                                           |
| Application stages & scoring            | [src/logics/v1/applications.ts](src/logics/v1/applications.ts)                         |
| OpenAI calls (grading, generation)      | [src/services/v1/openai.ts](src/services/v1/openai.ts)                                 |
| Application model (stages, statuses)    | [src/models/v1/application.ts](src/models/v1/application.ts)                           |
| Question model                          | [src/models/v1/question.ts](src/models/v1/question.ts)                                 |
| Answer model (stores responses)         | [src/models/v1/answer.ts](src/models/v1/answer.ts)                                     |
| AI config per job (which stages on/off) | [src/models/v1/AIconfig.ts](src/models/v1/AIconfig.ts)                                 |
| User prescreening score                 | [src/models/v1/user.ts](src/models/v1/user.ts)                                         |
| Routes                                  | [src/routes/v1/question.ts](src/routes/v1/question.ts)                                 |
| Validators                              | [src/middlewares/v1/validators/question.ts](src/middlewares/v1/validators/question.ts) |

---

## Application Statuses & Stages

**Stages** (in order):
`Prescreening → CvSimilarity → Personalized → Personality → Completed`

**Statuses:**

- `Pending` — in progress
- `RetakeAssessment` — failed, locked until retry date
- `Shortlisted` — passed all stages
- `NotProceeding` — recruiter rejected
- `Rejected` — failed assessment

---

## How AI Config Controls the Pipeline

Each job can have an `AIConfig` ([src/models/v1/AIconfig.ts](src/models/v1/AIconfig.ts)) that toggles stages on/off:

- `prescreeningAssessment: true/false`
- `cvSimilarity: true/false`
- `personalizedAssessment: true/false`
- `personalityEvaluation: true/false`

The `createStages()` function ([src/logics/v1/aiconfig.ts](src/logics/v1/aiconfig.ts)) builds a Map of `currentStage → nextStage` based on which are enabled.

---

## Improvement Areas

### 1. CV Similarity stage is not implemented

The `CvSimilarity` stage is defined in the pipeline but there's no logic that actually runs it. The `createEmbedding()` service exists in [src/services/v1/openai.ts](src/services/v1/openai.ts) but it's not wired into the application flow.

**Fix:** Add a step after personalized questions that compares the user's CV embedding to the job description embedding and stores a `cvSimilarityScore`.

### 2. Prescreening is per-role, not per-job

The prescreening score is stored on the user's profile (`user.profile.prescreeningScore`), which means one score covers all jobs for that role. If a user retakes for a different role, the old score is overwritten.

**Fix:** Consider storing scores as a map of `roleId → score` or linking it to the application.

### 3. No way to skip failed personality stage

If OpenAI fails to return a valid MBTI type, the logic at [src/logics/v1/question.ts:496-591](src/logics/v1/question.ts#L496-L591) may silently fail. There's no fallback or error status.

**Fix:** Add a fallback status or error handling that tells the user to retry, instead of silently stopping.

### 4. Retry date is hardcoded to 7 days

`setAssessmentRetryDate()` in [src/models/v1/user.ts](src/models/v1/user.ts) defaults to 7 days everywhere. For personalized questions, the retry window should probably be configurable per job/recruiter.

**Fix:** Pass the retry days from `AIConfig` instead of using a hardcoded default.

### 5. No tests on the assessment logic

The core scoring at [src/logics/v1/question.ts:217-226](src/logics/v1/question.ts#L217-L226) and [src/logics/v1/question.ts:430-440](src/logics/v1/question.ts#L430-L440) has no unit tests. If OpenAI returns an unexpected response shape, the scoring breaks silently.

**Fix:** Unit test `answerPrescreening` and `answerPersonalizedQuestions` with mocked OpenAI responses — especially edge cases like missing scores or out-of-range values.

### 6. Average score calculation excludes null scores

[src/logics/v1/applications.ts](src/logics/v1/applications.ts) filters out null scores when averaging. If a stage is skipped (disabled in AI config), the final rank will be based on fewer data points — but there's no normalization.

**Fix:** Either normalize the average based on enabled stages only, or document that skipped stages don't count toward ranking.
