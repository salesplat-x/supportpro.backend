import { makeResponse } from "../../helpers/response";
import { Request } from "express";
import { v4 as uuidv4 } from "uuid";
import {
  extractText,
  overlapChunkText,
  preprocessText,
} from "../../helpers/func";
import { createEmbedding } from "../../services/v1/openai";
import { saveCvBatch } from "../../repository/v1/pg";

export const startUpload = async (req: Request) => {
  const batchId = uuidv4();
  // Optionally, store the batchId in the database with an initial state
  return makeResponse(true, "File uploaded", { batchId });
};

export interface ICvAndCoverLetter {
  batchId?: string;
  jobId: string;
  talentName: string;
  recruiterGuide?: string;
}

// Logic to upload to cloudinary
export const cvAndCoverLetter = async (req: Request) => {
  if (!req.files) {
    return makeResponse(false, "No file uploaded");
  }
  const { jobId, talentName, recruiterGuide }: ICvAndCoverLetter = req.body;
  const files: any = req.files;
  const cv = files?.["cv"][0];
  const coverLetter = files?.["coverLetter"][0];

  let batchId = uuidv4();

  if (!req.body.batchId) {
    batchId = uuidv4();
  }

  // extract text from CV and Cover letter
  let cvText: string | string[] = await extractText(cv.buffer, cv.mimetype);
  if (!cvText) {
    return makeResponse(false, "Unable to extract CV text!");
  }

  let coverLetterText: string | string[] = await extractText(
    coverLetter.buffer,
    coverLetter.mimetype
  );
  if (!coverLetterText) {
    return makeResponse(false, "Unable to extract cover letter text!");
  }

  let combinedText: string | string[] = preprocessText(
    `${cvText} ${coverLetterText}`
  );
  combinedText = overlapChunkText(cvText);

  // Create vector embedding for the chunks
  const combinedEmbedding = await createEmbedding(cvText);

  const res = await saveCvBatch(
    batchId,
    talentName,
    cvText,
    coverLetterText,
    combinedEmbedding
  );
  if (!res) {
    return makeResponse(false, "Unable to save cv embedding", {}, 500);
  }

  return makeResponse(true, "File uploaded", { batchId });
};
