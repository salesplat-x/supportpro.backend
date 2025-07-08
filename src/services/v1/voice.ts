// ...added for voice integration
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import axios from "axios";
import FormData from "form-data";
import env from "../../config/env";
import logger from "../../config/logger";
import {
  synthesizeTextToSpeech,
  synthesizeTextToSpeechStream,
} from "./elevenlabs";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: env.openai_secret });

async function transcribeAudio(filePath: string): Promise<string> {
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));
  form.append("model", "whisper-1");

  const response = await axios.post(
    "https://api.openai.com/v1/audio/transcriptions",
    form,
    {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${env.openai_secret}`,
      },
    }
  );
  fs.unlinkSync(filePath);
  return (response.data as any).text as string;
}

async function chatWithGPT(prompt: string): Promise<string> {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: "You are Grace, a helpful voice assistant." },
      { role: "user", content: prompt },
    ],
  });
  return completion.choices[0]?.message?.content ?? "";
}


// Full Voice Pipeline: STT -> Chat -> TTS buffer, with fallback (templates/fallback.mp3)
export async function handleVoiceInteraction(
  audioPath: string
): Promise<Buffer> {
  const fallbackPath = path.join(process.cwd(), "templates", "fallback.mp3");

  try {
    const userText = await transcribeAudio(audioPath);
    logger.log(`User said: ${userText}`);

    const aiResponse = await chatWithGPT(userText);
    logger.log(`AI replied: ${aiResponse}`);

    return await synthesizeTextToSpeech(aiResponse);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.log(`Voice pipeline error (${msg}), using fallback audio`);
    if (!fs.existsSync(fallbackPath)) {
      throw new Error(`Fallback file not found at ${fallbackPath}`);
    }
    return fs.readFileSync(fallbackPath);
  } finally {
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
  }
}


// Streaming Voice Pipeline: STT -> Chat -> TTS stream, with fallback (assynchronous)
export async function handleVoiceStreamInteraction(
  audioPath: string
): Promise<Readable> {
  const fallbackPath = path.join(process.cwd(), "templates", "fallback.mp3");

  try {
    const userText = await transcribeAudio(audioPath);
    logger.log(`User said: ${userText}`);

    const aiResponse = await chatWithGPT(userText);
    logger.log(`AI replied: ${aiResponse}`);

    return await synthesizeTextToSpeechStream(aiResponse);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.log(`Voice stream pipeline error (${msg}), using fallback audio`);
    if (!fs.existsSync(fallbackPath)) {
      throw new Error(`Fallback file not found at ${fallbackPath}`);
    }
    return fs.createReadStream(fallbackPath);
  } finally {
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
  }
}
