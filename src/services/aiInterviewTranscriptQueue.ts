import logger from "../utils/logger.js";
import { transcribeAnswerRecording } from "./aiInterviewTranscript.js";

const inFlightTranscripts = new Set<Promise<void>>();

/**
 * Starts an answer's transcript as soon as it is uploaded, so a follow-up can be asked while the
 * candidate is still on the page. The sweep picks up anything this misses.
 */
export const queueTranscript = (questionId: string): void => {
  const task = (async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await transcribeAnswerRecording(questionId);
  })().catch((error) => {
    logger.warn(`Interview transcript for question ${questionId} failed: ${String(error)}`);
  });
  inFlightTranscripts.add(task);
  void task.finally(() => inFlightTranscripts.delete(task));
};

export const drainInFlightTranscripts = async (): Promise<void> => {
  for (let attempt = 0; attempt < 100 && inFlightTranscripts.size > 0; attempt++) {
    await Promise.allSettled([...inFlightTranscripts]);
  }
};
