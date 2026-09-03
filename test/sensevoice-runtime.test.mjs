import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  assessSenseVoiceOutput,
  parseSenseVoiceCapabilities,
  parseSenseVoiceOutput,
  resolveOptionalSenseVoiceRuntime,
  resolveSenseVoicePaths,
} from "../src/sensevoice-runtime.mjs";

test("degrades cleanly when the optional SenseVoice runtime is unavailable", async () => {
  const unavailable = await resolveOptionalSenseVoiceRuntime({
    projectRoot: "C:/fixture",
    verifyFn: async () => { throw new Error("private runtime path"); },
  });
  assert.deepEqual(unavailable, {
    enabled: false,
    reason: "runtime-unavailable",
    runtime: null,
  });
  const available = await resolveOptionalSenseVoiceRuntime({
    projectRoot: "C:/fixture",
    verifyFn: async () => ({ executablePath: "fixture" }),
  });
  assert.equal(available.enabled, true);
});

test("parses SenseVoice language, emotion, event, and transcript tags", () => {
  const parsed = parseSenseVoiceOutput([
    "<|zh|><|HAPPY|><|Speech|><|withitn|>今天也太好笑了",
    "<|zh|><|NEUTRAL|><|BGM|><|withitn|>第二句",
  ].join("\n"));
  assert.deepEqual(parsed, {
    transcript: "今天也太好笑了\n第二句",
    language: "zh",
    emotions: ["HAPPY", "NEUTRAL"],
    events: ["SPEECH", "BGM"],
    segments: [],
    timestampProtocol: "unavailable",
  });
});

test("parses strict multi-segment VAD SRT without leaking scaffolding into transcript", () => {
  const parsed = parseSenseVoiceOutput([
    "1",
    "00:00:00,770 --> 00:00:05,980",
    "<|zh|><|NEUTRAL|><|Speech|>第一句",
    "",
    "2",
    "00:00:06,200 --> 00:00:09,015",
    "<|zh|><|HAPPY|><|Laughter|>第二句",
  ].join("\r\n"));
  assert.equal(parsed.transcript, "第一句\n第二句");
  assert.equal(parsed.timestampProtocol, "srt");
  assert.deepEqual(parsed.segments.map((segment) => ({
    startSeconds: segment.startSeconds,
    endSeconds: segment.endSeconds,
    emotions: segment.emotions,
    events: segment.events,
  })), [
    { startSeconds: 0.77, endSeconds: 5.98, emotions: ["NEUTRAL"], events: ["SPEECH"] },
    { startSeconds: 6.2, endSeconds: 9.015, emotions: ["HAPPY"], events: ["LAUGHTER"] },
  ]);
  assert.doesNotMatch(parsed.transcript, /-->|00:00/u);
});

test("rejects malformed or overlapping SRT timing instead of inventing anchors", () => {
  const parsed = parseSenseVoiceOutput([
    "1",
    "00:00:00,500 --> 00:00:03,000",
    "<|zh|><|NEUTRAL|><|Speech|>正文",
    "",
    "2",
    "00:00:02,900 --> 00:00:04,000",
    "<|zh|><|HAPPY|><|Speech|>重叠",
  ].join("\n"));
  assert.equal(parsed.timestampProtocol, "invalid-srt");
  assert.deepEqual(parsed.segments, []);
  assert.equal(parsed.transcript, "");

  const missingIndex = parseSenseVoiceOutput([
    "00:00:00,500 --> 00:00:03,000",
    "<|zh|><|NEUTRAL|><|Speech|>正文",
  ].join("\n"));
  assert.equal(missingIndex.timestampProtocol, "invalid-srt");
  assert.equal(missingIndex.transcript, "");
});

test("detects SRT support without assuming it for alternate runtimes", () => {
  assert.deepEqual(
    parseSenseVoiceCapabilities("usage: tool [--vad-maxseg ms] [--srt]"),
    { srt: true, vadMaxSegment: true },
  );
  assert.deepEqual(
    parseSenseVoiceCapabilities("usage: old-tool [--vad model]"),
    { srt: false, vadMaxSegment: false },
  );
});

test("discards non-SRT output whenever the runtime advertised SRT support", () => {
  for (const output of [
    "<|zh|><|NEUTRAL|><|Speech|>普通文本",
    "1\nnot-a-timestamp\n<|zh|><|NEUTRAL|><|Speech|>畸形文本",
    "",
  ]) {
    assert.deepEqual(assessSenseVoiceOutput(output, { srtRequested: true }), {
      processed: false,
      transcript: "",
      language: null,
      emotions: [],
      events: [],
      segments: [],
      timestampProtocol: "unavailable",
      reason: "invalid-srt-output",
      timingSource: "unavailable",
    });
  }
});

test("accepts strict SRT when requested and keeps plain output for older runtimes", () => {
  const srt = "1\n00:00:00,500 --> 00:00:01,500\n<|zh|><|NEUTRAL|><|Speech|>正文";
  const strict = assessSenseVoiceOutput(srt, { srtRequested: true });
  assert.equal(strict.processed, true);
  assert.equal(strict.timingSource, "fsmn-vad-srt");
  assert.equal(strict.segments.length, 1);

  const legacy = assessSenseVoiceOutput("<|zh|><|NEUTRAL|><|Speech|>正文");
  assert.equal(legacy.processed, true);
  assert.equal(legacy.timingSource, "unavailable");
  assert.equal(legacy.transcript, "正文");
});

test("keeps stderr diagnostics out of parsed transcription content", () => {
  const parsed = parseSenseVoiceOutput("<|zh|><|NEUTRAL|><|Speech|>正文");
  assert.equal(parsed.transcript, "正文");
  assert.deepEqual(parsed.events, ["SPEECH"]);
});

test("resolves private runtime assets under the ignored project runtime directory", () => {
  const projectRoot = path.resolve("C:/project");
  const paths = resolveSenseVoicePaths(projectRoot, {});
  assert.equal(
    paths.executablePath,
    path.join(projectRoot, ".runtime", "tools", "sensevoice", "runtime", "llama-funasr-sensevoice.exe"),
  );
  assert.equal(
    paths.modelPath,
    path.join(projectRoot, ".runtime", "tools", "sensevoice", "downloads", "sensevoice-small-q8.gguf"),
  );
});
