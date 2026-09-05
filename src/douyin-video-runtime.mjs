import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import https from "node:https";
import { createServer } from "node:http";
import path from "node:path";
import { CdpClient } from "./cdp-client.mjs";
import {
  buildReadCompatibleAwemeSourceExpression,
} from "./douyin-chat-page.mjs";
import {
  buildAdaptiveScanTimes,
  buildAudioAnchorsFromSegments,
  getAdaptiveFramePlan,
  MAX_SCAN_SAMPLE_COUNT,
  selectAdaptiveFrameSamples,
} from "./video-frame-selection.mjs";
import {
  DouyinMediaEvidenceError,
  DOUYIN_MEDIA_ERROR_CODES,
  isDouyinCoverFallbackEligible,
} from "./douyin-media-evidence.mjs";

const TRUSTED_MEDIA_SUFFIXES = [
  ".zjcdn.com",
  ".douyinvod.com",
  ".douyin.com",
  ".douyinpic.com",
  ".byteimg.com",
  ".bytecdn.cn",
  ".ibytedtos.com",
  ".bytedance.net",
  ".snssdk.com",
];
const TRUSTED_MEDIA_HOSTS = new Set([
  "api-play.amemv.com",
  "api-play-hj.amemv.com",
]);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const DEFAULT_MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_AUDIO_BYTES = 40 * 1024 * 1024;
const DEFAULT_MAX_AUDIO_DURATION_SECONDS = 15 * 60;
const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_FRAME_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_SCAN_WALL_TIME_MS = 45_000;
const DEFAULT_MAX_CAPTURE_WALL_TIME_MS = 45_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
const DEFAULT_DOWNLOAD_WALL_TIME_MS = 6 * 60_000;
const VIDEO_SOURCE_ATTEMPT_TIMEOUT_MS = 30_000;
const VIDEO_RANGE_CHUNK_BYTES = 1024 * 1024;
const VIDEO_RANGE_ATTEMPTS = 3;
const VIDEO_RANGE_CONCURRENCY = 3;
const MAX_VIDEO_SOURCE_CANDIDATES = 4;
const MAX_VIDEO_SOURCE_REDIRECTS = 2;
const VIDEO_JOB_NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function boundedLimit(value, fallback, hardMaximum, minimum = 1) {
  const normalized = Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(minimum, Math.min(hardMaximum, normalized));
}

export class DouyinVideoDecodeError extends DouyinMediaEvidenceError {
  constructor(reason = "decode-unavailable") {
    const code = /frames-unavailable|no-decoded-frame|seek-timeout/u.test(reason)
      ? DOUYIN_MEDIA_ERROR_CODES.NO_DECODED_FRAME_WITHIN_DEADLINE
      : /canvas/u.test(reason)
        ? DOUYIN_MEDIA_ERROR_CODES.CANVAS_SECURITY
        : DOUYIN_MEDIA_ERROR_CODES.DECODE_UNAVAILABLE;
    super(code, reason);
    this.name = "DouyinVideoDecodeError";
  }
}

export class DouyinVideoSourcesExhaustedError extends DouyinMediaEvidenceError {
  constructor(failures = [], code = DOUYIN_MEDIA_ERROR_CODES.SOURCE_UNAVAILABLE) {
    const safeFailures = Array.isArray(failures)
      ? failures.filter((value) => /^[a-z0-9-]{1,80}$/u.test(value)).slice(0, MAX_VIDEO_SOURCE_CANDIDATES)
      : [];
    super(code, "compatible-sources-exhausted", { failures: safeFailures });
    this.name = "DouyinVideoSourcesExhaustedError";
  }
}

function isValidFrameVisual(visual) {
  return visual && Number.isSafeInteger(visual.pixelCount) && visual.pixelCount > 0
    && Number.isFinite(visual.meanLuminance)
    && visual.meanLuminance >= 0 && visual.meanLuminance <= 255
    && Number.isFinite(visual.maxLuminance)
    && visual.maxLuminance >= 0 && visual.maxLuminance <= 255
    && Number.isFinite(visual.nonBlackRatio)
    && visual.nonBlackRatio >= 0 && visual.nonBlackRatio <= 1;
}

export function assertUsableVideoFrameVisuals(samples, reason = "blank-video-frames") {
  if (!Array.isArray(samples) || samples.length === 0
      || samples.some((sample) => !isValidFrameVisual(sample?.visual))) {
    throw new DouyinVideoDecodeError("invalid-frame-visuals");
  }
  const blankFrameCount = samples.filter(({ visual }) => (
    visual.maxLuminance <= 4 && visual.nonBlackRatio <= 0.0001
  )).length;
  return {
    blankFrameCount,
    usableFrameCount: samples.length - blankFrameCount,
    decodedFrameCount: samples.length,
    visualMode: blankFrameCount === samples.length ? "decoded-black" : "decoded-visible",
    diagnosticReason: blankFrameCount === samples.length ? reason : null,
  };
}

function assertCanvasPng(frameBytes, expectedWidth, expectedHeight) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (frameBytes.byteLength < 33 || !frameBytes.subarray(0, 8).equals(signature)
      || frameBytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new DouyinVideoDecodeError("invalid-frame-png");
  }
  const width = frameBytes.readUInt32BE(16);
  const height = frameBytes.readUInt32BE(20);
  if (width !== expectedWidth || height !== expectedHeight || width < 2 || height < 2) {
    throw new DouyinVideoDecodeError("invalid-frame-dimensions");
  }
}

export function assertCapturedVideoFrame(frame, frameBytes) {
  if (!frame || !Number.isSafeInteger(frame.width) || frame.width < 2
      || !Number.isSafeInteger(frame.height) || frame.height < 2
      || !Buffer.isBuffer(frameBytes) || !isValidFrameVisual(frame.visual)) {
    throw new DouyinVideoDecodeError("invalid-frame-visuals");
  }
  assertCanvasPng(frameBytes, frame.width, frame.height);
}

export function isTrustedDouyinMediaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (
      TRUSTED_MEDIA_HOSTS.has(url.hostname)
      || TRUSTED_MEDIA_SUFFIXES.some(
        (suffix) => url.hostname === suffix.slice(1) || url.hostname.endsWith(suffix),
      )
    );
  } catch {
    return false;
  }
}

async function openDouyinVideoResponse({ source, timeoutMs, requestFn }) {
  let currentSource = source;
  for (let redirectCount = 0; redirectCount <= MAX_VIDEO_SOURCE_REDIRECTS; redirectCount += 1) {
    const { request, response } = await new Promise((resolve, reject) => {
      const pendingRequest = requestFn(currentSource, {
        headers: {
          "Accept-Encoding": "identity",
          Referer: "https://www.douyin.com/",
        },
        timeout: timeoutMs,
      }, (incomingResponse) => resolve({ request: pendingRequest, response: incomingResponse }));
      pendingRequest.once("timeout", () => {
        pendingRequest.destroy(new Error("Douyin media download became inactive."));
      });
      pendingRequest.once("error", reject);
    });
    const location = response.headers.location;
    if (response.statusCode >= 300 && response.statusCode < 400 && location) {
      let nextSource;
      try {
        nextSource = new URL(location, currentSource).href;
      } catch {
        response.destroy();
        request.destroy();
        throw new Error("Douyin media redirected to an invalid URL.");
      }
      response.destroy();
      request.destroy();
      if (!isTrustedDouyinMediaUrl(nextSource)) {
        throw new Error("Douyin media redirected to an untrusted URL.");
      }
      currentSource = nextSource;
      continue;
    }
    return { request, response, finalSource: currentSource };
  }
  throw new Error("Douyin media exceeded its redirect limit.");
}

function parseDouyinContentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(String(value || ""));
  if (!match) return null;
  const [, start, end, total] = match.map(Number);
  if (![start, end, total].every(Number.isSafeInteger) || start > end || end >= total) return null;
  return { start, end, total };
}

function classifyVideoDownloadFailure(error) {
  const message = String(error?.message || "").toLowerCase();
  const code = String(error?.code || "").toUpperCase();
  const rangeFailure = /range (\d+)\/(\d+).*\(([a-z0-9-]+)\)/u.exec(message);
  if (rangeFailure) {
    return `range-${rangeFailure[1]}-of-${rangeFailure[2]}-${rangeFailure[3]}`;
  }
  if (message.includes("wall-time")) return "wall-time";
  if (message.includes("inactive") || code === "ETIMEDOUT") return "inactive";
  if (message.includes("incomplete byte range") || message.includes("premature close")) {
    return "incomplete-range";
  }
  if (message.includes("unexpected byte range")) return "unexpected-range";
  if (message.includes("oversized byte range")) return "oversized-range";
  if (message.includes("bounded range probe") || message.includes("invalid range probe")) {
    return "invalid-probe";
  }
  if (message.includes("was not a video")) return "invalid-media-type";
  if (message.includes("exceeds the local size limit")) return "size-limit";
  if (message.includes("redirect")) return "redirect";
  const status = /http (\d{3})/u.exec(message)?.[1];
  if (status) return `http-${status}`;
  if (["ECONNRESET", "ECONNREFUSED", "EPIPE", "ENETUNREACH", "EAI_AGAIN"].includes(code)) {
    return code.toLowerCase();
  }
  return "transport-or-validation";
}

function throwIfNonFallbackDownloadFailure(error) {
  const failure = classifyVideoDownloadFailure(error);
  if (failure === "wall-time") {
    throw new DouyinMediaEvidenceError(
      DOUYIN_MEDIA_ERROR_CODES.BUDGET_EXCEEDED,
      "video-download-wall-time",
    );
  }
  if (failure === "size-limit" || failure === "oversized-range") {
    throw new DouyinMediaEvidenceError(
      DOUYIN_MEDIA_ERROR_CODES.RESOURCE_LIMIT,
      "video-download-size-limit",
    );
  }
  if (/untrusted/iu.test(String(error?.message || ""))) {
    throw new DouyinMediaEvidenceError(
      DOUYIN_MEDIA_ERROR_CODES.IDENTITY_MISMATCH,
      "untrusted-media-source",
    );
  }
  return failure;
}

export function resolveVideoAnalysisRoot(projectRoot) {
  return path.resolve(projectRoot, ".runtime", "video-analysis");
}

export function assertVideoAnalysisJobPath(projectRoot, jobDirectory) {
  const root = resolveVideoAnalysisRoot(projectRoot);
  const resolved = path.resolve(jobDirectory);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Refusing a video-analysis path outside its dedicated runtime root.");
  }
  return resolved;
}

export async function createVideoAnalysisJob(projectRoot) {
  const root = resolveVideoAnalysisRoot(projectRoot);
  const jobDirectory = path.join(root, randomUUID());
  await mkdir(jobDirectory, { recursive: true });
  return {
    jobDirectory,
    videoPath: path.join(jobDirectory, "video.mp4"),
    audioPath: path.join(jobDirectory, "audio.wav"),
  };
}

export async function removeVideoAnalysisJob(projectRoot, jobDirectory) {
  const resolved = assertVideoAnalysisJobPath(projectRoot, jobDirectory);
  await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export async function cleanupStaleVideoAnalysisJobs(projectRoot, {
  minimumAgeMs = 2 * 60 * 60 * 1_000,
  now = Date.now(),
} = {}) {
  const root = resolveVideoAnalysisRoot(projectRoot);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }

  let removedCount = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !VIDEO_JOB_NAME_PATTERN.test(entry.name)) continue;
    const jobDirectory = path.join(root, entry.name);
    const jobStat = await stat(jobDirectory);
    if (now - jobStat.mtimeMs < minimumAgeMs) continue;
    await removeVideoAnalysisJob(projectRoot, jobDirectory);
    removedCount += 1;
  }
  return removedCount;
}

export async function downloadDouyinVideo({
  source,
  destination,
  maxBytes = DEFAULT_MAX_VIDEO_BYTES,
  timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
  maxWallTimeMs = DEFAULT_DOWNLOAD_WALL_TIME_MS,
  requestFn = https.get,
}) {
  const boundedMaxBytes = boundedLimit(maxBytes, DEFAULT_MAX_VIDEO_BYTES, DEFAULT_MAX_VIDEO_BYTES);
  const boundedTimeoutMs = boundedLimit(
    timeoutMs,
    DEFAULT_DOWNLOAD_TIMEOUT_MS,
    DEFAULT_DOWNLOAD_TIMEOUT_MS,
    1_000,
  );
  const boundedWallTimeMs = boundedLimit(
    maxWallTimeMs,
    DEFAULT_DOWNLOAD_WALL_TIME_MS,
    DEFAULT_DOWNLOAD_WALL_TIME_MS,
    1_000,
  );
  if (!isTrustedDouyinMediaUrl(source)) {
    throw new Error("Refusing an untrusted Douyin media URL.");
  }
  let handle;
  let createdDestination = false;
  let byteCount = 0;
  let wallTimer;
  let wallTimeExpired = false;
  const activeRequests = new Set();
  const activeResponses = new Set();
  try {
    const deadline = Date.now() + boundedWallTimeMs;
    wallTimer = setTimeout(() => {
      wallTimeExpired = true;
      const error = new Error("Douyin media download exceeded its wall-time limit.");
      for (const activeResponse of activeResponses) activeResponse.destroy(error);
      for (const activeRequest of activeRequests) activeRequest.destroy(error);
    }, boundedWallTimeMs);

    const probe = await openDouyinVideoResponse({
      source,
      timeoutMs: boundedTimeoutMs,
      requestFn: (rangeSource, options, callback) => requestFn(rangeSource, {
        ...options,
        headers: { ...options.headers, Range: "bytes=0-0" },
      }, callback),
    });
    activeRequests.add(probe.request);
    activeResponses.add(probe.response);
    if (probe.response.statusCode !== 206) {
      throw new Error(`Douyin media download failed with HTTP ${probe.response.statusCode}.`);
    }
    const contentType = String(probe.response.headers["content-type"] || "");
    if (!contentType.startsWith("video/") && contentType !== "application/octet-stream") {
      throw new Error("Douyin media response was not a video.");
    }
    const probeRange = parseDouyinContentRange(probe.response.headers["content-range"]);
    if (!probeRange || probeRange.start !== 0 || probeRange.end !== 0) {
      throw new Error("Douyin media did not honor the bounded range probe.");
    }
    if (probeRange.total > boundedMaxBytes) {
      throw new Error("Douyin video exceeds the local size limit.");
    }
    let probeBytes = 0;
    for await (const value of probe.response) probeBytes += value.byteLength;
    activeResponses.delete(probe.response);
    activeRequests.delete(probe.request);
    if (probeBytes !== 1) throw new Error("Douyin media returned an invalid range probe.");

    handle = await open(destination, "wx");
    createdDestination = true;
    const ranges = [];
    for (let start = 0; start < probeRange.total; start += VIDEO_RANGE_CHUNK_BYTES) {
      const end = Math.min(probeRange.total - 1, start + VIDEO_RANGE_CHUNK_BYTES - 1);
      ranges.push({ start, end });
    }
    const preferredSource = probe.finalSource;
    const downloadRange = async ({ start, end }) => {
      let completedRange = null;
      let lastRangeFailure = "transport-or-validation";
      for (let attempt = 0; attempt < VIDEO_RANGE_ATTEMPTS && !completedRange; attempt += 1) {
        if (wallTimeExpired || Date.now() >= deadline) break;
        let rangeRequest;
        let rangeResponse;
        try {
          const opened = await openDouyinVideoResponse({
            source: attempt === 0 ? preferredSource : source,
            timeoutMs: Math.min(boundedTimeoutMs, Math.max(1_000, deadline - Date.now())),
            requestFn: (rangeSource, options, callback) => requestFn(rangeSource, {
              ...options,
              headers: { ...options.headers, Range: `bytes=${start}-${end}` },
            }, callback),
          });
          rangeRequest = opened.request;
          rangeResponse = opened.response;
          activeRequests.add(rangeRequest);
          activeResponses.add(rangeResponse);
          if (rangeResponse.statusCode !== 206) {
            throw new Error(`Douyin media range download failed with HTTP ${rangeResponse.statusCode}.`);
          }
          const returnedRange = parseDouyinContentRange(rangeResponse.headers["content-range"]);
          if (!returnedRange || returnedRange.start !== start || returnedRange.end !== end
              || returnedRange.total !== probeRange.total) {
            throw new Error("Douyin media returned an unexpected byte range.");
          }
          const chunks = [];
          let receivedBytes = 0;
          const expectedBytes = end - start + 1;
          for await (const value of rangeResponse) {
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            receivedBytes += chunk.byteLength;
            if (receivedBytes > expectedBytes) {
              throw new Error("Douyin media returned an oversized byte range.");
            }
            chunks.push(chunk);
          }
          if (receivedBytes !== expectedBytes) {
            throw new Error("Douyin media returned an incomplete byte range.");
          }
          completedRange = Buffer.concat(chunks, receivedBytes);
        } catch (error) {
          lastRangeFailure = classifyVideoDownloadFailure(error);
          rangeResponse?.destroy();
          rangeRequest?.destroy();
        } finally {
          if (rangeResponse) activeResponses.delete(rangeResponse);
          if (rangeRequest) activeRequests.delete(rangeRequest);
        }
      }
      if (!completedRange) {
        const rangeNumber = Math.floor(start / VIDEO_RANGE_CHUNK_BYTES) + 1;
        const rangeCount = Math.ceil(probeRange.total / VIDEO_RANGE_CHUNK_BYTES);
        throw new Error(
          `Douyin media range ${rangeNumber}/${rangeCount} failed after bounded retries (${lastRangeFailure}).`,
        );
      }
      return completedRange;
    };
    for (let index = 0; index < ranges.length; index += VIDEO_RANGE_CONCURRENCY) {
      if (wallTimeExpired || Date.now() >= deadline) {
        throw new Error("Douyin media download exceeded its wall-time limit.");
      }
      const batch = ranges.slice(index, index + VIDEO_RANGE_CONCURRENCY);
      const settled = await Promise.allSettled(batch.map(downloadRange));
      const failure = settled.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
      for (const result of settled) {
        const completedRange = result.value;
        byteCount += completedRange.byteLength;
        if (byteCount > boundedMaxBytes) throw new Error("Douyin video exceeds the local size limit.");
        await handle.write(completedRange);
      }
    }
    if (byteCount !== probeRange.total) throw new Error("Douyin video download was incomplete.");
    await handle.close();
    handle = null;
    return { byteCount, contentType };
  } catch (error) {
    for (const activeResponse of activeResponses) activeResponse.destroy();
    for (const activeRequest of activeRequests) activeRequest.destroy();
    await handle?.close().catch(() => {});
    if (createdDestination) await rm(destination, { force: true });
    throw error;
  } finally {
    clearTimeout(wallTimer);
  }
}

export async function downloadCompatibleDouyinVideo({
  sourceResult,
  destination,
  downloadFn = downloadDouyinVideo,
  validateFn = null,
  cleanupFn = async () => {},
  isRetryableValidationError = (error) => (
    error instanceof DouyinVideoDecodeError && isDouyinCoverFallbackEligible(error)
  ),
  maxWallTimeMs = DEFAULT_DOWNLOAD_WALL_TIME_MS,
  now = Date.now,
}) {
  const candidates = [...new Set([
    ...(Array.isArray(sourceResult?.sources) ? sourceResult.sources : []),
    sourceResult?.source,
  ])]
    .filter(isTrustedDouyinMediaUrl)
    .map((source, originalIndex) => ({
      source,
      originalIndex,
      priority: TRUSTED_MEDIA_HOSTS.has(new URL(source).hostname) ? 0 : 1,
    }))
    .sort((left, right) => left.priority - right.priority || left.originalIndex - right.originalIndex)
    .map((candidate) => candidate.source)
    .slice(0, MAX_VIDEO_SOURCE_CANDIDATES);
  if (candidates.length === 0) {
    throw new DouyinMediaEvidenceError(
      DOUYIN_MEDIA_ERROR_CODES.SOURCE_UNAVAILABLE,
      "trusted-video-source-unavailable",
    );
  }
  const boundedWallTimeMs = boundedLimit(
    maxWallTimeMs,
    DEFAULT_DOWNLOAD_WALL_TIME_MS,
    DEFAULT_DOWNLOAD_WALL_TIME_MS,
  );
  const deadline = now() + boundedWallTimeMs;
  const failures = [];
  for (const source of candidates) {
    const remainingWallTimeMs = deadline - now();
    if (remainingWallTimeMs < 1_000) {
      throw new DouyinMediaEvidenceError(
        DOUYIN_MEDIA_ERROR_CODES.BUDGET_EXCEEDED,
        "video-source-budget-exhausted",
      );
    }
    let download;
    try {
      download = await downloadFn({
        source,
        destination,
        timeoutMs: Math.min(VIDEO_SOURCE_ATTEMPT_TIMEOUT_MS, remainingWallTimeMs),
        maxWallTimeMs: remainingWallTimeMs,
      });
    } catch (error) {
      await cleanupFn();
      failures.push(throwIfNonFallbackDownloadFailure(error));
      continue;
    }
    if (typeof validateFn !== "function") return download;
    const validationRemainingMs = deadline - now();
    if (validationRemainingMs < 1_000) {
      await cleanupFn();
      throw new DouyinMediaEvidenceError(
        DOUYIN_MEDIA_ERROR_CODES.BUDGET_EXCEEDED,
        "video-validation-wall-time",
      );
    }
    try {
      const processed = await validateFn({
        download,
        remainingWallTimeMs: validationRemainingMs,
      });
      return { ...download, processed };
    } catch (error) {
      if (!isRetryableValidationError(error)) throw error;
      failures.push(`decode-${error?.reason || "unavailable"}`);
      await cleanupFn();
    }
  }
  const code = failures.some((failure) => failure.startsWith("decode-"))
    ? DOUYIN_MEDIA_ERROR_CODES.DECODE_UNAVAILABLE
    : DOUYIN_MEDIA_ERROR_CODES.SOURCE_UNAVAILABLE;
  throw new DouyinVideoSourcesExhaustedError(failures, code);
}

async function cleanupVideoCandidateArtifacts(job) {
  const entries = await readdir(job.jobDirectory, { withFileTypes: true });
  const removableNames = new Set([
    path.basename(job.videoPath),
    path.basename(job.audioPath),
  ]);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!removableNames.has(entry.name) && !/^frame-\d+\.png$/u.test(entry.name)) continue;
    await rm(path.join(job.jobDirectory, entry.name), { force: true });
  }
}

export async function prepareLatestDouyinVideoMedia({
  cdp,
  projectRoot,
  port = 9229,
  analyzeAudio = null,
  sourceResult = null,
  downloadFn = downloadDouyinVideo,
  extractFn = extractVideoMedia,
  maxWallTimeMs = DEFAULT_DOWNLOAD_WALL_TIME_MS,
}) {
  const resolvedSource = sourceResult ?? await cdp.evaluate(buildReadCompatibleAwemeSourceExpression());
  if (!resolvedSource?.ok) {
    throw new DouyinMediaEvidenceError(
      DOUYIN_MEDIA_ERROR_CODES.SOURCE_UNAVAILABLE,
      "trusted-video-source-unavailable",
    );
  }
  const job = await createVideoAnalysisJob(projectRoot);
  try {
    const result = await downloadCompatibleDouyinVideo({
      sourceResult: resolvedSource,
      destination: job.videoPath,
      downloadFn,
      maxWallTimeMs,
      cleanupFn: () => cleanupVideoCandidateArtifacts(job),
      validateFn: ({ remainingWallTimeMs }) => extractFn({
        port,
        videoPath: job.videoPath,
        audioPath: job.audioPath,
        outputDirectory: job.jobDirectory,
        extractAudio: typeof analyzeAudio === "function",
        analyzeAudio,
        maxOverallWallTimeMs: remainingWallTimeMs,
      }),
    });
    const { processed, ...download } = result;
    return { ...job, ...download, ...processed };
  } catch (error) {
    await removeVideoAnalysisJob(projectRoot, job.jobDirectory);
    throw error;
  }
}

async function waitForTarget(port, targetId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (response.ok) {
      const targets = await response.json();
      const target = targets.find((candidate) => candidate.id === targetId);
      if (target?.webSocketDebuggerUrl) return target;
    }
    await sleep(100);
  }
  throw new Error("Timed out waiting for the temporary video target.");
}

export function buildLocalVideoTargetOptions(url) {
  return {
    url,
    background: true,
    hidden: true,
  };
}

export async function enableLocalVideoBackgroundDecoding(pageCdp, timeoutMs) {
  await pageCdp.request(
    "Emulation.setFocusEmulationEnabled",
    { enabled: true },
    timeoutMs,
  );
}

async function closeTemporaryTarget(browserCdp, port, targetId, timeoutMs = 5_000) {
  const listTargets = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error("Browser target list is unavailable during cleanup.");
    return response.json();
  };
  if (!(await listTargets()).some((target) => target.id === targetId)) return;
  if (browserCdp.socket?.readyState !== WebSocket.OPEN) {
    throw new Error("Browser debugger disconnected before temporary target cleanup.");
  }
  const result = await browserCdp.request("Target.closeTarget", { targetId }, 5_000);
  if (result?.success === false) throw new Error("Browser refused to close the temporary video target.");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await listTargets()).some((target) => target.id === targetId)) return;
    await sleep(100);
  }
  throw new Error("Temporary video target remained open after close confirmation.");
}

async function receiveAudioUpload({
  request,
  response,
  destination,
  maxBytes,
  requestStats,
}) {
  const declaredLength = Number.parseInt(request.headers["content-length"] || "0", 10);
  if (declaredLength > maxBytes) {
    response.writeHead(413).end();
    return;
  }

  let handle;
  let createdDestination = false;
  let byteCount = 0;
  let header = Buffer.alloc(0);
  try {
    handle = await open(destination, "wx");
    createdDestination = true;
    for await (const value of request) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      byteCount += chunk.byteLength;
      if (byteCount > maxBytes) throw new Error("audio-size-limit");
      if (header.length < 12) {
        header = Buffer.concat([header, chunk.subarray(0, 12 - header.length)]);
      }
      await handle.write(chunk);
    }
    await handle.close();
    handle = null;
    const isWave = byteCount >= 44
      && header.subarray(0, 4).toString("ascii") === "RIFF"
      && header.subarray(8, 12).toString("ascii") === "WAVE";
    if (!isWave) throw new Error("invalid-wave-upload");
    requestStats.uploadedAudioBytes = byteCount;
    response.writeHead(201, { "Cache-Control": "no-store", "Content-Length": "0" }).end();
  } catch (error) {
    await handle?.close().catch(() => {});
    if (createdDestination) {
      await rm(destination, { force: true, maxRetries: 5, retryDelay: 100 });
    }
    if (!response.headersSent) {
      response.writeHead(error.message === "audio-size-limit" ? 413 : 400).end();
    } else {
      response.destroy();
    }
  }
}

async function startLocalVideoServer(
  videoPath,
  audioPath,
  maxAudioBytes = DEFAULT_MAX_AUDIO_BYTES,
  maxVideoBytes = DEFAULT_MAX_VIDEO_BYTES,
) {
  const videoStat = await stat(videoPath);
  const boundedMaxVideoBytes = boundedLimit(
    maxVideoBytes,
    DEFAULT_MAX_VIDEO_BYTES,
    DEFAULT_MAX_VIDEO_BYTES,
  );
  const boundedMaxAudioBytes = boundedLimit(
    maxAudioBytes,
    DEFAULT_MAX_AUDIO_BYTES,
    DEFAULT_MAX_AUDIO_BYTES,
  );
  if (!videoStat.isFile() || videoStat.size === 0 || videoStat.size > boundedMaxVideoBytes) {
    throw new Error("Local video is missing, empty, or exceeds the 100 MB limit.");
  }
  const audioUploadPath = `/audio-${randomUUID()}.wav`;
  const requestStats = {
    playerRequests: 0,
    videoRequests: 0,
    rangeRequests: 0,
    audioRequests: 0,
    uploadedAudioBytes: 0,
    notFound: 0,
  };
  const activeAudioUploads = new Map();
  const activeVideoStreams = new Set();
  const server = createServer((request, response) => {
    if ((request.method === "GET" || request.method === "HEAD") && request.url === "/player.html") {
      requestStats.playerRequests += 1;
      const html = "<!doctype html><meta charset=utf-8><title>Local video frame extractor</title><video muted preload=auto src=/video.mp4></video>";
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Length": String(Buffer.byteLength(html)),
        "Content-Security-Policy": "default-src 'self'; media-src 'self'; style-src 'none'; script-src 'none'",
        "Content-Type": "text/html; charset=utf-8",
      });
      response.end(request.method === "HEAD" ? undefined : html);
      return;
    }
    if (request.method === "POST" && request.url === audioUploadPath) {
      requestStats.audioRequests += 1;
      const upload = receiveAudioUpload({
        request,
        response,
        destination: audioPath,
        maxBytes: boundedMaxAudioBytes,
        requestStats,
      });
      activeAudioUploads.set(request, upload);
      void upload.then(
        () => activeAudioUploads.delete(request),
        () => activeAudioUploads.delete(request),
      );
      return;
    }
    if ((request.method !== "GET" && request.method !== "HEAD") || request.url !== "/video.mp4") {
      requestStats.notFound += 1;
      response.writeHead(404).end();
      return;
    }

    const range = request.headers.range;
    requestStats.videoRequests += 1;
    let start = 0;
    let end = videoStat.size - 1;
    let status = 200;
    if (range) {
      requestStats.rangeRequests += 1;
      const match = /^bytes=(\d+)-(\d*)$/u.exec(range);
      if (!match) {
        response.writeHead(416, { "Content-Range": `bytes */${videoStat.size}` }).end();
        return;
      }
      start = Number.parseInt(match[1], 10);
      end = match[2] ? Number.parseInt(match[2], 10) : end;
      if (start >= videoStat.size || end < start) {
        response.writeHead(416, { "Content-Range": `bytes */${videoStat.size}` }).end();
        return;
      }
      end = Math.min(end, videoStat.size - 1);
      status = 206;
    }

    const headers = {
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Length": String(end - start + 1),
      "Content-Type": "video/mp4",
    };
    if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${videoStat.size}`;
    response.writeHead(status, headers);
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    const videoStream = createReadStream(videoPath, { start, end });
    activeVideoStreams.add(videoStream);
    const forgetVideoStream = () => activeVideoStreams.delete(videoStream);
    videoStream.once("close", forgetVideoStream);
    videoStream.once("error", () => response.destroy());
    response.once("close", () => videoStream.destroy());
    videoStream.pipe(response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local video server address is unavailable.");
  return {
    url: `http://127.0.0.1:${address.port}/player.html`,
    audioUploadPath,
    getStats: () => ({ ...requestStats }),
    close: async () => {
      const uploads = [...activeAudioUploads.values()];
      for (const request of activeAudioUploads.keys()) request.destroy();
      for (const videoStream of activeVideoStreams) videoStream.destroy();
      const serverClosed = new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      server.closeAllConnections();
      const drained = Promise.allSettled(uploads);
      const completed = await Promise.race([
        Promise.all([serverClosed, drained]).then(() => true),
        sleep(3_000).then(() => false),
      ]);
      if (!completed) {
        throw new Error("Local video server did not drain active media handles in time.");
      }
    },
  };
}

export function buildExtractAudioExpression({
  uploadPath,
  maxAudioBytes = DEFAULT_MAX_AUDIO_BYTES,
  maxDurationSeconds = DEFAULT_MAX_AUDIO_DURATION_SECONDS,
}) {
  const boundedMaxAudioBytes = boundedLimit(
    maxAudioBytes,
    DEFAULT_MAX_AUDIO_BYTES,
    DEFAULT_MAX_AUDIO_BYTES,
  );
  const boundedMaxDurationSeconds = boundedLimit(
    maxDurationSeconds,
    DEFAULT_MAX_AUDIO_DURATION_SECONDS,
    DEFAULT_MAX_AUDIO_DURATION_SECONDS,
  );
  return `(async () => {
    try {
      const video = document.querySelector('video');
      if (!video || !Number.isFinite(video.duration) || video.duration <= 0) {
        return { ok: false, reason: 'video-not-ready' };
      }
      if (video.duration > ${JSON.stringify(boundedMaxDurationSeconds)} + 0.25) {
        return { ok: false, reason: 'audio-duration-limit' };
      }
      const sourceResponse = await fetch('/video.mp4', { cache: 'no-store' });
      if (!sourceResponse.ok) return { ok: false, reason: 'video-fetch-failed' };
      const sourceBytes = await sourceResponse.arrayBuffer();
      const DecoderContext = globalThis.AudioContext || globalThis.webkitAudioContext;
      const RendererContext = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
      if (!DecoderContext || !RendererContext) {
        return { ok: false, reason: 'web-audio-unavailable' };
      }
      const decoder = new DecoderContext();
      let decoded;
      try {
        decoded = await decoder.decodeAudioData(sourceBytes.slice(0));
      } catch {
        await decoder.close().catch(() => {});
        return { ok: false, reason: 'audio-track-unavailable' };
      }
      await decoder.close().catch(() => {});
      if (!decoded || decoded.numberOfChannels < 1 || decoded.length < 1) {
        return { ok: false, reason: 'audio-track-empty' };
      }

      const targetRate = 16000;
      const sourceDuration = decoded.duration;
      const processedDuration = Math.min(sourceDuration, ${JSON.stringify(boundedMaxDurationSeconds)});
      const frameCount = Math.max(1, Math.ceil(processedDuration * targetRate));
      const waveByteCount = 44 + frameCount * 2;
      if (waveByteCount > ${JSON.stringify(boundedMaxAudioBytes)}) {
        return { ok: false, reason: 'audio-size-limit' };
      }

      const renderer = new RendererContext(1, frameCount, targetRate);
      const source = renderer.createBufferSource();
      source.buffer = decoded;
      source.connect(renderer.destination);
      source.start(0);
      const rendered = await renderer.startRendering();
      const samples = rendered.getChannelData(0);
      const wave = new ArrayBuffer(44 + samples.length * 2);
      const view = new DataView(wave);
      const writeAscii = (offset, value) => {
        for (let index = 0; index < value.length; index += 1) {
          view.setUint8(offset + index, value.charCodeAt(index));
        }
      };
      writeAscii(0, 'RIFF');
      view.setUint32(4, wave.byteLength - 8, true);
      writeAscii(8, 'WAVE');
      writeAscii(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, targetRate, true);
      view.setUint32(28, targetRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeAscii(36, 'data');
      view.setUint32(40, samples.length * 2, true);
      for (let index = 0; index < samples.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, samples[index]));
        view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      }

      const uploadResponse = await fetch(${JSON.stringify(uploadPath)}, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: wave,
      });
      if (!uploadResponse.ok) return { ok: false, reason: 'audio-upload-failed' };
      return {
        ok: true,
        sampleRate: targetRate,
        channelCount: 1,
        byteCount: wave.byteLength,
        sourceDuration,
        processedDuration,
        truncated: processedDuration < sourceDuration,
      };
    } catch {
      return { ok: false, reason: 'audio-extraction-failed' };
    }
  })()`;
}

async function waitForLocalVideo(pageCdp, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  let frameUnavailableSince = null;
  while (Date.now() < deadline) {
    const state = await pageCdp.evaluate(`(() => {
      const video = document.querySelector('video');
      if (!video) return {
        ready: false,
        documentReadyState: document.readyState,
        videoFound: false,
        errorCode: null,
      };
      return {
        ready: video.readyState >= 2 && Number.isFinite(video.duration) && video.duration > 0
          && Number.isFinite(video.videoWidth) && video.videoWidth >= 2
          && Number.isFinite(video.videoHeight) && video.videoHeight >= 2,
        documentReadyState: document.readyState,
        videoFound: true,
        readyState: video.readyState,
        networkState: video.networkState,
        errorCode: video.error?.code || null,
        duration: Number.isFinite(video.duration) ? video.duration : null,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
      };
    })()`);
    lastState = state;
    if (state?.errorCode) throw new DouyinVideoDecodeError(`media-error-${state.errorCode}`);
    if (state?.ready) return state;
    const hasBufferedMediaWithoutFrames = state?.readyState >= 3
      && Number.isFinite(state?.duration) && state.duration > 0
      && (!Number.isFinite(state?.videoWidth) || state.videoWidth < 2
        || !Number.isFinite(state?.videoHeight) || state.videoHeight < 2);
    if (hasBufferedMediaWithoutFrames) {
      frameUnavailableSince ??= Date.now();
      if (Date.now() - frameUnavailableSince >= 1_500) {
        throw new DouyinVideoDecodeError("video-frames-unavailable");
      }
    } else {
      frameUnavailableSince = null;
    }
    await sleep(200);
  }
  const reason = lastState?.videoFound
    && Number.isFinite(lastState?.duration) && lastState.duration > 0
    && (!Number.isFinite(lastState?.videoWidth) || lastState.videoWidth < 2
      || !Number.isFinite(lastState?.videoHeight) || lastState.videoHeight < 2)
    ? "video-frames-unavailable"
    : lastState?.videoFound ? "decode-timeout" : "video-missing";
  throw new DouyinVideoDecodeError(reason);
}

export function buildScanFrameSignaturesExpression(times, {
  signatureWidth = 16,
  signatureHeight = 10,
  seekTimeoutMs = 2_500,
  maxWallTimeMs = DEFAULT_MAX_SCAN_WALL_TIME_MS,
  videoSelector = "video",
  playerActionMarker = null,
} = {}) {
  const sortedTimes = (Array.isArray(times) ? times : [])
    .filter((time) => Number.isFinite(time))
    .sort((left, right) => left - right);
  const safeTimes = sortedTimes.length <= MAX_SCAN_SAMPLE_COUNT
    ? sortedTimes
    : Array.from({ length: MAX_SCAN_SAMPLE_COUNT }, (_, index) => (
      sortedTimes[Math.round(index * (sortedTimes.length - 1) / (MAX_SCAN_SAMPLE_COUNT - 1))]
    ));
  const safeWidth = Math.max(4, Math.min(32, Math.trunc(signatureWidth) || 16));
  const safeHeight = Math.max(4, Math.min(32, Math.trunc(signatureHeight) || 10));
  const safeSeekTimeoutMs = Math.max(250, Math.min(5_000, Math.trunc(seekTimeoutMs) || 2_500));
  const safeWallTimeMs = boundedLimit(
    maxWallTimeMs,
    DEFAULT_MAX_SCAN_WALL_TIME_MS,
    DEFAULT_MAX_SCAN_WALL_TIME_MS,
    1_000,
  );
  const safeVideoSelector = typeof videoSelector === "string" && videoSelector.length <= 200
    ? videoSelector
    : "video";
  if (playerActionMarker !== null && !/^[0-9a-f]{64}$/u.test(playerActionMarker)) {
    throw new Error("A bounded player action marker is required for owned frame scanning.");
  }
  const videoLookup = playerActionMarker === null
    ? `const video = document.querySelector(${JSON.stringify(safeVideoSelector)});`
    : `const actionBinding = window.__codexDouyinPlayerActionV1;
    if (!actionBinding || actionBinding.marker !== ${JSON.stringify(playerActionMarker)}
        || !actionBinding.modal || !document.contains(actionBinding.modal)
        || !actionBinding.video || !document.contains(actionBinding.video)
        || !actionBinding.modal.contains(actionBinding.video)) {
      return { ok: false, reason: 'player-action-video-mismatch', samples: [] };
    }
    const video = actionBinding.video;`;
  return `(async () => {
    ${videoLookup}
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0
        || !Number.isFinite(video.videoWidth) || video.videoWidth < 2
        || !Number.isFinite(video.videoHeight) || video.videoHeight < 2) {
      return { ok: false, reason: 'video-not-ready', samples: [] };
    }
    video.muted = true;
    video.pause();
    const requestedTimes = ${JSON.stringify(safeTimes)};
    const canvas = document.createElement('canvas');
    canvas.width = ${safeWidth};
    canvas.height = ${safeHeight};
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    const deadline = performance.now() + ${safeWallTimeMs};
    const samples = [];
    let failedSeekCount = 0;
    let truncated = false;
    const seek = async (target, timeoutMs) => {
      if (Math.abs(video.currentTime - target) <= 0.03) return;
      await new Promise((resolve, reject) => {
        const onSeeked = () => {
          clearTimeout(timeout);
          resolve();
        };
        const timeout = setTimeout(() => {
          video.removeEventListener('seeked', onSeeked);
          reject(new Error('seek-timeout'));
        }, timeoutMs);
        video.addEventListener('seeked', onSeeked, { once: true });
        video.currentTime = target;
      });
    };
    const waitForPresentedFrame = async (frameDeadline) => {
      let presented = false;
      if (typeof video.requestVideoFrameCallback === 'function') {
        await new Promise((resolve) => {
          let callbackId = null;
          const timer = setTimeout(() => {
            if (callbackId !== null && typeof video.cancelVideoFrameCallback === 'function') {
              video.cancelVideoFrameCallback(callbackId);
            }
            resolve();
          }, Math.max(1, Math.min(300, frameDeadline - performance.now())));
          callbackId = video.requestVideoFrameCallback(() => {
            clearTimeout(timer);
            presented = true;
            resolve();
          });
        });
      }
      if (performance.now() >= frameDeadline) return presented;
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, Math.max(1, Math.min(120, frameDeadline - performance.now())));
        requestAnimationFrame(() => requestAnimationFrame(finish));
      });
      return presented;
    };
    const capture = async (requestedTime, captureDeadline = deadline) => {
      const target = Math.min(Math.max(0, requestedTime), Math.max(0, video.duration - 0.05));
      const remainingBeforeRender = captureDeadline - performance.now() - 250;
      if (remainingBeforeRender < 250) return null;
      try {
        await seek(target, Math.min(${safeSeekTimeoutMs}, remainingBeforeRender));
      } catch {
        failedSeekCount += 1;
        return null;
      }
      const presented = await waitForPresentedFrame(captureDeadline);
      if (performance.now() >= captureDeadline) return null;
      if (video.videoWidth < 2 || video.videoHeight < 2) return null;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const signature = [];
      let luminanceSum = 0;
      let maxLuminance = 0;
      let nonBlackPixels = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const luminance = (77 * pixels[offset] + 150 * pixels[offset + 1]
          + 29 * pixels[offset + 2]) >> 8;
        luminanceSum += luminance;
        maxLuminance = Math.max(maxLuminance, luminance);
        if (luminance > 8) nonBlackPixels += 1;
        signature.push(
          Math.max(0, Math.min(15, Math.round(pixels[offset] / 17))),
          Math.max(0, Math.min(15, Math.round(pixels[offset + 1] / 17))),
          Math.max(0, Math.min(15, Math.round(pixels[offset + 2] / 17)))
        );
      }
      const pixelCount = canvas.width * canvas.height;
      return {
        time: target,
        decoded: true,
        presented,
        signature,
        visual: {
          pixelCount,
          meanLuminance: luminanceSum / pixelCount,
          maxLuminance,
          nonBlackRatio: nonBlackPixels / pixelCount,
        },
      };
    };

    if (requestedTimes.length === 0) {
      return { ok: false, reason: 'no-scan-times', samples: [] };
    }
    const opening = await capture(requestedTimes[0]);
    if (opening) samples.push(opening);
    const hasDistinctEnding = requestedTimes.length > 1
      && requestedTimes.at(-1) - requestedTimes[0] >= 0.04;
    const interiorDeadline = deadline - ${safeSeekTimeoutMs} - 300;
    for (let index = 1; index < requestedTimes.length - Number(hasDistinctEnding); index += 1) {
      if (performance.now() >= interiorDeadline) {
        truncated = true;
        break;
      }
      const sample = await capture(requestedTimes[index], interiorDeadline);
      if (sample) samples.push(sample);
    }
    let ending = opening;
    if (hasDistinctEnding) {
      ending = await capture(requestedTimes.at(-1));
      if (ending) samples.push(ending);
    }
    const openingCaptured = Boolean(opening);
    const endingCaptured = Boolean(ending);
    return {
      ok: openingCaptured && endingCaptured,
      reason: openingCaptured && endingCaptured ? null : 'boundary-scan-failed',
      samples,
      failedSeekCount,
      truncated,
      openingCaptured,
      endingCaptured,
    };
  })()`;
}

export function buildCaptureFrameExpression(
  timeSeconds,
  maxDimension,
  seekTimeoutMs = 2_500,
  { videoSelector = "video", playerActionMarker = null } = {},
) {
  const safeMaxDimension = boundedLimit(maxDimension, 768, 768, 128);
  const safeSeekTimeoutMs = Math.max(250, Math.min(5_000, Math.trunc(seekTimeoutMs) || 2_500));
  const safeVideoSelector = typeof videoSelector === "string" && videoSelector.length <= 200
    ? videoSelector
    : "video";
  if (playerActionMarker !== null && !/^[0-9a-f]{64}$/u.test(playerActionMarker)) {
    throw new Error("A bounded player action marker is required for owned frame capture.");
  }
  const videoLookup = playerActionMarker === null
    ? `const video = document.querySelector(${JSON.stringify(safeVideoSelector)});`
    : `const actionBinding = window.__codexDouyinPlayerActionV1;
    if (!actionBinding || actionBinding.marker !== ${JSON.stringify(playerActionMarker)}
        || !actionBinding.modal || !document.contains(actionBinding.modal)
        || !actionBinding.video || !document.contains(actionBinding.video)
        || !actionBinding.modal.contains(actionBinding.video)) {
      return { ok: false, reason: 'player-action-video-mismatch' };
    }
    const video = actionBinding.video;`;
  return `(async () => {
    ${videoLookup}
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0
        || !Number.isFinite(video.videoWidth) || video.videoWidth < 2
        || !Number.isFinite(video.videoHeight) || video.videoHeight < 2) {
      return { ok: false, reason: 'video-not-ready' };
    }
    video.muted = true;
    video.pause();
    const target = Math.min(Math.max(0, ${JSON.stringify(timeSeconds)}), Math.max(0, video.duration - 0.05));
    if (Math.abs(video.currentTime - target) > 0.03) {
      await new Promise((resolve, reject) => {
        const onSeeked = () => {
          clearTimeout(timeout);
          resolve();
        };
        const timeout = setTimeout(() => {
          video.removeEventListener('seeked', onSeeked);
          reject(new Error('seek-timeout'));
        }, ${safeSeekTimeoutMs});
        video.addEventListener('seeked', onSeeked, { once: true });
        video.currentTime = target;
      });
    }
    const frameDeadline = performance.now() + ${safeSeekTimeoutMs + 700};
    let presented = false;
    if (typeof video.requestVideoFrameCallback === 'function') {
      await new Promise((resolve) => {
        let callbackId = null;
        const timer = setTimeout(() => {
          if (callbackId !== null && typeof video.cancelVideoFrameCallback === 'function') {
            video.cancelVideoFrameCallback(callbackId);
          }
          resolve();
        }, Math.max(1, Math.min(300, frameDeadline - performance.now())));
        callbackId = video.requestVideoFrameCallback(() => {
          clearTimeout(timer);
          presented = true;
          resolve();
        });
      });
    }
    if (performance.now() < frameDeadline) {
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, Math.max(1, Math.min(120, frameDeadline - performance.now())));
        requestAnimationFrame(() => requestAnimationFrame(finish));
      });
    }
    if (video.videoWidth < 2 || video.videoHeight < 2) {
      return { ok: false, reason: 'video-frames-unavailable' };
    }
    const scale = Math.min(
      1,
      ${JSON.stringify(safeMaxDimension)} / video.videoWidth,
      ${JSON.stringify(safeMaxDimension)} / video.videoHeight
    );
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    if (width < 2 || height < 2 || width * height > 768 * 768) {
      return { ok: false, reason: 'canvas-pixel-budget' };
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    context.drawImage(video, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    let luminanceSum = 0;
    let maxLuminance = 0;
    let nonBlackPixels = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const luminance = (77 * pixels[offset] + 150 * pixels[offset + 1]
        + 29 * pixels[offset + 2]) >> 8;
      luminanceSum += luminance;
      maxLuminance = Math.max(maxLuminance, luminance);
      if (luminance > 8) nonBlackPixels += 1;
    }
    const pixelCount = width * height;
    return {
      ok: true,
      time: target,
      width,
      height,
      decoded: true,
      presented,
      visual: {
        pixelCount,
        meanLuminance: luminanceSum / pixelCount,
        maxLuminance,
        nonBlackRatio: nonBlackPixels / pixelCount,
      },
      dataUrl: canvas.toDataURL('image/png'),
    };
  })()`;
}

export async function extractVideoMedia({
  port = 9229,
  videoPath,
  audioPath = path.join(path.dirname(videoPath), "audio.wav"),
  outputDirectory = path.dirname(videoPath),
  maxDimension = 768,
  maxVideoBytes = DEFAULT_MAX_VIDEO_BYTES,
  maxAudioBytes = DEFAULT_MAX_AUDIO_BYTES,
  maxAudioDurationSeconds = DEFAULT_MAX_AUDIO_DURATION_SECONDS,
  extractAudio = true,
  analyzeAudio = null,
  maxScanWallTimeMs = DEFAULT_MAX_SCAN_WALL_TIME_MS,
  maxCaptureWallTimeMs = DEFAULT_MAX_CAPTURE_WALL_TIME_MS,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  maxTotalFrameBytes = DEFAULT_MAX_TOTAL_FRAME_BYTES,
  maxOverallWallTimeMs = DEFAULT_DOWNLOAD_WALL_TIME_MS,
}) {
  const boundedOverallWallTimeMs = boundedLimit(
    maxOverallWallTimeMs,
    DEFAULT_DOWNLOAD_WALL_TIME_MS,
    DEFAULT_DOWNLOAD_WALL_TIME_MS,
  );
  const overallDeadline = Date.now() + boundedOverallWallTimeMs;
  const remainingTimeout = (maximumMs, minimumMs = 1) => {
    const remainingMs = overallDeadline - Date.now();
    if (remainingMs < minimumMs) {
      throw new DouyinMediaEvidenceError(
        DOUYIN_MEDIA_ERROR_CODES.BUDGET_EXCEEDED,
        "video-processing-wall-time",
      );
    }
    return Math.max(minimumMs, Math.min(maximumMs, remainingMs));
  };
  const versionResponse = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(remainingTimeout(3_000)),
  });
  if (!versionResponse.ok) throw new Error("Browser debugger version endpoint is unavailable.");
  const version = await versionResponse.json();
  if (!version.webSocketDebuggerUrl) throw new Error("Browser debugger endpoint is missing.");

  const browserCdp = new CdpClient(version.webSocketDebuggerUrl);
  const boundedMaxVideoBytes = boundedLimit(
    maxVideoBytes,
    DEFAULT_MAX_VIDEO_BYTES,
    DEFAULT_MAX_VIDEO_BYTES,
  );
  const boundedMaxAudioBytes = boundedLimit(
    maxAudioBytes,
    DEFAULT_MAX_AUDIO_BYTES,
    DEFAULT_MAX_AUDIO_BYTES,
  );
  const boundedMaxAudioDurationSeconds = boundedLimit(
    maxAudioDurationSeconds,
    DEFAULT_MAX_AUDIO_DURATION_SECONDS,
    DEFAULT_MAX_AUDIO_DURATION_SECONDS,
  );
  const mediaServer = await startLocalVideoServer(
    videoPath,
    audioPath,
    boundedMaxAudioBytes,
    boundedMaxVideoBytes,
  );
  let targetId;
  let pageCdp;
  try {
    await browserCdp.connect(remainingTimeout(5_000));
    const created = await browserCdp.request(
      "Target.createTarget",
      buildLocalVideoTargetOptions(mediaServer.url),
      remainingTimeout(10_000),
    );
    targetId = created?.targetId;
    if (!targetId) throw new Error("Browser did not create a temporary video target.");
    const target = await waitForTarget(port, targetId, remainingTimeout(10_000));
    pageCdp = new CdpClient(target.webSocketDebuggerUrl);
    await pageCdp.connect(remainingTimeout(5_000));
    await enableLocalVideoBackgroundDecoding(pageCdp, remainingTimeout(5_000));
    const state = await waitForLocalVideo(pageCdp, remainingTimeout(20_000));
    let audio = { ok: false, reason: "audio-extraction-unavailable" };
    if (extractAudio) {
      try {
        audio = await pageCdp.evaluate(buildExtractAudioExpression({
          uploadPath: mediaServer.audioUploadPath,
          maxAudioBytes: boundedMaxAudioBytes,
          maxDurationSeconds: boundedMaxAudioDurationSeconds,
        }), remainingTimeout(120_000));
      } catch {
        audio = { ok: false, reason: "audio-extraction-timeout" };
        pageCdp.close();
        pageCdp = undefined;
        await closeTemporaryTarget(browserCdp, port, targetId);
        targetId = undefined;
        const recreated = await browserCdp.request(
          "Target.createTarget",
          buildLocalVideoTargetOptions(mediaServer.url),
          remainingTimeout(10_000),
        );
        targetId = recreated?.targetId;
        if (!targetId) throw new Error("Browser did not recreate the temporary video target.");
        const recreatedTarget = await waitForTarget(port, targetId, remainingTimeout(10_000));
        pageCdp = new CdpClient(recreatedTarget.webSocketDebuggerUrl);
        await pageCdp.connect(remainingTimeout(5_000));
        await enableLocalVideoBackgroundDecoding(pageCdp, remainingTimeout(5_000));
        await waitForLocalVideo(pageCdp, remainingTimeout(20_000));
      }
      if (audio?.ok) await stat(audioPath);
    } else {
      audio = { ok: false, reason: "audio-extraction-disabled" };
    }

    let audioUnderstanding = null;
    if (audio?.ok && typeof analyzeAudio === "function") {
      try {
        const result = await analyzeAudio({
          audioPath,
          durationSeconds: audio.processedDuration,
          truncated: Boolean(audio.truncated),
          timeoutMs: remainingTimeout(120_000, 1_000),
        });
        audioUnderstanding = result && typeof result === "object"
          ? result
          : { processed: false, reason: "transcription-invalid-result" };
      } catch {
        audioUnderstanding = { processed: false, reason: "transcription-failed" };
      }
    }

    const framePlan = getAdaptiveFramePlan(state.duration);
    const timedSegments = audioUnderstanding?.timingSource === "fsmn-vad-srt"
      ? audioUnderstanding.segments
      : [];
    const audioAnchors = buildAudioAnchorsFromSegments(timedSegments, state.duration);
    const scanTimes = buildAdaptiveScanTimes(state.duration, {
      scanBudget: framePlan.scanBudget,
      audioAnchors,
    });
    const boundedScanWallTimeMs = Math.max(
      1_000,
      Math.min(
        DEFAULT_MAX_SCAN_WALL_TIME_MS,
        Math.trunc(maxScanWallTimeMs) || DEFAULT_MAX_SCAN_WALL_TIME_MS,
      ),
    );
    const scan = await pageCdp.evaluate(buildScanFrameSignaturesExpression(scanTimes, {
      maxWallTimeMs: boundedScanWallTimeMs,
    }), remainingTimeout(boundedScanWallTimeMs + 10_000));
    if (!scan?.ok || !Array.isArray(scan.samples) || scan.samples.length === 0) {
      throw new Error(`Could not scan video scenes: ${scan?.reason || "unknown"}.`);
    }
    const scanVisuals = assertUsableVideoFrameVisuals(scan.samples, "blank-video-scan");
    const selection = selectAdaptiveFrameSamples({
      samples: scan.samples,
      durationSeconds: state.duration,
      frameBudget: framePlan.frameBudget,
      audioAnchors,
    });

    await mkdir(outputDirectory, { recursive: true });
    const boundedCaptureWallTimeMs = Math.max(
      1_000,
      Math.min(
        DEFAULT_MAX_CAPTURE_WALL_TIME_MS,
        Math.trunc(maxCaptureWallTimeMs) || DEFAULT_MAX_CAPTURE_WALL_TIME_MS,
      ),
    );
    const captureDeadline = Math.min(
      overallDeadline,
      Date.now() + boundedCaptureWallTimeMs,
    );
    const boundedFrameBytes = Math.max(
      64 * 1024,
      Math.min(DEFAULT_MAX_FRAME_BYTES, Math.trunc(maxFrameBytes) || DEFAULT_MAX_FRAME_BYTES),
    );
    const boundedTotalFrameBytes = Math.max(
      boundedFrameBytes,
      Math.min(
        DEFAULT_MAX_TOTAL_FRAME_BYTES,
        Math.trunc(maxTotalFrameBytes) || DEFAULT_MAX_TOTAL_FRAME_BYTES,
      ),
    );
    const framePaths = [];
    const frameTimes = [];
    const capturedFrames = [];
    let totalFrameBytes = 0;
    for (const selected of selection.selected) {
      if (Date.now() >= captureDeadline) {
        throw new Error("Video keyframe capture exceeded its wall-time limit.");
      }
      const frame = await pageCdp.evaluate(
        buildCaptureFrameExpression(selected.time, maxDimension),
        Math.min(5_000, Math.max(1_000, captureDeadline - Date.now() + 500)),
      );
      if (!frame?.ok || !frame.dataUrl?.startsWith("data:image/png;base64,")) {
        throw new Error(`Could not capture a video keyframe: ${frame?.reason}.`);
      }
      const frameBytes = Buffer.from(
        frame.dataUrl.slice("data:image/png;base64,".length),
        "base64",
      );
      assertCapturedVideoFrame(frame, frameBytes);
      if (frameBytes.byteLength > boundedFrameBytes) {
        throw new Error("A captured video keyframe exceeded its byte limit.");
      }
      totalFrameBytes += frameBytes.byteLength;
      if (totalFrameBytes > boundedTotalFrameBytes) {
        throw new Error("Captured video keyframes exceeded their total byte limit.");
      }
      const framePath = path.join(
        outputDirectory,
        `frame-${String(framePaths.length + 1).padStart(2, "0")}.png`,
      );
      await writeFile(framePath, frameBytes, { flag: "wx" });
      framePaths.push(framePath);
      frameTimes.push(selected.time);
      capturedFrames.push(frame);
    }
    const captureVisuals = assertUsableVideoFrameVisuals(capturedFrames);
    for (const framePath of framePaths) await stat(framePath);
    return {
      framePaths,
      frameTimes,
      duration: state.duration,
      videoWidth: state.videoWidth,
      videoHeight: state.videoHeight,
      audioPath: audio?.ok ? audioPath : null,
      audioAvailable: Boolean(audio?.ok),
      audioReason: audio?.ok ? null : (audio?.reason || "audio-extraction-failed"),
      audioDuration: audio?.ok ? audio.processedDuration : null,
      audioTruncated: Boolean(audio?.truncated),
      audioUnderstanding,
      sampling: {
        frameBudget: framePlan.frameBudget,
        scanBudget: framePlan.scanBudget,
        requestedScanCount: scanTimes.length,
        completedScanCount: scan.samples.length,
        failedSeekCount: scan.failedSeekCount || 0,
        scanTruncated: Boolean(scan.truncated),
        selectedFrameCount: framePaths.length,
        audioAnchorCount: audioAnchors.length,
        sceneThreshold: selection.sceneThreshold,
        totalFrameBytes,
        blankScanFrameCount: scanVisuals.blankFrameCount,
        blankCapturedFrameCount: captureVisuals.blankFrameCount,
      },
    };
  } catch (error) {
    if (error instanceof DouyinMediaEvidenceError) throw error;
    const message = String(error?.message || "").toLowerCase();
    if (message.includes("wall-time") || message.includes("timed out")) {
      throw new DouyinMediaEvidenceError(
        DOUYIN_MEDIA_ERROR_CODES.BUDGET_EXCEEDED,
        "video-processing-wall-time",
      );
    }
    if (message.includes("byte limit") || message.includes("size limit")
        || message.includes("canvas-pixel-budget")) {
      throw new DouyinMediaEvidenceError(
        DOUYIN_MEDIA_ERROR_CODES.RESOURCE_LIMIT,
        "video-processing-size-limit",
      );
    }
    if (message.includes("canvas") || message.includes("securityerror")
        || message.includes("tainted")) {
      throw new DouyinMediaEvidenceError(
        DOUYIN_MEDIA_ERROR_CODES.CANVAS_SECURITY,
        "video-canvas-unavailable",
      );
    }
    if (message.includes("scan video scenes") || message.includes("capture a video keyframe")) {
      throw new DouyinVideoDecodeError("no-decoded-frame-within-deadline");
    }
    throw new DouyinMediaEvidenceError(
      DOUYIN_MEDIA_ERROR_CODES.INTERNAL,
      "video-processing-internal",
    );
  } finally {
    const cleanupErrors = [];
    pageCdp?.close();
    if (targetId) {
      try {
        await closeTemporaryTarget(browserCdp, port, targetId);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    browserCdp.close();
    try {
      await mediaServer.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Temporary video resource cleanup failed.");
    }
  }
}
