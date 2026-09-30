import { randomUUID } from "crypto";
import path from "path";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import env from "../../config/env.js";
import logger from "../logger.js";

export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

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

/**
 * Uploads without a public-read ACL, so the object can only be reached with our
 * credentials. Used for scouted CVs: those belong to people who never signed up
 * here, so their CV must not be readable by anyone who guesses the URL. Serve them
 * through an authenticated route via `getFromSpaces`.
 */
export const uploadPrivateToSpaces = async (
  buffer: Buffer,
  key: string,
  contentType: string
): Promise<void> => {
  assertSpacesConfigured();
  await client.send(
    new PutObjectCommand({
      Bucket: env.doSpacesBucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ACL: "private",
    })
  );
};

export const getFromSpaces = async (key: string): Promise<Buffer> => {
  assertSpacesConfigured();
  const result = await client.send(
    new GetObjectCommand({ Bucket: env.doSpacesBucket, Key: key })
  );
  if (!result.Body) {
    throw new Error(`Spaces object ${key} has no body`);
  }
  return Buffer.from(await result.Body.transformToByteArray());
};

export const deleteFromSpaces = async (key: string): Promise<void> => {
  assertSpacesConfigured();
  await client.send(new DeleteObjectCommand({ Bucket: env.doSpacesBucket, Key: key }));
};

export const spacesKeyFor = (
  prefix: "avatars" | "cvs" | "logos" | "scout-cvs",
  ownerId: string,
  originalname: string
): string => {
  const extension = path.extname(originalname) || ".bin";
  return `${prefix}/${ownerId}/${randomUUID()}${extension}`;
};

/** Best-effort cleanup of a replaced file — never fails the request that already succeeded. */
export const deleteSpacesObjectQuietly = async (
  key: string | null,
  context: string
): Promise<void> => {
  if (!key) return;
  await deleteFromSpaces(key).catch((err: unknown) => {
    logger.error(`Failed to delete old Spaces object for ${context}: ${key}`, {
      message: err instanceof Error ? err.message : String(err),
    });
  });
};
