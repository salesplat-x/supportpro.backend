// src/models/Organization.ts
import { Schema, model } from "mongoose";
import { IOrganization } from "../../typings/organization";

const organizationSchema = new Schema<IOrganization>(
  {
    email: {
      type: String,
      //   required: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    phone: {
      type: String,
    },
    address: {
      type: String,
    },
    industry: {
      type: String,
      //   required: true,
    },
    website: {
      type: String,
      trim: true,
    },
    facebook: {
      type: String,
      trim: true,
    },
    linkedin: {
      type: String,
      trim: true,
    },
    twitter: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true, // Automatically manages createdAt and updatedAt fields
  }
);

export const Organization = model<IOrganization>("organization", organizationSchema);
