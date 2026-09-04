import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  buildInstallDouyinSilentMediaGuardExpression,
  buildRemoveDouyinSilentMediaGuardExpression,
  prepareOpenDouyinPlayerVideo,
  resolveDouyinSharedWorkPlayerFallback,
} from "../src/douyin-player-runtime.mjs";
import { removeVideoAnalysisJob } from "../src/douyin-video-runtime.mjs";

const chatFingerprint = "a".repeat(64);
const mediaMessage = Object.freeze({
  ordinalFromEnd: 1,
  fingerprint: "b".repeat(64),
  kind: "media",
  side: "left",
});
const coverManifest = Object.freeze({
  ok: true,
  mediaType: "shared_cover",
  sources: ["https://p3.douyinpic.com/cover"],
  totalImageCount: 1,
});

function canvasPngFixture(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const visibleFrame = Object.freeze({
  pixelCount: 64 * 64,
  meanLuminance: 96,
  maxLuminance: 220,
  nonBlackRatio: 0.9,
});

function expressionKind(expression) {
  if (expression.includes("removed: false")) return "unguard";
  if (expression.includes("const key = '__codexDouyinSilentMediaV1'")
      && expression.includes("originalPlay")) return "guard";
  if (expression.includes("clickTarget.click()")) return "open";
  if (expression.includes("const rawSources")) return "read";
  if (expression.includes("const close = modal.querySelector")) return "close";
  if (expression.includes("const open = Boolean")) return "state";
  return "other";
}

test("installs a synchronous mute guard before opening and removes it after closing", async () => {
  const calls = [];
  let reads = 0;
  const result = await resolveDouyinSharedWorkPlayerFallback({
    cdp: {
      async evaluate(expression) {
        const kind = expressionKind(expression);
        calls.push(kind);
        if (kind === "guard") return { ok: true };
        if (kind === "open") return { ok: true, chatFingerprint };
        if (kind === "read") {
          reads += 1;
          return reads === 1
            ? { ok: false, reason: "open-video-source-not-ready" }
            : {
              ok: true,
              transport: "https",
              source: "https://v3-dy.zjcdn.com/video.mp4",
              sources: ["https://v3-dy.zjcdn.com/video.mp4"],
            };
        }
        if (kind === "close") return { ok: true, wasOpen: true, closed: false };
        if (kind === "state") return { ok: true, open: false };
        if (kind === "unguard") return { ok: true, removed: true };
        throw new Error("Unexpected player expression.");
      },
    },
    projectRoot: "C:/runtime/project",
    mediaMessage,
    expectedChatFingerprint: chatFingerprint,
    initialManifest: coverManifest,
    sleepFn: async () => {},
  });
  assert.deepEqual(result, {
    kind: "manifest",
    manifest: {
      ok: true,
      mediaType: "video",
      source: "https://v3-dy.zjcdn.com/video.mp4",
      sources: ["https://v3-dy.zjcdn.com/video.mp4"],
      selectedCodec: "open-player",
    },
  });
  assert.deepEqual(calls, ["guard", "open", "read", "read", "close", "state", "unguard"]);
});

test("captures MSE video frames from the muted open player instead of downgrading to cover", async () => {
  const calls = [];
  const prepared = {
    jobDirectory: "C:/runtime/video-analysis/job",
    framePaths: ["C:/runtime/video-analysis/job/frame-01.png"],
    duration: 6.1,
    audioUnderstanding: { processed: false, reason: "open-player-mse-visual-only" },
  };
  const result = await resolveDouyinSharedWorkPlayerFallback({
    cdp: {
      async evaluate(expression) {
        const kind = expressionKind(expression);
        calls.push(kind);
        if (kind === "guard") return { ok: true };
        if (kind === "open") return { ok: true, chatFingerprint };
        if (kind === "read") return {
          ok: true,
          transport: "mse",
          sources: [],
          duration: 6.1,
          videoWidth: 720,
          videoHeight: 1280,
          readyState: 4,
        };
        if (kind === "close") return { ok: true };
        if (kind === "state") return { ok: true, open: false };
        if (kind === "unguard") return { ok: true, removed: true };
        throw new Error("Unexpected player expression.");
      },
    },
    projectRoot: "C:/runtime/project",
    mediaMessage,
    expectedChatFingerprint: chatFingerprint,
    initialManifest: coverManifest,
    sleepFn: async () => {},
    preparePlayerVideo: async ({ playerState }) => {
      assert.equal(playerState.transport, "mse");
      return prepared;
    },
  });
  assert.deepEqual(result, { kind: "media", media: { kind: "video", ...prepared } });
  assert.deepEqual(calls, ["guard", "open", "read", "close", "state", "unguard"]);
});

test("ignores unbound network video responses while capturing the exact MSE player", async () => {
  const requests = [];
  class FakeCdp extends EventEmitter {
    async request(method) {
      requests.push(method);
      return {};
    }

    async evaluate(expression) {
      const kind = expressionKind(expression);
      if (kind === "guard") return { ok: true };
      if (kind === "open") {
        this.emit("notification", {
          method: "Network.responseReceived",
          params: {
            type: "Media",
            response: {
              mimeType: "video/mp4",
              url: "https://v3-dy.zjcdn.com/video.mp4",
            },
          },
        });
        return { ok: true, chatFingerprint };
      }
      if (kind === "read") return {
        ok: true,
        transport: "mse",
        duration: 6.1,
        videoWidth: 720,
        videoHeight: 1280,
      };
      if (kind === "close") return { ok: true };
      if (kind === "state") return { ok: true, open: false };
      if (kind === "unguard") return { ok: true, removed: true };
      throw new Error("Unexpected player expression.");
    }
  }
  const result = await resolveDouyinSharedWorkPlayerFallback({
    cdp: new FakeCdp(),
    projectRoot: "C:/runtime/project",
    mediaMessage,
    expectedChatFingerprint: chatFingerprint,
    initialManifest: coverManifest,
    sleepFn: async () => {},
    preparePlayerVideo: async () => ({
      jobDirectory: "C:/runtime/video-analysis/job",
      framePaths: ["C:/runtime/video-analysis/job/frame-01.png"],
      duration: 6.1,
      audioUnderstanding: { processed: false, reason: "open-player-mse-visual-only" },
    }),
  });
  assert.equal(result.kind, "media");
  assert.equal(result.media.duration, 6.1);
  assert.deepEqual(requests, []);
});

test("keeps an honest cover boundary when the bounded muted player has no video", async () => {
  const calls = [];
  const result = await resolveDouyinSharedWorkPlayerFallback({
    cdp: {
      async evaluate(expression) {
        const kind = expressionKind(expression);
        calls.push(kind);
        if (kind === "guard") return { ok: true };
        if (kind === "open") return { ok: true, chatFingerprint };
        if (kind === "read") return { ok: false, reason: "open-video-source-not-ready" };
        if (kind === "close") return { ok: true };
        if (kind === "state") return { ok: true, open: false };
        if (kind === "unguard") return { ok: true, removed: true };
        throw new Error("Unexpected player expression.");
      },
    },
    projectRoot: "C:/runtime/project",
    mediaMessage,
    expectedChatFingerprint: chatFingerprint,
    initialManifest: coverManifest,
    attempts: 999,
    sleepFn: async () => {},
  });
  assert.deepEqual(result, { kind: "manifest", manifest: coverManifest });
  assert.equal(calls.filter((kind) => kind === "read").length, 16);
  assert.equal(calls.at(-1), "unguard");
});

test("builds content-free mute guard expressions", () => {
  const install = buildInstallDouyinSilentMediaGuardExpression();
  const remove = buildRemoveDouyinSilentMediaGuardExpression();
  assert.match(install, /HTMLMediaElement\.prototype/u);
  assert.match(install, /media\.muted = true/u);
  assert.match(install, /media\.volume = 0/u);
  assert.match(install, /MutationObserver/u);
  assert.match(remove, /guard\.originalPlay/u);
  for (const expression of [install, remove]) {
    assert.doesNotMatch(
      expression,
      /textContent|innerText|currentSrc|getAttribute\(['"](?:href|src)|document\.cookie|localStorage|sessionStorage/u,
    );
  }
});

test("writes bounded open-player MSE keyframes into a removable video job", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-douyin-open-player-"));
  let captureIndex = 0;
  try {
    const result = await prepareOpenDouyinPlayerVideo({
      cdp: {
        async evaluate(expression) {
          if (expression.includes("const requestedTimes")) {
            return {
              ok: true,
              samples: [
                { time: 0.1, signature: [0, 0, 0, 0, 0, 0], visual: visibleFrame },
                { time: 1.5, signature: [1, 1, 1, 1, 1, 1], visual: visibleFrame },
                { time: 3, signature: [8, 8, 8, 8, 8, 8], visual: visibleFrame },
                { time: 4.5, signature: [9, 9, 9, 9, 9, 9], visual: visibleFrame },
                { time: 6, signature: [15, 15, 15, 15, 15, 15], visual: visibleFrame },
              ],
              failedSeekCount: 0,
              truncated: false,
            };
          }
          if (expression.includes("toDataURL('image/png')")) {
            captureIndex += 1;
            return {
              ok: true,
              time: captureIndex,
              width: 64,
              height: 64,
              visual: visibleFrame,
              dataUrl: `data:image/png;base64,${canvasPngFixture(64, 64).toString("base64")}`,
            };
          }
          throw new Error("Unexpected capture expression.");
        },
      },
      projectRoot,
      playerState: {
        ok: true,
        transport: "mse",
        duration: 6.1,
        videoWidth: 720,
        videoHeight: 1280,
      },
    });
    assert.ok(result.framePaths.length >= 2);
    assert.equal(result.audioReason, "open-player-mse-visual-only");
    assert.equal(result.audioUnderstanding.processed, false);
    assert.equal(result.sampling.audioAnchorCount, 0);
    for (const framePath of result.framePaths) await access(framePath);
    await removeVideoAnalysisJob(projectRoot, result.jobDirectory);
    await assert.rejects(access(result.jobDirectory));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
