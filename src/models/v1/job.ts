import { Schema, model } from "mongoose";
import { ExperienceLevel } from "../../typings/customs";
import { IJob, JobStatus, WorkMode } from "../../typings/job";

const jobSchema = new Schema<IJob>(
  {
    role: {
      type: Schema.Types.ObjectId,
      ref: "role",
      required: true,
    },
    postedBy: {
      type: Schema.Types.ObjectId,
      ref: "user",
      required: true,
    },
    aiConfig: {
      type: Schema.Types.ObjectId,
      ref: "ai_config",
    },
    jobBrief: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(JobStatus),
      default: JobStatus.Active,
    },
    maxSalary: {
      type: Number,
      required: true,
    },
    minSalary: {
      type: Number,
      required: true,
    },
    experienceLevel: {
      enum: ExperienceLevel,
      type: String,
      required: true,
    },
    location: {
      city: {
        type: String,
        required: false,
        lowercase: true,
      },
      state: {
        type: String,
        required: true,
        lowercase: true,
      },
      country: {
        type: String,
        required: true,
        lowercase: true,
      },
    },
    // address: {
    //   type: String,
    //   required: true,
    // },
    workMode: {
      enum: WorkMode,
      type: String,
      required: true,
    },
    requirements: {
      type: String,
      required: false,
      lowercase: true,
    },
    skills: {
      type: [String],
      required: false,
      lowercase: true,
    },
    goals: {
      type: [String],
      required: false,
      lowercase: true,
    },
    noOfApplicants: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

export default model<IJob>("job", jobSchema);
