// Newly added file for Voice integration
import dotenv from "dotenv";

dotenv.config();

// ElevenLabs configuration loader.
export interface ElevenLabsConfig {
  apiKey: string;
  voiceId?: string;
  modelId?: string;
}

const apiKey = process.env.ELEVENLABS_API_KEY;
const voiceId = process.env.ELEVENLABS_VOICE_ID;
const modelId = process.env.ELEVENLABS_MODEL_ID;

if (!apiKey) {
  throw new Error('Missing required environment variable: ELEVENLABS_API_KEY');
}

const elevenLabsConfig: ElevenLabsConfig = {
  apiKey,
  voiceId,
  modelId,
};

export default elevenLabsConfig;
