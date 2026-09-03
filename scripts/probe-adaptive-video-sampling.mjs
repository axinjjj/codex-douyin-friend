import { constants } from "node:fs";
import { access, copyFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupStaleVideoAnalysisJobs,
  createVideoAnalysisJob,
  extractVideoMedia,
  removeVideoAnalysisJob,
} from "../src/douyin-video-runtime.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const port = Number.parseInt(process.env.DOUYIN_DEBUG_PORT || "9229", 10);
const fixtureValue = process.env.CODEX_DOUYIN_VIDEO_FIXTURE;
if (!fixtureValue) {
  throw new Error("Set CODEX_DOUYIN_VIDEO_FIXTURE to a non-sensitive local video path.");
}
const fixturePath = path.resolve(fixtureValue);
const fixtureStat = await stat(fixturePath);
if (!fixtureStat.isFile() || fixtureStat.size === 0) {
  throw new Error("The adaptive-sampling fixture is not a usable file.");
}
if (fixtureStat.size > 100 * 1024 * 1024) {
  throw new Error("The adaptive-sampling fixture exceeds the 100 MB video limit.");
}

await cleanupStaleVideoAnalysisJobs(projectRoot);
const job = await createVideoAnalysisJob(projectRoot);
let summary;
try {
  await copyFile(fixturePath, job.videoPath, constants.COPYFILE_EXCL);
  const startedAt = performance.now();
  const media = await extractVideoMedia({
    port,
    videoPath: job.videoPath,
    outputDirectory: job.jobDirectory,
    extractAudio: false,
  });
  summary = {
    ok: true,
    fixtureBytes: fixtureStat.size,
    durationSeconds: Math.round(media.duration * 10) / 10,
    frameBudget: media.sampling.frameBudget,
    scanBudget: media.sampling.scanBudget,
    completedScanCount: media.sampling.completedScanCount,
    selectedFrameCount: media.sampling.selectedFrameCount,
    scanTruncated: media.sampling.scanTruncated,
    failedSeekCount: media.sampling.failedSeekCount,
    totalFrameBytes: media.sampling.totalFrameBytes,
    elapsedMilliseconds: Math.round(performance.now() - startedAt),
  };
} finally {
  await removeVideoAnalysisJob(projectRoot, job.jobDirectory);
}

let cleanupVerified = false;
try {
  await access(job.jobDirectory);
} catch (error) {
  cleanupVerified = error.code === "ENOENT";
}
console.log(JSON.stringify({ ...summary, cleanupVerified }));
