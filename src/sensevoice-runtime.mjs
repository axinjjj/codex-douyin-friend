import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

const TAG_PATTERN = /<\|([^|>]+)\|>/gu;
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const SRT_TIMING_PATTERN = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/u;
const LANGUAGE_TAGS = new Set(["zh", "yue", "en", "ja", "ko", "nospeech"]);
const EMOTION_TAGS = new Set([
  "ANGRY",
  "DISGUSTED",
  "FEARFUL",
  "HAPPY",
  "NEUTRAL",
  "SAD",
  "SURPRISED",
  "EMO_UNKNOWN",
]);
const EVENT_TAGS = new Set([
  "APPLAUSE",
  "BGM",
  "BREATH",
  "COUGH",
  "CRYING",
  "LAUGHTER",
  "SNEEZE",
  "SPEECH",
  "EVENT_UNKNOWN",
]);

function unique(values) {
  return [...new Set(values)];
}

function parseTagsAndTranscript(value) {
  const rawTags = [...value.matchAll(TAG_PATTERN)].map((match) => match[1]);
  const language = rawTags.find((tag) => LANGUAGE_TAGS.has(tag.toLowerCase()))?.toLowerCase() ?? null;
  const emotions = unique(rawTags
    .map((tag) => tag.toUpperCase())
    .filter((tag) => EMOTION_TAGS.has(tag)));
  const events = unique(rawTags
    .map((tag) => tag.toUpperCase())
    .filter((tag) => EVENT_TAGS.has(tag)));
  const transcript = value
    .replace(TAG_PATTERN, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return { transcript, language, emotions, events };
}

function srtTimeToSeconds(groups, offset) {
  return Number(groups[offset]) * 3600
    + Number(groups[offset + 1]) * 60
    + Number(groups[offset + 2])
    + Number(groups[offset + 3]) / 1_000;
}

function parseSrtSegments(cleaned) {
  const blocks = cleaned.split(/\r?\n\s*\r?\n/u).filter(Boolean);
  const segments = [];
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    const lines = block.split(/\r?\n/u);
    if (lines.length < 3 || Number(lines[0].trim()) !== blockIndex + 1) return [];
    const timing = SRT_TIMING_PATTERN.exec(lines[1].trim());
    if (!timing) return [];
    if (Number(timing[2]) >= 60 || Number(timing[3]) >= 60
      || Number(timing[6]) >= 60 || Number(timing[7]) >= 60) return [];
    const startSeconds = srtTimeToSeconds(timing, 1);
    const endSeconds = srtTimeToSeconds(timing, 5);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
      return [];
    }
    if (segments.length > 0 && startSeconds < segments.at(-1).endSeconds) return [];
    segments.push({
      startSeconds,
      endSeconds,
      ...parseTagsAndTranscript(lines.slice(2).join("\n")),
    });
  }
  return segments;
}

export function parseSenseVoiceCapabilities(helpOutput) {
  return {
    srt: /(?:^|[\s\[])--srt(?=$|[\s\]])/u.test(String(helpOutput ?? "")),
    vadMaxSegment: /(?:^|[\s\[])--vad-maxseg(?=$|[\s\]])/u.test(String(helpOutput ?? "")),
  };
}

export function resolveSenseVoicePaths(projectRoot, environment = process.env) {
  const toolRoot = path.join(projectRoot, ".runtime", "tools", "sensevoice");
  return {
    executablePath: path.resolve(
      environment.CODEX_DOUYIN_SENSEVOICE_EXECUTABLE
        || path.join(toolRoot, "runtime", "llama-funasr-sensevoice.exe"),
    ),
    modelPath: path.resolve(
      environment.CODEX_DOUYIN_SENSEVOICE_MODEL
        || path.join(toolRoot, "downloads", "sensevoice-small-q8.gguf"),
    ),
    vadModelPath: path.resolve(
      environment.CODEX_DOUYIN_SENSEVOICE_VAD_MODEL
        || path.join(toolRoot, "downloads", "fsmn-vad.gguf"),
    ),
  };
}

export async function verifySenseVoiceRuntime({ projectRoot, environment = process.env }) {
  const paths = resolveSenseVoicePaths(projectRoot, environment);
  for (const [name, filePath] of Object.entries(paths)) {
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      throw new Error(`SenseVoice ${name} is missing. Run npm run setup:sensevoice.`);
    }
    if (!fileStat.isFile() || fileStat.size === 0) {
      throw new Error(`SenseVoice ${name} is not a usable file.`);
    }
  }
  return paths;
}

export async function resolveOptionalSenseVoiceRuntime({
  projectRoot,
  environment = process.env,
  verifyFn = verifySenseVoiceRuntime,
}) {
  try {
    const runtime = await verifyFn({ projectRoot, environment });
    return { enabled: true, reason: null, runtime };
  } catch {
    return { enabled: false, reason: "runtime-unavailable", runtime: null };
  }
}

export function parseSenseVoiceOutput(stdout) {
  const cleaned = String(stdout ?? "").replace(ANSI_PATTERN, "").trim();
  const segments = parseSrtSegments(cleaned);
  if (segments.length === 0) {
    const invalidSrt = /(?:^|\r?\n)\s*\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->/u.test(cleaned);
    return {
      ...(invalidSrt
        ? { transcript: "", language: null, emotions: [], events: [] }
        : parseTagsAndTranscript(cleaned)),
      segments: [],
      timestampProtocol: invalidSrt ? "invalid-srt" : "unavailable",
    };
  }
  return {
    transcript: segments.map((segment) => segment.transcript).filter(Boolean).join("\n"),
    language: segments.find((segment) => segment.language)?.language ?? null,
    emotions: unique(segments.flatMap((segment) => segment.emotions)),
    events: unique(segments.flatMap((segment) => segment.events)),
    segments,
    timestampProtocol: "srt",
  };
}

export function assessSenseVoiceOutput(stdout, { srtRequested = false } = {}) {
  const parsed = parseSenseVoiceOutput(stdout);
  const outputValid = srtRequested
    ? parsed.timestampProtocol === "srt"
    : parsed.timestampProtocol !== "invalid-srt";
  if (!outputValid) {
    return {
      processed: false,
      transcript: "",
      language: null,
      emotions: [],
      events: [],
      segments: [],
      timestampProtocol: parsed.timestampProtocol,
      reason: "invalid-srt-output",
      timingSource: "unavailable",
    };
  }
  return {
    processed: true,
    ...parsed,
    timingSource: srtRequested && parsed.timestampProtocol === "srt"
      ? "fsmn-vad-srt"
      : "unavailable",
  };
}

async function runHiddenProcess(executablePath, argumentsList, {
  cwd,
  timeoutMs = 120_000,
  maxOutputBytes = 2 * 1024 * 1024,
  acceptedExitCodes = [0],
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, argumentsList, {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let outputExceeded = false;
    let spawnError = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const appendOutput = (current, value) => {
      const next = current + value;
      if (Buffer.byteLength(next, "utf8") > maxOutputBytes) {
        outputExceeded = true;
        child.kill();
        return current;
      }
      return next;
    };
    child.stdout.on("data", (value) => {
      stdout = appendOutput(stdout, value);
    });
    child.stderr.on("data", (value) => {
      stderr = appendOutput(stderr, value);
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (spawnError) {
        reject(new Error(`SenseVoice could not start: ${spawnError.code || "spawn-error"}.`));
      } else if (timedOut) {
        reject(new Error("SenseVoice transcription timed out."));
      } else if (outputExceeded) {
        reject(new Error("SenseVoice produced more diagnostic output than allowed."));
      } else if (!acceptedExitCodes.includes(code)) {
        reject(new Error(`SenseVoice exited with code ${code}.`));
      } else {
        resolve({
          stdout,
          stderr,
          stderrLength: Buffer.byteLength(stderr, "utf8"),
        });
      }
    });
  });
}

export async function transcribeSenseVoiceAudio({
  audioPath,
  projectRoot,
  environment = process.env,
  timeoutMs = 120_000,
}) {
  const boundedTimeoutMs = Math.max(
    1_000,
    Math.min(120_000, Number.isFinite(timeoutMs) ? Math.trunc(timeoutMs) : 120_000),
  );
  const audioStat = await stat(audioPath);
  if (!audioStat.isFile() || audioStat.size < 44) {
    throw new Error("The extracted audio is not a usable WAV file.");
  }
  const runtime = await verifySenseVoiceRuntime({ projectRoot, environment });
  const runtimeDirectory = path.dirname(runtime.executablePath);
  const asRuntimeRelativePath = (filePath) => {
    const relativePath = path.relative(runtimeDirectory, path.resolve(filePath));
    return relativePath && !path.isAbsolute(relativePath) ? relativePath : path.resolve(filePath);
  };
  const capabilitiesResult = await runHiddenProcess(runtime.executablePath, ["--help"], {
    cwd: runtimeDirectory,
    timeoutMs: 5_000,
    maxOutputBytes: 64 * 1024,
    acceptedExitCodes: [0, 1],
  });
  const capabilities = parseSenseVoiceCapabilities(
    `${capabilitiesResult.stdout}\n${capabilitiesResult.stderr}`,
  );
  const argumentsList = [
    "-m",
    asRuntimeRelativePath(runtime.modelPath),
    "--vad",
    asRuntimeRelativePath(runtime.vadModelPath),
    "-a",
    asRuntimeRelativePath(audioPath),
    "--backend",
    "cpu",
    "--keep-tags",
  ];
  if (capabilities.vadMaxSegment) argumentsList.push("--vad-maxseg", "30000");
  if (capabilities.srt) argumentsList.push("--srt");
  const result = await runHiddenProcess(runtime.executablePath, argumentsList, {
    cwd: runtimeDirectory,
    timeoutMs: boundedTimeoutMs,
  });
  const assessed = assessSenseVoiceOutput(result.stdout, { srtRequested: capabilities.srt });
  return {
    ...assessed,
    runtimeSupportsSrt: capabilities.srt,
    stderrLength: result.stderrLength,
  };
}
