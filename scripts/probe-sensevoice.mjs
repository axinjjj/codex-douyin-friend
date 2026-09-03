import path from "node:path";
import { fileURLToPath } from "node:url";
import { transcribeSenseVoiceAudio } from "../src/sensevoice-runtime.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const audioPath = path.join(
  projectRoot,
  ".runtime",
  "tools",
  "sensevoice",
  "tests",
  "sample.wav",
);
const result = await transcribeSenseVoiceAudio({ audioPath, projectRoot });
console.log(JSON.stringify({
  ok: true,
  transcriptLength: result.transcript.length,
  language: result.language,
  emotions: result.emotions,
  events: result.events,
}));
