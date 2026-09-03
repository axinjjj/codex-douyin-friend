import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildLocateLatestIncomingChatImageExpression,
  buildReadLatestIncomingChatImageSourceExpression,
} from "./douyin-chat-page.mjs";
import { isTrustedDouyinMediaUrl } from "./douyin-video-runtime.mjs";

const IMAGE_JOB_NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_IMAGE_BYTES = 64 * 1024 * 1024;

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

function decodeEmbeddedImage(source, maxBytes) {
  if (typeof source !== "string" || !source.startsWith("data:")) return null;
  if (source.length > Math.ceil(maxBytes / 3) * 4 + 64) {
    throw new Error("Douyin embedded chat image exceeds the local size limit.");
  }
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(source);
  if (!match) throw new Error("Douyin embedded chat image format is unsupported.");
  const [, , data] = match;
  const image = Buffer.from(data, "base64");
  const header = image.subarray(0, 12);
  const contentType = ["image/png", "image/jpeg", "image/webp"]
    .find((candidate) => hasImageSignature(header, candidate));
  if (image.length === 0 || image.length > maxBytes || !contentType) {
    throw new Error("Douyin embedded chat image has invalid image data.");
  }
  return { image, contentType };
}

export async function captureLatestDouyinChatImage({
  cdp,
  projectRoot,
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
  const sourceResult = await cdp.evaluate(buildReadLatestIncomingChatImageSourceExpression());
  const embeddedImage = sourceResult?.ok
    ? decodeEmbeddedImage(sourceResult.source, boundedMaxBytes)
    : null;
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
  let sourceDownloadError = null;
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
  const location = await cdp.evaluate(buildLocateLatestIncomingChatImageExpression());
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

async function downloadDouyinImage({ source, destination, maxBytes, fetchFn }) {
  if (!isTrustedDouyinMediaUrl(source)) {
    throw new Error("Refusing an untrusted Douyin image URL.");
  }
  const response = await fetchFn(source, {
    headers: { Referer: "https://www.douyin.com/" },
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
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
}) {
  const supportedMediaTypes = new Set(["image_post", "shared_cover"]);
  if (!manifest?.ok || !supportedMediaTypes.has(manifest.mediaType)
      || !Array.isArray(manifest.sources) || manifest.sources.length === 0
      || manifest.sources.length > 12
      || !Number.isSafeInteger(manifest.totalImageCount)
      || manifest.totalImageCount < manifest.sources.length
      || (manifest.mediaType === "shared_cover"
        && (manifest.sources.length !== 1 || manifest.totalImageCount !== 1 || manifest.sampled))) {
    throw new Error("Douyin image-post manifest is invalid.");
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
  const imagePaths = [];
  let totalBytes = 0;
  try {
    await mkdir(jobDirectory, { recursive: true });
    for (let index = 0; index < manifest.sources.length; index += 1) {
      const temporaryPath = path.join(jobDirectory, `image-${String(index + 1).padStart(2, "0")}.download`);
      const download = await downloadDouyinImage({
        source: manifest.sources[index],
        destination: temporaryPath,
        maxBytes: boundedImageBytes,
        fetchFn,
      });
      totalBytes += download.byteCount;
      if (totalBytes > boundedTotalBytes) throw new Error("Douyin image post exceeds the total size limit.");
      const finalPath = `${temporaryPath}${extensionForImageContentType(download.contentType)}`;
      await rename(temporaryPath, finalPath);
      imagePaths.push(finalPath);
    }
    return {
      kind: manifest.mediaType,
      jobDirectory,
      imagePaths,
      totalBytes,
      totalImageCount: manifest.totalImageCount,
      sampled: Boolean(manifest.sampled),
    };
  } catch (error) {
    await removeImageAnalysisJob(projectRoot, jobDirectory).catch(() => {});
    throw error;
  }
}
