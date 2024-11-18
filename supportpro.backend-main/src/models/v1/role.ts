import { Schema, model } from "mongoose";
import { IRole } from "../../typings/role";

const roleSchema = new Schema<IRole>({
  name: {
    type: String,
    required: true,
    lowercase: true,
  },
  description: {
    type: String,
    required: true,
  },
});

export default model<IRole>("role", roleSchema);
