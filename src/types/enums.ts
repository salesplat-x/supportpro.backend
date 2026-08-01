export enum UserRole {
  Admin = "admin",
  Talent = "talent",
  Recruiter = "recruiter",
}

export enum WorkType {
  Remote = "remote",
  OnSite = "onSite",
  Hybrid = "hybrid",
}

export enum ExperienceLevel {
  OneToThree = "1-3 years",
  FourToSix = "4-6 years",
  SevenToTen = "7-10 years",
  ElevenToFifteen = "11-15 years",
  SixteenPlus = "16 years and above",
}

export enum Currency {
  NGN = "NGN",
  USD = "USD",
}

export enum JobStatus {
  Draft = "draft",
  Active = "active",
  Suspended = "suspended",
  Closed = "closed",
}

export enum CompensationPeriod {
  Monthly = "monthly",
  Yearly = "yearly",
}

export enum WorkMode {
  Remote = "remote",
  OnSite = "onSite",
  Hybrid = "hybrid",
}

export enum ApplicationType {
  Invitation = "by invitation",
  Application = "by application",
}

export enum ApplicationStatus {
  Pending = "pending",
  RetakeAssessment = "retake_assessment",
  NotProceeding = "not_proceeding",
  AwaitingDecision = "awaiting_decision",
  Shortlisted = "shortlisted",
  Rejected = "rejected",
}

export enum MatchVerdict {
  High = "high",
  Medium = "medium",
  Low = "low",
}

export enum MatchRecommendation {
  Hire = "hire",
  InterviewFurther = "interview_further",
  NoHire = "no_hire",
}

export enum ScreeningStage {
  Prescreening = "prescreening",
  CvSimilarity = "cv_similarity",
  Personalized = "personalized",
  Personality = "personality",
  Completed = "completed",
}

export enum PaymentStatus {
  Pending = "pending",
  Failed = "failed",
  Cancelled = "cancelled",
  Completed = "completed",
}

export enum BillingInterval {
  Monthly = "monthly",
  Annually = "annually",
}

export enum SubscriptionStatus {
  Active = "active",
  Pending = "pending",
  NonRenewing = "non-renewing",
  Attention = "attention",
  Completed = "completed",
  Cancelled = "cancelled",
  Expired = "expired",
}

export enum QuestionType {
  Prescreening = "prescreening",
  Personality = "personality",
  Personalized = "personalized",
}

export enum PreScreeningStatus {
  Pending = "pending",
  Completed = "completed",
}

export enum ErrorLogLevel {
  Error = "error",
  Warn = "warn",
  Info = "info",
  Debug = "debug",
}
