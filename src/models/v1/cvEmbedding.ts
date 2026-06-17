import { Schema, model } from "mongoose";
import { ICvEmbedding } from "../../typings/cvEmbedding";

const cvEmbeddingSchema = new Schema<ICvEmbedding>(
  {
    profileId: {
      type: Schema.Types.ObjectId,
      ref: "profile",
      required: true,
      unique: true,
    },
    cvPublicId: {
      type: String,
      required: true,
    },
    generatedAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: false }
);

export const CvEmbedding = model<ICvEmbedding>("cvembedding", cvEmbeddingSchema);
