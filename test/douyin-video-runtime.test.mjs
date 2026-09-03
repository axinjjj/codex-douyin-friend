import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertVideoAnalysisJobPath,
  buildCaptureFrameExpression,
  buildExtractAudioExpression,
  buildScanFrameSignaturesExpression,
  cleanupStaleVideoAnalysisJobs,
  downloadDouyinVideo,
  isTrustedDouyinMediaUrl,
  resolveVideoAnalysisRoot,
} from "../src/douyin-video-runtime.mjs";

test("allows only known HTTPS Douyin media hosts", () => {
  assert.equal(isTrustedDouyinMediaUrl("https://v5-dy.zjcdn.com/video.mp4"), true);
  assert.equal(isTrustedDouyinMediaUrl("http://v5-dy.zjcdn.com/video.mp4"), false);
  assert.equal(isTrustedDouyinMediaUrl("https://zjcdn.com.attacker.invalid/video.mp4"), false);
  assert.equal(isTrustedDouyinMediaUrl("file:///C:/private/video.mp4"), false);
});

test("cleans only stale UUID video jobs and leaves recent or unrelated directories", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-douyin-video-cleanup-"));
  const analysisRoot = resolveVideoAnalysisRoot(projectRoot);
  const oldJob = path.join(analysisRoot, "123e4567-e89b-42d3-a456-426614174000");
  const recentJob = path.join(analysisRoot, "123e4567-e89b-42d3-a456-426614174001");
  const unrelatedDirectory = path.join(analysisRoot, "keep-me");
  const now = Date.now();
  try {
    for (const directory of [oldJob, recentJob, unrelatedDirectory]) {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "artifact.bin"), "fixture");
    }
    await utimes(oldJob, new Date(now - 3 * 60 * 60 * 1_000), new Date(now - 3 * 60 * 60 * 1_000));
    await utimes(recentJob, new Date(now - 10 * 60 * 1_000), new Date(now - 10 * 60 * 1_000));

    const removedCount = await cleanupStaleVideoAnalysisJobs(projectRoot, { now });
    assert.equal(removedCount, 1);
    await assert.rejects(access(oldJob));
    await access(recentJob);
    await access(unrelatedDirectory);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("builds a bounded local-only Web Audio extraction expression", () => {
  const expression = buildExtractAudioExpression({
    uploadPath: "/audio-token.wav",
    maxAudioBytes: 1024 * 1024,
    maxDurationSeconds: 30,
  });
  assert.match(expression, /OfflineAudioContext/u);
  assert.match(expression, /targetRate = 16000/u);
  assert.match(expression, /audio-duration-limit/u);
  assert.match(expression, /\/audio-token\.wav/u);
  assert.match(expression, /1048576/u);
  assert.doesNotMatch(expression, /https?:\/\//u);

  const callerCannotRaiseLimits = buildExtractAudioExpression({
    uploadPath: "/audio-token.wav",
    maxAudioBytes: 500 * 1024 * 1024,
    maxDurationSeconds: 10_000,
  });
  assert.match(callerCannotRaiseLimits, /41943040/u);
  assert.match(callerCannotRaiseLimits, /video\.duration > 900 \+ 0\.25/u);
  assert.doesNotMatch(callerCannotRaiseLimits, /524288000|10000/u);
});

test("builds sequential in-memory scene scanning and bounded final capture expressions", () => {
  const scanExpression = buildScanFrameSignaturesExpression(
    Array.from({ length: 100 }, (_, index) => index),
    { maxWallTimeMs: 90_000 },
  );
  assert.match(scanExpression, /willReadFrequently/u);
  assert.match(scanExpression, /performance\.now\(\) >= interiorDeadline/u);
  assert.doesNotMatch(scanExpression, /toDataURL|fetch\(['"]https?:/u);
  assert.match(scanExpression, /performance\.now\(\) \+ 45000/u);
  assert.match(scanExpression, /boundary-scan-failed/u);
  assert.match(scanExpression, /ending = await capture\(requestedTimes\.at\(-1\)\)/u);
  const requestedTimes = JSON.parse(/const requestedTimes = (\[[^;]+\]);/u.exec(scanExpression)[1]);
  assert.equal(requestedTimes.length, 72);

  const captureExpression = buildCaptureFrameExpression(5, 2_048);
  assert.match(captureExpression, /768 \/ video\.videoWidth/u);
  assert.match(captureExpression, /768 \/ video\.videoHeight/u);
  assert.match(captureExpression, /toDataURL\('image\/png'\)/u);
});

test("caller options cannot raise the 100 MB Douyin download ceiling", async () => {
  const originalFetch = globalThis.fetch;
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-douyin-video-limit-"));
  try {
    globalThis.fetch = async () => new Response(new Uint8Array(), {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(101 * 1024 * 1024),
      },
    });
    await assert.rejects(downloadDouyinVideo({
      source: "https://v5-dy.zjcdn.com/video.mp4",
      destination: path.join(projectRoot, "video.mp4"),
      maxBytes: 500 * 1024 * 1024,
    }), /exceeds the local size limit/u);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("video cleanup paths must be children of the dedicated runtime root", () => {
  const projectRoot = path.resolve("C:/project");
  const root = resolveVideoAnalysisRoot(projectRoot);
  assert.equal(
    assertVideoAnalysisJobPath(projectRoot, path.join(root, "job-1")),
    path.join(root, "job-1"),
  );
  assert.throws(() => assertVideoAnalysisJobPath(projectRoot, root));
  assert.throws(() => assertVideoAnalysisJobPath(projectRoot, path.join(projectRoot, "elsewhere")));
});
