/**
 * Reads recording length with the real ffprobe binary, on small fixture recordings.
 * Skipped (with a note) where ffprobe isn't installed; tests/voice.test.ts covers the
 * same rules with ffprobe stood in for.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { AudioUnreadableError, probeAudioDurationSeconds } from "../src/utils/audioDuration.js";

const fixture = (name: string): Buffer => fs.readFileSync(path.join(__dirname, "fixtures", name));

const hasFfprobe = spawnSync("ffprobe", ["-version"]).status === 0;
if (!hasFfprobe) {
  console.warn("ffprobe not installed: skipping the real-binary audio length tests");
}
const describeWithFfprobe = hasFfprobe ? describe : describe.skip;

describeWithFfprobe("probeAudioDurationSeconds (real ffprobe)", () => {
  it("reads the length of a browser-style webm that has no duration in its header", async () => {
    const seconds = await probeAudioDurationSeconds(fixture("voice-3s-no-duration.webm"), "webm");
    expect(seconds).toBeGreaterThan(2.9);
    expect(seconds).toBeLessThan(3.2);
  });

  it("reads the length of a long, tiny ogg (130 s in under 50 KB)", async () => {
    const seconds = await probeAudioDurationSeconds(fixture("voice-130s.ogg"), "ogg");
    expect(seconds).toBeGreaterThan(129);
    expect(seconds).toBeLessThan(131);
  });

  it("rejects bytes that are not audio", async () => {
    await expect(
      probeAudioDurationSeconds(Buffer.from("definitely not audio"), "webm")
    ).rejects.toBeInstanceOf(AudioUnreadableError);
  });

  it("leaves no temp files behind", async () => {
    const tmp = fs.realpathSync(os.tmpdir());
    const before = fs.readdirSync(tmp).filter((f) => f.startsWith("voice-probe-")).length;
    await probeAudioDurationSeconds(fixture("voice-3s-no-duration.webm"), "webm");
    const after = fs.readdirSync(tmp).filter((f) => f.startsWith("voice-probe-")).length;
    expect(after).toBe(before);
  });
});
