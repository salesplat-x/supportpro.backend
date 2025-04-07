import { makeResponse } from "../../helpers/response";
import { Request } from "express";
import { v4 as uuidv4 } from "uuid";
import {
  convertSimilarityToPercentage,
  extractText,
  overlapChunkText,
  preprocessText,
  stringToBool,
} from "../../helpers/func";
import * as AI from "../../services/v1/openai";
import { getScoutCVEmbedding, saveCvBatch } from "../../repository/v1/pg";
import { findJobById } from "../../repository/v1/job";
import { IAIConfig } from "../../typings/AIconfig";
import {
  IScout,
  IScoutResponse,
  ICvAndCoverLetter,
  IScoutTalents,
} from "../../typings/scout";
import { IUser } from "../../typings/user";
import * as scoutRepository from "../../repository/v1/scout";
import mongoose from "mongoose";
import { findRoleById } from "../../repository/v1/role";
import { Roles } from "../../typings/customs";
import { userAggregate } from "../../repository/v1/user";
import { findScoutJobById } from "../../repository/v1/scoutJob";

// Function to get all records for a batchID
export const fetchScoutReports = async (user: IUser, batchId?: string) => {
  const scoutReports = await scoutRepository.findScoutsByMatch({ batchId });
  return makeResponse(true, "Scout reports fetched", { scoutReports });
};

// Function to get all records for a batchID
export const fetchScoutReport = async (user: IUser, id?: string) => {
  const resp = await scoutRepository.findScoutById(id!);
  return makeResponse(true, "Scout report fetched", { scoutReports: resp });
};

// Function find talents
export const scoutTalents = async (payload: Partial<IScoutTalents>) => {
  let users: IUser[] = [];
  //@TODO add location and remote filter

  if (
    !payload.scoutJobId ||
    !mongoose.Types.ObjectId.isValid(payload.scoutJobId!)
  ) {
    return makeResponse(false, "Invalid scout job id", {}, 400);
  }

  // Create aggregation pipeline
  let pipeline: mongoose.PipelineStage[] = [
    {
      $match: {
        userRole: Roles.Talent,
      },
    },
    // {
    //   $project: {
    //     password: 0, // Exclude password field from user object
    //   },
    // },
    {
      $lookup: {
        from: "profiles",
        localField: "profile",
        foreignField: "_id",
        as: "profile",
      },
    },
  ];
  pipeline.push({
    $match: {
      "profile.prescreeningScore": { $exists: true },
    },
  });

  if (payload.roleId) {
    if (!mongoose.Types.ObjectId.isValid(payload.roleId)) {
      return makeResponse(false, "Invalid role id", {}, 400);
    }
    const role = await findRoleById(payload.roleId);
    if (!role) {
      return makeResponse(false, "Role does not exist", {}, 404);
    }
    pipeline.push({
      $match: {
        "profile.role": new mongoose.Types.ObjectId(payload.roleId),
      },
    });
  }

  if (payload.experience) {
    pipeline.push({ $match: { "profile.experience": payload.experience } });
  }

  if (payload.country) {
    pipeline.push({ $match: { "profile.location.country": payload.country } });
  }

  if (payload.state) {
    pipeline.push({ $match: { "profile.location.state": payload.state } });
  }

  if (payload.city) {
    pipeline.push({ $match: { "profile.location.city": payload.city } });
  }

  if (payload.workMode !== undefined) {
    pipeline.push({
      $match: { "profile.remote": payload.workMode == "remote" },
    });
  }

  pipeline.push(
    { $unwind: "$profile" },
    {
      $lookup: {
        from: "roles",
        localField: "profile.role",
        foreignField: "_id",
        as: "profile.role",
      },
    },
    { $sort: { "profile.prescreeningScore": -1 } }
  );

  // Use an aggregation to get all users with the specified role
  users = await userAggregate(pipeline, payload);

  //Use vector similarity to compare the talents cv to the JD
  const talentIds = users.map((talent) => talent._id.toString());
  const res = await getScoutCVEmbedding(payload.scoutJobId!, talentIds);

  const resMap = new Map(
    res.map((item) => [
      item.profile_id,
      convertSimilarityToPercentage(item.similarity),
    ])
  );

  const talents = users.map((talent) => ({
    ...talent,
    similarity: resMap.get(talent._id.toString()) || null,
  }));

  return makeResponse(true, "User details fetched", { talents });
};

// Logic to scout using CV and Cover Letter (CL)
export const scoutCvAndCl = async (user: IUser, payload: ICvAndCoverLetter) => {
  const job = await findScoutJobById(payload.scoutJobId, "role");
  if (!job) {
    return makeResponse(false, "Job not found!", {}, 404);
  }

  if (job.postedBy.toString() !== user.id) {
    return makeResponse(
      false,
      "You are not authorized to perform this action",
      {},
      403
    );
  }

  const recruiterGuide = job.recruiterGuide;

  const files: any = payload.files;
  if (!files) {
    return makeResponse(false, "No file uploaded");
  }
  const cv: Express.Multer.File = files["cv"][0];
  const coverLetter: Express.Multer.File = files["coverLetter"][0];

  const cvName = cv.originalname.split(".")[0] || cv.originalname;
  const coverLetterName =
    coverLetter.originalname.split(".")[0] || cv.originalname;

  // extract text from CV and Cover letter
  let cvText = await extractText(cv.buffer, cv.mimetype);
  if (!cvText) {
    return makeResponse(false, "Unable to extract CV text!");
  }

  // Extract the text from the files
  let coverLetterText = await extractText(
    coverLetter.buffer,
    coverLetter.mimetype
  );
  if (!coverLetterText) {
    return makeResponse(false, "Unable to extract cover letter text!");
  }

  // Process text to remove unnecessary characters
  cvText = preprocessText(cvText);
  coverLetterText = preprocessText(coverLetterText);

  // Create overlapping chunks from the combined text
  // const chuckedText = overlapChunkText(cvText);

  const inputJson = JSON.stringify({
    cv: cvText,
    coverLetter: coverLetterText,
    jobDescription: job.jobBrief,
    recruiterGuide,
  });

  // Use LLM to grade scores
  const response = await AI.assessCVandCoverLetter(inputJson);
  if (!response || !response.message || !response.message.content) {
    return makeResponse(false, "Error with LLM", {}, 400);
  }

  const { cvScore, coverLetterScore }: IScoutResponse = JSON.parse(
    response.message.content
  );
  if (!cvScore || !coverLetterScore) {
    return makeResponse(false, "Error assessing CV and Cover Letter!");
  }

  const evaluationScore = Number(((cvScore + coverLetterScore) / 2).toFixed(2));

  const batchId = payload.batchId ?? uuidv4();

  const scout = await scoutRepository.createScout({
    batchId,
    cvName,
    coverLetterName,
    cvText,
    coverLetterText,
    cvScore,
    coverLetterScore,
    evaluationScore,
    recruiter: user.id,
    scoutJob: payload.scoutJobId,
  });

  if (!scout) {
    return makeResponse(false, "Unable to save scout report!");
  }

  return makeResponse(true, "CV and cover letter assessed ", {
    evaluationScore,
    scout,
  });
};

// Logic to scout using CV
export const scoutCv = async (user: IUser, payload: ICvAndCoverLetter) => {
  const job = await findScoutJobById(payload.scoutJobId, "role");
  if (!job) {
    return makeResponse(false, "Job not found!", {}, 404);
  }
  if (job.postedBy.toString() !== user.id) {
    return makeResponse(
      false,
      "You are not authorized to perform this action",
      {},
      403
    );
  }

  const recruiterGuide = job.recruiterGuide;

  const file: Express.Multer.File = payload.file;
  if (!file) {
    return makeResponse(false, "No file uploaded");
  }
  const cvName = file.originalname.split(".")[0] || file.originalname;

  // extract text from CV
  let cvText = await extractText(file.buffer, file.mimetype);
  if (!cvText) {
    return makeResponse(false, "Unable to extract CV text!");
  }

  // Process text to remove unnecessary characters
  cvText = preprocessText(cvText);

  // Create overlapping chunks from the combined text
  // const chuckedText = overlapChunkText(cvText);

  const inputJson = JSON.stringify({
    cv: cvText,
    recruiterGuide,
  });

  // Use LLM to grade scores
  const response = await AI.assessCV(inputJson);
  if (!response || !response.message || !response.message.content) {
    return makeResponse(false, "Error with LLM", {}, 400);
  }

  const { cvScore }: IScoutResponse = JSON.parse(response.message.content);
  if (!cvScore) {
    return makeResponse(false, "Error assessing CV!");
  }

  const evaluationScore = cvScore;

  const batchId = payload.batchId ?? uuidv4();

  const scout = await scoutRepository.createScout({
    batchId,
    cvName,
    cvText,
    cvScore,
    evaluationScore,
    scoutJob: payload.scoutJobId,
    recruiter: user.id,
  });

  if (!scout) {
    return makeResponse(false, "Unable to save scout report!");
  }

  return makeResponse(true, "CV assessed ", {
    evaluationScore,
    scout,
  });
};

// Logic to upload to cloudinary and embed
// export const embedCvAndCl = async (user: IUser, payload: ICvAndCoverLetter) => {
//   const job = await findJobById(payload.jobId, "aiConfig");
//   if (!job) {
//     return makeResponse(false, "Job not found!", {}, 404);
//   }
//   if (!job.aiConfig) {
//     return makeResponse(false, "Job AI configuration not set!");
//   }
//   if (job.postedBy.toString() !== user.id) {
//     return makeResponse(
//       false,
//       "You are not authorized to perform this action",
//       {},
//       403
//     );
//   }
//   if (!req.files) {
//     return makeResponse(false, "No file uploaded");
//   }
//   const { jobId }: ICvAndCoverLetter = req.body;
//   const files: any = req.files;
//   const cv = files?.["cv"][0];
//   const coverLetter = files?.["coverLetter"][0];

//   let batchId = uuidv4();

//   if (!req.body.batchId) {
//     batchId = uuidv4();
//   }

//   // extract text from CV and Cover letter
//   let cvText: string | string[] = await extractText(cv.buffer, cv.mimetype);
//   if (!cvText) {
//     return makeResponse(false, "Unable to extract CV text!");
//   }

//   let coverLetterText: string | string[] = await extractText(
//     coverLetter.buffer,
//     coverLetter.mimetype
//   );
//   if (!coverLetterText) {
//     return makeResponse(false, "Unable to extract cover letter text!");
//   }

//   let combinedText: string | string[] = preprocessText(
//     `${cvText} ${coverLetterText}`
//   );
//   combinedText = overlapChunkText(cvText);

//   // Create vector embedding for the chunks
//   const combinedEmbedding = await AI.createEmbedding(cvText);

//   const res = await saveCvBatch(
//     batchId,
//     "talentName",
//     cvText,
//     coverLetterText,
//     combinedEmbedding
//   );
//   if (!res) {
//     return makeResponse(false, "Unable to save cv embedding", {}, 500);
//   }

//   return makeResponse(true, "File uploaded", { batchId });
// };
