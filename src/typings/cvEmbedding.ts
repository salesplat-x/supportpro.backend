import { Document, Types } from "mongoose";

export interface ICvEmbedding extends Document {
  _id: Types.ObjectId;
  profileId: Types.ObjectId;
  cvPublicId: string;
  generatedAt: Date;
}
