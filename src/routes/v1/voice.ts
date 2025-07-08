// New file for voice integration (dedicated for /routes/index.ts)
import { Router } from "express";
import {
  transcribeEndpoint,
  chatEndpoint,
  streamEndpoint, 
} from "../../controllers/v1/voice";

export default (router: Router) => {
  // (returns transcription only)
  router.post("/voice/transcribe", transcribeEndpoint);

  // Full voice chat which returns TTS audio
  router.post("/voice/chat", chatEndpoint);

  // Streaming voice chat which will pipe audio chunks as they arrive
  router.post("/voice/stream",  streamEndpoint);
};

