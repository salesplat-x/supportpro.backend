import { execFile } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

/** The bytes are not audio ffprobe can read, or hold no measurable sound. The caller's problem. */
export class AudioUnreadableError extends Error {
  constructor(message = "ffprobe could not read the audio") {
    super(message);
    this.name = "AudioUnreadableError";
  }
}

const PROBE_TIMEOUT_MS = 10_000;
// A packet scan prints one short line per packet: about 3,000 lines a minute for Opus.
const PROBE_MAX_BUFFER = 32 * 1024 * 1024;

const ffprobe = (args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      args,
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BUFFER, encoding: "utf8" },
      (err, stdout) => {
        if (err) {
          // A missing or killed binary is our failure; anything else means it could not read the file.
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || err.killed) {
            reject(err);
            return;
          }
          reject(new AudioUnreadableError(err.message));
          return;
        }
        resolve(String(stdout));
      }
    );
  });

const positiveNumber = (value: string | undefined): number | undefined => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** End time of the last audio packet, for containers that don't record a duration. */
const lengthFromPackets = (output: string): number | undefined => {
  let end = 0;
  for (const line of output.split("\n")) {
    const fields = Object.fromEntries(
      line.split("|").map((pair) => pair.split("=") as [string, string | undefined])
    );
    const pts = Number(fields["pts_time"]);
    if (!Number.isFinite(pts)) continue;
    const duration = Number(fields["duration_time"]);
    end = Math.max(end, pts + (Number.isFinite(duration) ? duration : 0));
  }
  return end > 0 ? end : undefined;
};

/**
 * Length of a recording in seconds, read with ffprobe before any paid call.
 *
 * Works from a temp file rather than stdin: Safari's m4a puts its index at the end of the
 * file, which ffprobe can only reach by seeking. The container header is tried first; browser
 * recordings (MediaRecorder webm) carry no duration there, so their packets are counted
 * instead. Nothing is decoded, so even a 10 MB upload is measured in well under a second.
 */
export const probeAudioDurationSeconds = async (
  audio: Buffer,
  extension: string
): Promise<number> => {
  const safeExtension = extension.replace(/[^a-z0-9]/gi, "") || "bin";
  const file = path.join(os.tmpdir(), `voice-probe-${randomUUID()}.${safeExtension}`);
  await fs.promises.writeFile(file, audio, { mode: 0o600 });
  try {
    const header = await ffprobe([
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ]);
    const fromHeader = positiveNumber(header.trim().split("\n")[0]);
    if (fromHeader !== undefined) return fromHeader;

    const packets = await ffprobe([
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "packet=pts_time,duration_time",
      "-of",
      "compact=p=0",
      file,
    ]);
    const fromPackets = lengthFromPackets(packets);
    if (fromPackets === undefined) {
      throw new AudioUnreadableError("ffprobe found no audio packets");
    }
    return fromPackets;
  } finally {
    await fs.promises.rm(file, { force: true });
  }
};
