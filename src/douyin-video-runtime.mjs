import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import https from "node:https";
import { createServer } from "node:http";
import path from "node:path";
import { CdpClient } from "./cdp-client.mjs";
import { buildReadCompatibleAwemeSourceExpression } from "./douyin-chat-page.mjs";
import {
  buildAdaptiveScanTimes,
  buildAudioAnchorsFromSegments,
  getAdaptiveFramePlan,
  MAX_SCAN_SAMPLE_COUNT,
  selectAdaptiveFrameSamples,
} from "./video-frame-selection.mjs";

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
const MAX_VIDEO_SOURCE_CANDIDATES = 4;
const MAX_VIDEO_SOURCE_REDIRECTS = 2;
const VIDEO_JOB_NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function boundedLimit(value, fallback, hardMaximum, minimum = 1) {
  const normalized = Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(minimum, Math.min(hardMaximum, normalized));
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
  let request;
  let response;
  let handle;
  let createdDestination = false;
  let byteCount = 0;
  let wallTimer;
  let wallTimeExpired = false;
  try {
    const deadline = Date.now() + boundedWallTimeMs;
    wallTimer = setTimeout(() => {
      wallTimeExpired = true;
      const error = new Error("Douyin media download exceeded its wall-time limit.");
      response?.destroy(error);
      request?.destroy(error);
    }, boundedWallTimeMs);

    let currentSource = source;
    ({ request, response, finalSource: currentSource } = await openDouyinVideoResponse({
      source,
      timeoutMs: boundedTimeoutMs,
      requestFn: (rangeSource, options, callback) => requestFn(rangeSource, {
        ...options,
        headers: { ...options.headers, Range: "bytes=0-0" },
      }, callback),
    }));
    if (response.statusCode !== 206) {
      throw new Error(`Douyin media download failed with HTTP ${response.statusCode}.`);
    }
    const contentType = String(response.headers["content-type"] || "");
    if (!contentType.startsWith("video/") && contentType !== "application/octet-stream") {
      throw new Error("Douyin media response was not a video.");
    }
    const probeRange = parseDouyinContentRange(response.headers["content-range"]);
    if (!probeRange || probeRange.start !== 0 || probeRange.end !== 0) {
      throw new Error("Douyin media did not honor the bounded range probe.");
    }
    if (probeRange.total > boundedMaxBytes) {
      throw new Error("Douyin video exceeds the local size limit.");
    }
    let probeBytes = 0;
    for await (const value of response) probeBytes += value.byteLength;
    if (probeBytes !== 1) throw new Error("Douyin media returned an invalid range probe.");

    handle = await open(destination, "wx");
    createdDestination = true;
    for (let start = 0; start < probeRange.total; start += VIDEO_RANGE_CHUNK_BYTES) {
      if (wallTimeExpired || Date.now() >= deadline) {
        throw new Error("Douyin media download exceeded its wall-time limit.");
      }
      const end = Math.min(probeRange.total - 1, start + VIDEO_RANGE_CHUNK_BYTES - 1);
      ({ request, response, finalSource: currentSource } = await openDouyinVideoResponse({
        source: currentSource,
        timeoutMs: Math.min(boundedTimeoutMs, Math.max(1_000, deadline - Date.now())),
        requestFn: (rangeSource, options, callback) => requestFn(rangeSource, {
          ...options,
          headers: { ...options.headers, Range: `bytes=${start}-${end}` },
        }, callback),
      }));
      if (response.statusCode !== 206) {
        throw new Error(`Douyin media range download failed with HTTP ${response.statusCode}.`);
      }
      const returnedRange = parseDouyinContentRange(response.headers["content-range"]);
      if (!returnedRange || returnedRange.start !== start || returnedRange.end !== end
          || returnedRange.total !== probeRange.total) {
        throw new Error("Douyin media returned an unexpected byte range.");
      }
      const expectedBytes = end - start + 1;
      let receivedBytes = 0;
      for await (const value of response) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        receivedBytes += chunk.byteLength;
        byteCount += chunk.byteLength;
        if (receivedBytes > expectedBytes || byteCount > boundedMaxBytes) {
          throw new Error("Douyin video exceeds the local size limit.");
        }
        await handle.write(chunk);
      }
      if (receivedBytes !== expectedBytes) {
        throw new Error("Douyin media returned an incomplete byte range.");
      }
    }
    if (byteCount !== probeRange.total) throw new Error("Douyin video download was incomplete.");
    await handle.close();
    handle = null;
    return { byteCount, contentType };
  } catch (error) {
    response?.destroy();
    request?.destroy();
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
    throw new Error("The Douyin video has no trusted compatible source candidate.");
  }
  const deadline = Date.now() + DEFAULT_DOWNLOAD_WALL_TIME_MS;
  for (const source of candidates) {
    const remainingWallTimeMs = deadline - Date.now();
    if (remainingWallTimeMs < 1_000) break;
    try {
      return await downloadFn({
        source,
        destination,
        timeoutMs: VIDEO_SOURCE_ATTEMPT_TIMEOUT_MS,
        maxWallTimeMs: remainingWallTimeMs,
      });
    } catch {}
  }
  throw new Error("Every compatible Douyin video source failed.");
}

export async function prepareLatestDouyinVideoMedia({
  cdp,
  projectRoot,
  port = 9229,
  analyzeAudio = null,
  sourceResult = null,
}) {
  const resolvedSource = sourceResult ?? await cdp.evaluate(buildReadCompatibleAwemeSourceExpression());
  if (!resolvedSource?.ok) {
    throw new Error(`The latest Douyin video has no trusted compatible source: ${resolvedSource?.reason}.`);
  }
  const job = await createVideoAnalysisJob(projectRoot);
  try {
    const download = await downloadCompatibleDouyinVideo({
      sourceResult: resolvedSource,
      destination: job.videoPath,
    });
    const media = await extractVideoMedia({
      port,
      videoPath: job.videoPath,
      audioPath: job.audioPath,
      outputDirectory: job.jobDirectory,
      analyzeAudio,
    });
    return { ...job, ...download, ...media };
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
        ready: video.readyState >= 2 && Number.isFinite(video.duration) && video.duration > 0,
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
    if (state?.errorCode) throw new Error(`Local video decode failed with code ${state.errorCode}.`);
    if (state?.ready) return state;
    await sleep(200);
  }
  throw new Error(`Timed out decoding the temporary local video: ${JSON.stringify(lastState)}.`);
}

export function buildScanFrameSignaturesExpression(times, {
  signatureWidth = 16,
  signatureHeight = 10,
  seekTimeoutMs = 2_500,
  maxWallTimeMs = DEFAULT_MAX_SCAN_WALL_TIME_MS,
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
  return `(async () => {
    const video = document.querySelector('video');
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) {
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
      await Promise.race([
        new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        new Promise((resolve) => setTimeout(resolve, 250)),
      ]);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const signature = [];
      for (let offset = 0; offset < pixels.length; offset += 4) {
        signature.push(
          Math.max(0, Math.min(15, Math.round(pixels[offset] / 17))),
          Math.max(0, Math.min(15, Math.round(pixels[offset + 1] / 17))),
          Math.max(0, Math.min(15, Math.round(pixels[offset + 2] / 17)))
        );
      }
      return { time: target, signature };
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

export function buildCaptureFrameExpression(timeSeconds, maxDimension, seekTimeoutMs = 2_500) {
  const safeMaxDimension = boundedLimit(maxDimension, 768, 768, 128);
  const safeSeekTimeoutMs = Math.max(250, Math.min(5_000, Math.trunc(seekTimeoutMs) || 2_500));
  return `(async () => {
    const video = document.querySelector('video');
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) {
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
    await Promise.race([
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      new Promise((resolve) => setTimeout(resolve, 250)),
    ]);
    const scale = Math.min(
      1,
      ${JSON.stringify(safeMaxDimension)} / video.videoWidth,
      ${JSON.stringify(safeMaxDimension)} / video.videoHeight
    );
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    context.drawImage(video, 0, 0, width, height);
    return {
      ok: true,
      time: target,
      width,
      height,
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
}) {
  const versionResponse = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(3_000),
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
    await browserCdp.connect();
    const created = await browserCdp.request("Target.createTarget", {
      url: mediaServer.url,
      background: false,
    }, 10_000);
    targetId = created?.targetId;
    if (!targetId) throw new Error("Browser did not create a temporary video target.");
    const target = await waitForTarget(port, targetId);
    pageCdp = new CdpClient(target.webSocketDebuggerUrl);
    await pageCdp.connect();
    const state = await waitForLocalVideo(pageCdp);
    let audio = { ok: false, reason: "audio-extraction-unavailable" };
    if (extractAudio) {
      try {
        audio = await pageCdp.evaluate(buildExtractAudioExpression({
          uploadPath: mediaServer.audioUploadPath,
          maxAudioBytes: boundedMaxAudioBytes,
          maxDurationSeconds: boundedMaxAudioDurationSeconds,
        }), 120_000);
      } catch {
        audio = { ok: false, reason: "audio-extraction-timeout" };
        pageCdp.close();
        pageCdp = undefined;
        await closeTemporaryTarget(browserCdp, port, targetId);
        targetId = undefined;
        const recreated = await browserCdp.request("Target.createTarget", {
          url: mediaServer.url,
          background: false,
        }, 10_000);
        targetId = recreated?.targetId;
        if (!targetId) throw new Error("Browser did not recreate the temporary video target.");
        const recreatedTarget = await waitForTarget(port, targetId);
        pageCdp = new CdpClient(recreatedTarget.webSocketDebuggerUrl);
        await pageCdp.connect();
        await waitForLocalVideo(pageCdp);
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
    }), boundedScanWallTimeMs + 10_000);
    if (!scan?.ok || !Array.isArray(scan.samples) || scan.samples.length === 0) {
      throw new Error(`Could not scan video scenes: ${scan?.reason || "unknown"}.`);
    }
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
    const captureDeadline = Date.now() + boundedCaptureWallTimeMs;
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
    }
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
      },
    };
  } catch (error) {
    throw new Error(`${error.message} Local server stats: ${JSON.stringify(mediaServer.getStats())}.`);
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
