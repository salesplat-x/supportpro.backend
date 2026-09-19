import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import env from "../../config/env.js";

const client = new S3Client({
  endpoint: env.doSpacesEndpoint,
  region: env.doSpacesRegion,
  credentials: {
    accessKeyId: env.doSpacesKey ?? "",
    secretAccessKey: env.doSpacesSecret ?? "",
  },
});

/** Fails loudly on a misconfigured deploy instead of silently saving a broken `.../undefined/...` URL. */
export const assertSpacesConfigured = (): void => {
  if (
    !env.doSpacesEndpoint ||
    !env.doSpacesRegion ||
    !env.doSpacesBucket ||
    !env.doSpacesKey ||
    !env.doSpacesSecret
  ) {
    throw new Error("DigitalOcean Spaces is not configured — missing DO_SPACES_* env vars");
  }
};

const publicUrlFor = (key: string): string => {
  const host = new URL(env.doSpacesEndpoint ?? "").host;
  return `https://${env.doSpacesBucket}.${host}/${key}`;
};

export const uploadToSpaces = async (
  buffer: Buffer,
  key: string,
  contentType: string
): Promise<string> => {
  assertSpacesConfigured();
  await client.send(
    new PutObjectCommand({
      Bucket: env.doSpacesBucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ACL: "public-read",
    })
  );
  return publicUrlFor(key);
};

export const deleteFromSpaces = async (key: string): Promise<void> => {
  assertSpacesConfigured();
  await client.send(new DeleteObjectCommand({ Bucket: env.doSpacesBucket, Key: key }));
};
