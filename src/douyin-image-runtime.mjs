import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { CdpClient } from "./cdp-client.mjs";
import {
  buildLocateLatestIncomingChatImageExpression,
  buildReadIncomingNativeStickerSourcesExpression,
  buildReadLatestIncomingChatImageSourceExpression,
} from "./douyin-chat-page.mjs";
import { isTrustedDouyinMediaUrl } from "./douyin-video-runtime.mjs";

const IMAGE_JOB_NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_STICKER_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_IMAGE_BYTES = 64 * 1024 * 1024;
const DEFAULT_IMAGE_POST_WALL_TIME_MS = 150_000;
const MAX_IMAGE_SOURCE_CANDIDATES = 4;
const MAX_IMAGE_DOWNLOAD_CONCURRENCY = 3;
const NATIVE_STICKER_WALL_TIME_MS = 60_000;

export class DouyinNativeStickerUnavailableError extends Error {
  constructor(reason = "native-sticker-unavailable") {
    super("Douyin native sticker visual evidence is unavailable.");
    this.name = "DouyinNativeStickerUnavailableError";
    this.reason = /^[a-z0-9-]{1,80}$/u.test(reason) ? reason : "native-sticker-unavailable";
  }
}

export function resolveImageAnalysisRoot(projectRoot) {
  return path.resolve(projectRoot, ".runtime", "image-analysis");
}

export function assertImageAnalysisJobPath(projectRoot, jobDirectory) {
  const root = resolveImageAnalysisRoot(projectRoot);
  const resolved = path.resolve(jobDirectory);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Refusing an image-analysis path outside its dedicated runtime root.");
  }
  return resolved;
}

export async function removeImageAnalysisJob(projectRoot, jobDirectory) {
  const resolved = assertImageAnalysisJobPath(projectRoot, jobDirectory);
  await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export async function cleanupStaleImageAnalysisJobs(projectRoot, {
  minimumAgeMs = 2 * 60 * 60 * 1_000,
  now = Date.now(),
} = {}) {
  const root = resolveImageAnalysisRoot(projectRoot);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  let removedCount = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !IMAGE_JOB_NAME_PATTERN.test(entry.name)) continue;
    const jobDirectory = path.join(root, entry.name);
    const jobStat = await stat(jobDirectory);
    if (now - jobStat.mtimeMs < minimumAgeMs) continue;
    await removeImageAnalysisJob(projectRoot, jobDirectory);
    removedCount += 1;
  }
  return removedCount;
}

function validateClip(clip) {
  const values = [clip?.x, clip?.y, clip?.width, clip?.height, clip?.scale];
  if (!values.every(Number.isFinite)
      || clip.x < 0 || clip.y < 0
      || clip.width < 16 || clip.height < 16
      || clip.width > 2048 || clip.height > 2048
      || clip.scale !== 1) {
    throw new Error("Douyin returned an invalid chat-image capture boundary.");
  }
  return {
    x: clip.x,
    y: clip.y,
    width: clip.width,
    height: clip.height,
    scale: 1,
  };
}

function decodePng(data, maxBytes) {
  if (typeof data !== "string" || data.length === 0
      || data.length > Math.ceil(maxBytes / 3) * 4 + 4
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) {
    throw new Error("Douyin chat-image capture was not bounded PNG data.");
  }
  const image = Buffer.from(data, "base64");
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (image.length === 0 || image.length > maxBytes || !image.subarray(0, 8).equals(pngSignature)) {
    throw new Error("Douyin chat-image capture was not a valid bounded PNG.");
  }
  return image;
}

function validatePngDimensions(image, maxDimension = 768) {
  if (!Buffer.isBuffer(image) || image.length < 24
      || image.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("Douyin capture PNG dimensions are unavailable.");
  }
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  if (width < 1 || height < 1 || width > maxDimension || height > maxDimension) {
    throw new Error("Douyin capture PNG dimensions exceed the bounded image size.");
  }
  return { width, height };
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForTemporaryTarget(port, targetId, timeoutMs = 10_000) {
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
  throw new Error("Timed out waiting for the temporary native-sticker target.");
}

async function closeTemporaryTarget(browserCdp, port, targetId) {
  if (!targetId) return;
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error("Browser target list is unavailable during cleanup.");
  const targets = await response.json();
  if (!targets.some((target) => target.id === targetId)) return;
  const result = await browserCdp.request("Target.closeTarget", { targetId }, 5_000);
  if (result?.success === false) throw new Error("Browser refused to close the native-sticker target.");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const listResponse = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!listResponse.ok) throw new Error("Browser target list is unavailable during cleanup.");
    const remaining = await listResponse.json();
    if (!remaining.some((target) => target.id === targetId)) return;
    await sleep(100);
  }
  throw new Error("Native-sticker target remained open after close confirmation.");
}

async function startNativeStickerNormalizerServer(images) {
  if (!Array.isArray(images) || images.length === 0 || images.length > 12
      || images.some((image) => !Buffer.isBuffer(image) || image.length === 0)) {
    throw new Error("Native-sticker normalizer images are invalid.");
  }
  const html = `<!doctype html><meta charset=utf-8><title>Local native sticker normalizer</title>${
    images.map((_, index) => `<img src="/sticker-${index}.webp">`).join("")
  }`;
  const server = createServer((request, response) => {
    if ((request.method === "GET" || request.method === "HEAD") && request.url === "/index.html") {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Length": String(Buffer.byteLength(html)),
        "Content-Security-Policy": "default-src 'self'; img-src 'self'; style-src 'none'; script-src 'none'",
        "Content-Type": "text/html; charset=utf-8",
      });
      response.end(request.method === "HEAD" ? undefined : html);
      return;
    }
    const match = /^\/sticker-(\d{1,2})\.webp$/u.exec(request.url || "");
    const index = match ? Number.parseInt(match[1], 10) : -1;
    if ((request.method !== "GET" && request.method !== "HEAD")
        || index < 0 || index >= images.length) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": String(images[index].length),
      "Content-Type": "image/webp",
    });
    response.end(request.method === "HEAD" ? undefined : images[index]);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Native-sticker normalizer address is unavailable.");
  }
  return {
    url: `http://127.0.0.1:${address.port}/index.html`,
    close: async () => {
      const closed = new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      server.closeAllConnections();
      await closed;
    },
  };
}

async function normalizeWebpStickerImages({ images, port, maxBytes }) {
  const versionResponse = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!versionResponse.ok) throw new Error("Browser debugger version endpoint is unavailable.");
  const version = await versionResponse.json();
  if (!version.webSocketDebuggerUrl) throw new Error("Browser debugger endpoint is missing.");
  const server = await startNativeStickerNormalizerServer(images);
  const browserCdp = new CdpClient(version.webSocketDebuggerUrl);
  let pageCdp;
  let targetId;
  try {
    await browserCdp.connect();
    const created = await browserCdp.request("Target.createTarget", {
      url: server.url,
      background: true,
      hidden: true,
    }, 10_000);
    targetId = created?.targetId;
    if (!targetId) throw new Error("Browser did not create a native-sticker target.");
    const target = await waitForTemporaryTarget(port, targetId);
    pageCdp = new CdpClient(target.webSocketDebuggerUrl);
    await pageCdp.connect();
    await pageCdp.request("Emulation.setFocusEmulationEnabled", { enabled: true }, 5_000);
    const encoded = await pageCdp.evaluate(`(async () => {
      const deadline = Date.now() + 10_000;
      while (document.images.length !== ${images.length} && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const images = Array.from(document.images).slice(0, 12);
      if (images.length !== ${images.length}) return { ok: false, reason: 'image-count-changed' };
      await Promise.all(images.map((image) => image.decode()));
      const outputs = [];
      for (const image of images) {
        if (image.naturalWidth < 1 || image.naturalHeight < 1
            || image.naturalWidth > 768 || image.naturalHeight > 768) {
          return { ok: false, reason: 'image-dimensions-invalid' };
        }
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d', { alpha: true });
        if (!context) return { ok: false, reason: 'canvas-context-unavailable' };
        context.drawImage(image, 0, 0);
        const data = canvas.toDataURL('image/png');
        if (!data.startsWith('data:image/png;base64,')) {
          return { ok: false, reason: 'png-conversion-failed' };
        }
        outputs.push(data.slice('data:image/png;base64,'.length));
      }
      return { ok: true, outputs };
    })()`, 20_000);
    if (!encoded?.ok || !Array.isArray(encoded.outputs)
        || encoded.outputs.length !== images.length) {
      throw new Error("Native-sticker WebP normalization failed.");
    }
    return encoded.outputs.map((data) => {
      const image = decodePng(data, maxBytes);
      validatePngDimensions(image);
      return image;
    });
  } finally {
    pageCdp?.close();
    try {
      await closeTemporaryTarget(browserCdp, port, targetId);
    } finally {
      browserCdp.close();
      await server.close();
    }
  }
}

function decodeEmbeddedImage(source, maxBytes) {
  if (typeof source !== "string" || !source.startsWith("data:")) return null;
  if (source.startsWith("data:image/webp;base64,")) return null;
  if (source.length > Math.ceil(maxBytes / 3) * 4 + 64) {
    throw new Error("Douyin embedded chat image exceeds the local size limit.");
  }
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(source);
  if (!match) throw new Error("Douyin embedded chat image format is unsupported.");
  const [, contentType, data] = match;
  const image = Buffer.from(data, "base64");
  const header = image.subarray(0, 12);
  if (image.length === 0 || image.length > maxBytes || !hasImageSignature(header, contentType)) {
    throw new Error("Douyin embedded chat image has invalid image data.");
  }
  return { image, contentType };
}

export async function captureLatestDouyinChatImage({
  cdp,
  projectRoot,
  mediaMessage = null,
  maxBytes = DEFAULT_MAX_IMAGE_BYTES,
  fetchFn = fetch,
}) {
  if (!cdp || typeof cdp.evaluate !== "function" || typeof cdp.request !== "function") {
    throw new Error("A connected CDP client is required for chat-image capture.");
  }
  const boundedMaxBytes = Math.max(64 * 1024, Math.min(
    DEFAULT_MAX_IMAGE_BYTES,
    Number.isFinite(maxBytes) ? Math.trunc(maxBytes) : DEFAULT_MAX_IMAGE_BYTES,
  ));
  const sourceResult = await cdp.evaluate(
    buildReadLatestIncomingChatImageSourceExpression(mediaMessage),
  );
  let embeddedImage = null;
  let sourceDownloadError = null;
  if (sourceResult?.ok) {
    try {
      embeddedImage = decodeEmbeddedImage(sourceResult.source, boundedMaxBytes);
    } catch (error) {
      sourceDownloadError = error;
    }
  }
  if (embeddedImage) {
    const root = resolveImageAnalysisRoot(projectRoot);
    const jobDirectory = path.join(root, randomUUID());
    const imagePath = path.join(
      jobDirectory,
      `chat-image${extensionForImageContentType(embeddedImage.contentType)}`,
    );
    try {
      await mkdir(jobDirectory, { recursive: true });
      await writeFile(imagePath, embeddedImage.image, { flag: "wx" });
      return {
        jobDirectory,
        imagePaths: [imagePath],
        byteCount: embeddedImage.image.length,
      };
    } catch (error) {
      await removeImageAnalysisJob(projectRoot, jobDirectory).catch(() => {});
      throw error;
    }
  }
  if (sourceResult?.ok && isTrustedDouyinMediaUrl(sourceResult.source)) {
    const root = resolveImageAnalysisRoot(projectRoot);
    const jobDirectory = path.join(root, randomUUID());
    const temporaryPath = path.join(jobDirectory, "chat-image.download");
    try {
      await mkdir(jobDirectory, { recursive: true });
      const download = await downloadDouyinImage({
        source: sourceResult.source,
        destination: temporaryPath,
        maxBytes: boundedMaxBytes,
        fetchFn,
      });
      if (download.contentType === "image/webp") {
        throw new Error("Direct Douyin chat images must be normalized to PNG or JPEG.");
      }
      const imagePath = `${temporaryPath}${extensionForImageContentType(download.contentType)}`;
      await rename(temporaryPath, imagePath);
      return {
        jobDirectory,
        imagePaths: [imagePath],
        byteCount: download.byteCount,
      };
    } catch (error) {
      sourceDownloadError = error;
      await removeImageAnalysisJob(projectRoot, jobDirectory).catch(() => {});
    }
  }
  const location = await cdp.evaluate(buildLocateLatestIncomingChatImageExpression(mediaMessage));
  if (!location?.ok) {
    throw new Error(`The latest Douyin chat image is unavailable: ${location?.reason || "unknown"}.`);
  }
  const clip = validateClip(location.clip);
  let capture;
  try {
    capture = await cdp.request("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip,
    }, 30_000);
  } catch (error) {
    if (sourceDownloadError) {
      throw new AggregateError(
        [sourceDownloadError, error],
        "Douyin chat image could not be downloaded or captured.",
      );
    }
    throw error;
  }
  const image = decodePng(capture?.data, boundedMaxBytes);
  const root = resolveImageAnalysisRoot(projectRoot);
  const jobDirectory = path.join(root, randomUUID());
  const imagePath = path.join(jobDirectory, "chat-image.png");
  try {
    await mkdir(jobDirectory, { recursive: true });
    await writeFile(imagePath, image, { flag: "wx" });
    return { jobDirectory, imagePaths: [imagePath], byteCount: image.length };
  } catch (error) {
    await removeImageAnalysisJob(projectRoot, jobDirectory).catch(() => {});
    throw error;
  }
}

export async function captureDouyinNativeSticker({
  cdp,
  projectRoot,
  mediaMessage,
  port = 9229,
  maxBytes = DEFAULT_MAX_STICKER_BYTES,
  fetchFn = fetch,
  normalizeWebpImages = normalizeWebpStickerImages,
}) {
  if (!cdp || typeof cdp.evaluate !== "function") {
    throw new Error("A connected CDP client is required for native-sticker capture.");
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("The native-sticker debugger port is invalid.");
  }
  const boundedMaxBytes = Math.max(64 * 1024, Math.min(
    DEFAULT_MAX_STICKER_BYTES,
    Number.isFinite(maxBytes) ? Math.trunc(maxBytes) : DEFAULT_MAX_STICKER_BYTES,
  ));
  const sourceResult = await cdp.evaluate(
    buildReadIncomingNativeStickerSourcesExpression(mediaMessage),
  );
  if (!sourceResult?.ok || !Array.isArray(sourceResult.sources)
      || sourceResult.sources.length < 1 || sourceResult.sources.length > 12
      || sourceResult.sources.some((source) => (
        typeof source !== "string" || !isTrustedDouyinMediaUrl(source)
      ))) {
    throw new DouyinNativeStickerUnavailableError(sourceResult?.reason);
  }
  const root = resolveImageAnalysisRoot(projectRoot);
  const jobDirectory = path.join(root, randomUUID());
  const deadline = Date.now() + NATIVE_STICKER_WALL_TIME_MS;
  try {
    await mkdir(jobDirectory, { recursive: true });
    const records = [];
    let downloadedBytes = 0;
    for (let index = 0; index < sourceResult.sources.length; index += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error("Native-sticker acquisition exceeded its wall time.");
      const temporaryPath = path.join(
        jobDirectory,
        `native-sticker-${String(index + 1).padStart(2, "0")}.download`,
      );
      const download = await downloadDouyinImage({
        source: sourceResult.sources[index],
        destination: temporaryPath,
        maxBytes: boundedMaxBytes,
        fetchFn,
        timeoutMs: Math.min(30_000, remainingMs),
      });
      downloadedBytes += download.byteCount;
      if (downloadedBytes > DEFAULT_MAX_TOTAL_IMAGE_BYTES) {
        throw new Error("Native-sticker assets exceed the total size limit.");
      }
      const sourcePath = `${temporaryPath}${extensionForImageContentType(download.contentType)}`;
      await rename(temporaryPath, sourcePath);
      records.push({ contentType: download.contentType, sourcePath, byteCount: download.byteCount });
    }
    const webpRecords = records.filter((record) => record.contentType === "image/webp");
    if (webpRecords.length > 0) {
      const webpImages = await Promise.all(webpRecords.map((record) => readFile(record.sourcePath)));
      const normalizedImages = await normalizeWebpImages({
        images: webpImages,
        port,
        maxBytes: boundedMaxBytes,
      });
      for (let index = 0; index < webpRecords.length; index += 1) {
        const record = webpRecords[index];
        const normalizedPath = record.sourcePath.replace(/\.webp$/u, ".png");
        await writeFile(normalizedPath, normalizedImages[index], { flag: "wx" });
        await rm(record.sourcePath, { force: true });
        record.contentType = "image/png";
        record.sourcePath = normalizedPath;
        record.byteCount = normalizedImages[index].length;
      }
    }
    const imagePaths = records.map((record) => record.sourcePath);
    return {
      jobDirectory,
      imagePaths,
      byteCount: records.reduce((sum, record) => sum + record.byteCount, 0),
      emojiCount: sourceResult.sources.length,
    };
  } catch (error) {
    await removeImageAnalysisJob(projectRoot, jobDirectory).catch(() => {});
    if (error instanceof DouyinNativeStickerUnavailableError) throw error;
    throw new DouyinNativeStickerUnavailableError("native-sticker-acquisition-failed");
  }
}

function extensionForImageContentType(contentType) {
  if (contentType === "image/png") return ".png";
  if (contentType === "image/jpeg") return ".jpg";
  if (contentType === "image/webp") return ".webp";
  return null;
}

function hasImageSignature(header, contentType) {
  if (contentType === "image/png") {
    return header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (contentType === "image/jpeg") return header[0] === 0xff && header[1] === 0xd8;
  if (contentType === "image/webp") {
    return header.subarray(0, 4).toString("ascii") === "RIFF"
      && header.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return false;
}

async function downloadDouyinImage({ source, destination, maxBytes, fetchFn, timeoutMs = 60_000 }) {
  if (!isTrustedDouyinMediaUrl(source)) {
    throw new Error("Refusing an untrusted Douyin image URL.");
  }
  const response = await fetchFn(source, {
    headers: { Referer: "https://www.douyin.com/" },
    redirect: "error",
    signal: AbortSignal.timeout(Math.max(1, Math.min(60_000, Math.trunc(timeoutMs) || 60_000))),
  });
  if (!response.ok || !response.body) throw new Error("Douyin image download failed.");
  const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (!extensionForImageContentType(contentType)) {
    throw new Error("Douyin image response has an unsupported content type.");
  }
  const declaredLength = Number.parseInt(response.headers.get("content-length") || "0", 10);
  if (declaredLength > maxBytes) throw new Error("Douyin image exceeds the local size limit.");
  const reader = response.body.getReader();
  const handle = await open(destination, "wx");
  let byteCount = 0;
  let header = Buffer.alloc(0);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      if (byteCount > maxBytes) throw new Error("Douyin image exceeds the local size limit.");
      if (header.length < 12) {
        header = Buffer.concat([header, Buffer.from(value)]).subarray(0, 12);
      }
      await handle.write(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    await handle.close();
    await rm(destination, { force: true });
    throw error;
  }
  await handle.close();
  if (byteCount === 0 || !hasImageSignature(header, contentType)) {
    await rm(destination, { force: true });
    throw new Error("Douyin image download has invalid image data.");
  }
  return { byteCount, contentType };
}

export async function prepareDouyinImagePost({
  projectRoot,
  manifest,
  fetchFn = fetch,
  maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_IMAGE_BYTES,
  maxWallTimeMs = DEFAULT_IMAGE_POST_WALL_TIME_MS,
  concurrency = MAX_IMAGE_DOWNLOAD_CONCURRENCY,
  now = Date.now,
}) {
  const supportedMediaTypes = new Set(["image_post", "shared_cover"]);
  if (!manifest?.ok || !supportedMediaTypes.has(manifest.mediaType)
      || !Array.isArray(manifest.sources) || manifest.sources.length === 0
      || manifest.sources.length > 12
      || !Number.isSafeInteger(manifest.totalImageCount)
      || manifest.totalImageCount < manifest.sources.length
      || (manifest.mediaType === "shared_cover"
        && (manifest.sources.length !== 1 || manifest.sampled))) {
    throw new Error("Douyin image-post manifest is invalid.");
  }
  const sourceCandidates = Array.isArray(manifest.sourceCandidates)
    ? manifest.sourceCandidates
    : manifest.sources.map((source) => [source]);
  if (sourceCandidates.length !== manifest.sources.length
      || sourceCandidates.some((candidates) => !Array.isArray(candidates)
        || candidates.length === 0
        || candidates.length > MAX_IMAGE_SOURCE_CANDIDATES
        || candidates.some((source) => typeof source !== "string"))) {
    throw new Error("Douyin image-post source candidates are invalid.");
  }
  if (sourceCandidates.some((candidates) => (
    candidates.some((source) => !isTrustedDouyinMediaUrl(source))
  ))) {
    throw new Error("Refusing an untrusted Douyin image URL.");
  }
  const boundedImageBytes = Math.max(64 * 1024, Math.min(
    DEFAULT_MAX_IMAGE_BYTES,
    Number.isFinite(maxImageBytes) ? Math.trunc(maxImageBytes) : DEFAULT_MAX_IMAGE_BYTES,
  ));
  const boundedTotalBytes = Math.max(boundedImageBytes, Math.min(
    DEFAULT_MAX_TOTAL_IMAGE_BYTES,
    Number.isFinite(maxTotalBytes) ? Math.trunc(maxTotalBytes) : DEFAULT_MAX_TOTAL_IMAGE_BYTES,
  ));
  const root = resolveImageAnalysisRoot(projectRoot);
  const jobDirectory = path.join(root, randomUUID());
  const boundedWallTimeMs = Math.max(100, Math.min(
    180_000,
    Number.isFinite(maxWallTimeMs) ? Math.trunc(maxWallTimeMs) : DEFAULT_IMAGE_POST_WALL_TIME_MS,
  ));
  const boundedConcurrency = Math.max(1, Math.min(
    MAX_IMAGE_DOWNLOAD_CONCURRENCY,
    Number.isFinite(concurrency) ? Math.trunc(concurrency) : MAX_IMAGE_DOWNLOAD_CONCURRENCY,
  ));
  const deadline = now() + boundedWallTimeMs;
  const outcomes = new Array(sourceCandidates.length);
  try {
    await mkdir(jobDirectory, { recursive: true });
    let nextIndex = 0;
    let downloadedBytes = 0;
    let fatalError = null;
    const worker = async () => {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= sourceCandidates.length || fatalError) return;
      const temporaryPath = path.join(jobDirectory, `image-${String(index + 1).padStart(2, "0")}.download`);
      for (const source of [...new Set(sourceCandidates[index])]) {
        if (fatalError) break;
        const remainingWallTimeMs = deadline - now();
        if (remainingWallTimeMs <= 0) break;
        let download;
        try {
          download = await downloadDouyinImage({
            source,
            destination: temporaryPath,
            maxBytes: boundedImageBytes,
            fetchFn,
            timeoutMs: remainingWallTimeMs,
          });
        } catch {
          await rm(temporaryPath, { force: true }).catch(() => {});
          continue;
        }
        if (fatalError) {
          await rm(temporaryPath, { force: true }).catch(() => {});
          break;
        }
        downloadedBytes += download.byteCount;
        if (downloadedBytes > boundedTotalBytes) {
          fatalError = new Error("Douyin image post exceeds the total size limit.");
          await rm(temporaryPath, { force: true }).catch(() => {});
          break;
        }
        const finalPath = `${temporaryPath}${extensionForImageContentType(download.contentType)}`;
        try {
          await rename(temporaryPath, finalPath);
        } catch {
          fatalError = new Error("Douyin image post could not store a validated image.");
          await rm(temporaryPath, { force: true }).catch(() => {});
          break;
        }
        outcomes[index] = { ...download, finalPath };
        return;
      }
      outcomes[index] = null;
    };
    const workers = Array.from(
      { length: Math.min(boundedConcurrency, sourceCandidates.length) },
      async () => {
        while (!fatalError && nextIndex < sourceCandidates.length) await worker();
      },
    );
    await Promise.all(workers);
    if (fatalError) throw fatalError;
    const successful = outcomes.filter(Boolean);
    if (successful.length === 0) {
      throw new Error("No bounded Douyin image-post source could be downloaded.");
    }
    const totalBytes = successful.reduce((sum, outcome) => sum + outcome.byteCount, 0);
    const imagePaths = successful.map((outcome) => outcome.finalPath);
    return {
      kind: manifest.mediaType,
      jobDirectory,
      imagePaths,
      totalBytes,
      totalImageCount: manifest.totalImageCount,
      sampled: Boolean(manifest.sampled),
      requestedImageCount: sourceCandidates.length,
      failedImageCount: sourceCandidates.length - successful.length,
      partial: successful.length !== sourceCandidates.length,
    };
  } catch (error) {
    await removeImageAnalysisJob(projectRoot, jobDirectory).catch(() => {});
    throw error;
  }
}
