import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildCloseOpenSharedWorkExpression,
  buildOpenIncomingSharedWorkExpression,
  buildReadOpenSharedWorkStateExpression,
  buildReadOpenSharedWorkVideoExpression,
} from "./douyin-chat-page.mjs";
import {
  assertCapturedVideoFrame,
  assertUsableVideoFrameVisuals,
  buildCaptureFrameExpression,
  buildScanFrameSignaturesExpression,
  createVideoAnalysisJob,
  isTrustedDouyinMediaUrl,
  removeVideoAnalysisJob,
} from "./douyin-video-runtime.mjs";
import {
  buildAdaptiveScanTimes,
  getAdaptiveFramePlan,
  selectAdaptiveFrameSamples,
} from "./video-frame-selection.mjs";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const CHAT_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const OPEN_PLAYER_ATTEMPTS = 16;
const OPEN_PLAYER_INTERVAL_MS = 250;
const OPEN_PLAYER_VIDEO_SELECTOR = ".commonModalFullScreenModalFullScreen video";
const MAX_VIDEO_SOURCE_CANDIDATES = 4;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_SCAN_WALL_TIME_MS = 45_000;
const MAX_CAPTURE_WALL_TIME_MS = 45_000;

export function buildInstallDouyinSilentMediaGuardExpression() {
  return `(() => {
    const key = '__codexDouyinSilentMediaV1';
    const existing = window[key];
    if (existing?.active) {
      for (const media of document.querySelectorAll('audio,video')) {
        media.muted = true;
        media.volume = 0;
      }
      return { ok: true, reused: true };
    }
    const prototype = HTMLMediaElement.prototype;
    const originalPlay = prototype.play;
    if (typeof originalPlay !== 'function') return { ok: false, reason: 'media-play-unavailable' };
    const mute = (media) => {
      try {
        media.muted = true;
        media.volume = 0;
      } catch {}
    };
    const muteTree = (root) => {
      if (root instanceof HTMLMediaElement) mute(root);
      if (typeof root?.querySelectorAll === 'function') {
        for (const media of root.querySelectorAll('audio,video')) mute(media);
      }
    };
    const guardedPlay = function guardedPlay(...args) {
      mute(this);
      return originalPlay.apply(this, args);
    };
    try {
      prototype.play = guardedPlay;
    } catch {
      return { ok: false, reason: 'media-play-guard-unavailable' };
    }
    if (prototype.play !== guardedPlay) {
      return { ok: false, reason: 'media-play-guard-unavailable' };
    }
    muteTree(document);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) muteTree(node);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window[key] = { active: true, originalPlay, guardedPlay, observer };
    return { ok: true, reused: false };
  })()`;
}

export function buildRemoveDouyinSilentMediaGuardExpression() {
  return `(() => {
    const key = '__codexDouyinSilentMediaV1';
    const guard = window[key];
    for (const media of document.querySelectorAll('audio,video')) {
      try {
        media.muted = true;
        media.volume = 0;
      } catch {}
    }
    if (!guard?.active) return { ok: true, removed: false };
    guard.observer?.disconnect();
    if (HTMLMediaElement.prototype.play === guard.guardedPlay) {
      HTMLMediaElement.prototype.play = guard.originalPlay;
    }
    delete window[key];
    return { ok: true, removed: true };
  })()`;
}

export async function prepareOpenDouyinPlayerVideo({
  cdp,
  projectRoot,
  playerState,
  maxDimension = 768,
  maxScanWallTimeMs = MAX_SCAN_WALL_TIME_MS,
  maxCaptureWallTimeMs = MAX_CAPTURE_WALL_TIME_MS,
} = {}) {
  if (!cdp || typeof cdp.evaluate !== "function") {
    throw new Error("A connected CDP client is required to capture the open Douyin player.");
  }
  const state = playerState?.ok ? playerState : await cdp.evaluate(
    buildReadOpenSharedWorkVideoExpression(),
  );
  if (state?.transport !== "mse" || !Number.isFinite(state.duration) || state.duration <= 0
      || !Number.isFinite(state.videoWidth) || state.videoWidth <= 0
      || !Number.isFinite(state.videoHeight) || state.videoHeight <= 0) {
    throw new Error("The open Douyin MSE player is not ready for bounded capture.");
  }
  const job = await createVideoAnalysisJob(projectRoot);
  try {
    const framePlan = getAdaptiveFramePlan(state.duration);
    const scanTimes = buildAdaptiveScanTimes(state.duration, {
      scanBudget: framePlan.scanBudget,
      audioAnchors: [],
    });
    const boundedScanWallTimeMs = Math.max(1_000, Math.min(
      MAX_SCAN_WALL_TIME_MS,
      Math.trunc(maxScanWallTimeMs) || MAX_SCAN_WALL_TIME_MS,
    ));
    const scan = await cdp.evaluate(buildScanFrameSignaturesExpression(scanTimes, {
      maxWallTimeMs: boundedScanWallTimeMs,
      videoSelector: OPEN_PLAYER_VIDEO_SELECTOR,
    }), boundedScanWallTimeMs + 10_000);
    if (!scan?.ok || !Array.isArray(scan.samples) || scan.samples.length === 0) {
      throw new Error(`Could not scan the open Douyin player: ${scan?.reason || "unknown"}.`);
    }
    const scanVisuals = assertUsableVideoFrameVisuals(scan.samples, "blank-open-player-scan");
    const selection = selectAdaptiveFrameSamples({
      samples: scan.samples,
      durationSeconds: state.duration,
      frameBudget: framePlan.frameBudget,
      audioAnchors: [],
    });
    if (!Array.isArray(selection.selected) || selection.selected.length === 0) {
      throw new Error("The open Douyin player produced no selectable keyframes.");
    }

    const boundedCaptureWallTimeMs = Math.max(1_000, Math.min(
      MAX_CAPTURE_WALL_TIME_MS,
      Math.trunc(maxCaptureWallTimeMs) || MAX_CAPTURE_WALL_TIME_MS,
    ));
    const captureDeadline = Date.now() + boundedCaptureWallTimeMs;
    const framePaths = [];
    const frameTimes = [];
    const capturedFrames = [];
    let totalFrameBytes = 0;
    for (const selected of selection.selected) {
      if (Date.now() >= captureDeadline) {
        throw new Error("Open-player keyframe capture exceeded its wall-time limit.");
      }
      const frame = await cdp.evaluate(buildCaptureFrameExpression(
        selected.time,
        maxDimension,
        2_500,
        { videoSelector: OPEN_PLAYER_VIDEO_SELECTOR },
      ), Math.min(5_000, Math.max(1_000, captureDeadline - Date.now() + 500)));
      if (!frame?.ok || !frame.dataUrl?.startsWith("data:image/png;base64,")) {
        throw new Error(`Could not capture an open-player keyframe: ${frame?.reason || "unknown"}.`);
      }
      const frameBytes = Buffer.from(
        frame.dataUrl.slice("data:image/png;base64,".length),
        "base64",
      );
      assertCapturedVideoFrame(frame, frameBytes);
      if (frameBytes.byteLength === 0 || frameBytes.byteLength > MAX_FRAME_BYTES) {
        throw new Error("An open-player keyframe violated its byte limit.");
      }
      totalFrameBytes += frameBytes.byteLength;
      if (totalFrameBytes > MAX_TOTAL_FRAME_BYTES) {
        throw new Error("Open-player keyframes exceeded their total byte limit.");
      }
      const framePath = path.join(
        job.jobDirectory,
        `frame-${String(framePaths.length + 1).padStart(2, "0")}.png`,
      );
      await writeFile(framePath, frameBytes, { flag: "wx" });
      await stat(framePath);
      framePaths.push(framePath);
      frameTimes.push(selected.time);
      capturedFrames.push(frame);
    }
    const captureVisuals = assertUsableVideoFrameVisuals(
      capturedFrames,
      "blank-open-player-frames",
    );
    return {
      ...job,
      framePaths,
      frameTimes,
      duration: state.duration,
      videoWidth: state.videoWidth,
      videoHeight: state.videoHeight,
      audioPath: null,
      audioAvailable: false,
      audioReason: "open-player-mse-visual-only",
      audioUnderstanding: {
        processed: false,
        reason: "open-player-mse-visual-only",
      },
      sampling: {
        frameBudget: framePlan.frameBudget,
        scanBudget: framePlan.scanBudget,
        requestedScanCount: scanTimes.length,
        completedScanCount: scan.samples.length,
        failedSeekCount: scan.failedSeekCount || 0,
        scanTruncated: Boolean(scan.truncated),
        selectedFrameCount: framePaths.length,
        audioAnchorCount: 0,
        sceneThreshold: selection.sceneThreshold,
        totalFrameBytes,
        blankScanFrameCount: scanVisuals.blankFrameCount,
        blankCapturedFrameCount: captureVisuals.blankFrameCount,
      },
    };
  } catch (error) {
    await removeVideoAnalysisJob(projectRoot, job.jobDirectory);
    throw error;
  }
}

export async function resolveDouyinSharedWorkPlayerFallback({
  cdp,
  projectRoot,
  mediaMessage,
  expectedChatFingerprint,
  initialManifest,
  sleepFn = sleep,
  attempts = OPEN_PLAYER_ATTEMPTS,
  intervalMs = OPEN_PLAYER_INTERVAL_MS,
  preparePlayerVideo = prepareOpenDouyinPlayerVideo,
} = {}) {
  if (initialManifest?.mediaType !== "shared_cover") {
    return { kind: "manifest", manifest: initialManifest };
  }
  if (!cdp || typeof cdp.evaluate !== "function") {
    throw new Error("A connected CDP client is required for shared-work player fallback.");
  }
  if (!CHAT_FINGERPRINT_PATTERN.test(expectedChatFingerprint || "")) {
    throw new Error("A locked Douyin chat fingerprint is required for player fallback.");
  }
  if (typeof sleepFn !== "function" || typeof preparePlayerVideo !== "function") {
    throw new Error("Valid shared-work player fallback dependencies are required.");
  }
  const boundedAttempts = Math.max(
    1,
    Math.min(OPEN_PLAYER_ATTEMPTS, Number.parseInt(attempts, 10) || 1),
  );
  const boundedIntervalMs = Math.max(25, Math.min(
    OPEN_PLAYER_INTERVAL_MS,
    Number.parseInt(intervalMs, 10) || OPEN_PLAYER_INTERVAL_MS,
  ));

  const networkSources = [];
  const observeNetworkSource = (message) => {
    if (message?.method !== "Network.responseReceived") return;
    const response = message.params?.response;
    const source = response?.url;
    const mimeType = String(response?.mimeType || "").toLowerCase();
    const resourceType = String(message.params?.type || "").toLowerCase();
    if ((resourceType === "media" || mimeType.startsWith("video/"))
        && isTrustedDouyinMediaUrl(source)
        && !networkSources.includes(source)
        && networkSources.length < MAX_VIDEO_SOURCE_CANDIDATES) {
      networkSources.push(source);
    }
  };
  let networkObservationEnabled = false;
  if (typeof cdp.on === "function" && typeof cdp.off === "function"
      && typeof cdp.request === "function") {
    cdp.on("notification", observeNetworkSource);
    try {
      await cdp.request("Network.enable", {}, 5_000);
      networkObservationEnabled = true;
    } catch {
      cdp.off("notification", observeNetworkSource);
    }
  }
  let guard;
  try {
    guard = await cdp.evaluate(buildInstallDouyinSilentMediaGuardExpression());
  } catch (error) {
    if (networkObservationEnabled) {
      cdp.off("notification", observeNetworkSource);
      await cdp.request("Network.disable", {}, 5_000).catch(() => {});
    }
    throw error;
  }
  if (!guard?.ok) {
    if (networkObservationEnabled) {
      cdp.off("notification", observeNetworkSource);
      await cdp.request("Network.disable", {}, 5_000).catch(() => {});
    }
    return { kind: "manifest", manifest: initialManifest };
  }
  let opened = false;
  let closeRequired = false;
  try {
    const openResult = await cdp.evaluate(buildOpenIncomingSharedWorkExpression(
      mediaMessage,
      expectedChatFingerprint,
    ));
    if (!openResult?.ok || openResult.chatFingerprint !== expectedChatFingerprint) {
      return { kind: "manifest", manifest: initialManifest };
    }
    opened = true;
    closeRequired = true;
    for (let attempt = 0; attempt < boundedAttempts; attempt += 1) {
      if (attempt > 0) await sleepFn(boundedIntervalMs);
      const player = await cdp.evaluate(buildReadOpenSharedWorkVideoExpression());
      if (!player?.ok) continue;
      if (networkSources.length > 0) {
        return {
          kind: "manifest",
          manifest: {
            ok: true,
            mediaType: "video",
            source: networkSources[0],
            sources: [...networkSources],
            selectedCodec: "open-player-network",
          },
        };
      }
      if (player.transport === "mse") {
        try {
          const media = await preparePlayerVideo({ cdp, projectRoot, playerState: player });
          return { kind: "media", media: { kind: "video", ...media } };
        } catch {
          return { kind: "manifest", manifest: initialManifest };
        }
      }
      const sources = [...new Set([
        ...(Array.isArray(player.sources) ? player.sources : []),
        player.source,
      ])].filter(isTrustedDouyinMediaUrl).slice(0, MAX_VIDEO_SOURCE_CANDIDATES);
      if (sources.length === 0) continue;
      return {
        kind: "manifest",
        manifest: {
          ok: true,
          mediaType: "video",
          source: sources[0],
          sources,
          selectedCodec: "open-player",
        },
      };
    }
    return { kind: "manifest", manifest: initialManifest };
  } finally {
    let cleanupError = null;
    if (opened) {
      const closeResult = await cdp.evaluate(buildCloseOpenSharedWorkExpression());
      if (!closeResult?.ok) {
        cleanupError = new Error("The Douyin shared-work viewer could not be closed safely.");
      } else {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          await sleepFn(100);
          const playerState = await cdp.evaluate(buildReadOpenSharedWorkStateExpression());
          if (playerState?.ok && playerState.open === false) {
            closeRequired = false;
            break;
          }
        }
        if (closeRequired) {
          cleanupError = new Error(
            "The Douyin shared-work viewer remained open after bounded cleanup.",
          );
        }
      }
    }
    const removal = await cdp.evaluate(buildRemoveDouyinSilentMediaGuardExpression())
      .catch(() => null);
    if (!removal?.ok && !cleanupError) {
      cleanupError = new Error("The temporary Douyin media mute guard could not be removed.");
    }
    if (networkObservationEnabled) {
      cdp.off("notification", observeNetworkSource);
      await cdp.request("Network.disable", {}, 5_000).catch(() => {});
    }
    if (cleanupError) throw cleanupError;
  }
}
