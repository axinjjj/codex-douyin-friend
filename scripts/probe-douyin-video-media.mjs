import path from "node:path";
import { fileURLToPath } from "node:url";
import { CdpClient } from "../src/cdp-client.mjs";
import {
  buildReadCompatibleAwemeMediaExpression,
  isDouyinChatTarget,
} from "../src/douyin-chat-page.mjs";
import {
  cleanupStaleVideoAnalysisJobs,
  createVideoAnalysisJob,
  downloadCompatibleDouyinVideo,
  extractVideoMedia,
  removeVideoAnalysisJob,
} from "../src/douyin-video-runtime.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const port = Number.parseInt(process.env.DOUYIN_DEBUG_PORT || "9229", 10);
await cleanupStaleVideoAnalysisJobs(projectRoot);
const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
  signal: AbortSignal.timeout(3_000),
});
if (!response.ok) throw new Error(`Douyin debugger returned HTTP ${response.status}.`);
const targets = await response.json();
const target = (targets ?? []).find(isDouyinChatTarget);
if (!target) throw new Error("No debuggable Douyin chat page was found.");

const cdp = new CdpClient(target.webSocketDebuggerUrl);
await cdp.connect();
let sourceResult;
try {
  sourceResult = await cdp.evaluate(buildReadCompatibleAwemeMediaExpression(), 15_000);
  if (!sourceResult?.ok || sourceResult.mediaType !== "video") {
    throw new Error("The latest Douyin video card has no compatible source.");
  }
} finally {
  cdp.close();
}

const job = await createVideoAnalysisJob(projectRoot);
try {
  const download = await downloadCompatibleDouyinVideo({ sourceResult, destination: job.videoPath });
  const media = await extractVideoMedia({
    port,
    videoPath: job.videoPath,
    audioPath: job.audioPath,
    outputDirectory: job.jobDirectory,
  });
  console.log(JSON.stringify({
    ok: true,
    byteCount: download.byteCount,
    contentType: download.contentType,
    frameCount: media.framePaths.length,
    durationSeconds: Math.round(media.duration * 10) / 10,
    dimensions: [media.videoWidth, media.videoHeight],
    audioAvailable: media.audioAvailable,
    audioDurationSeconds: media.audioDuration == null ? null : Math.round(media.audioDuration * 10) / 10,
    audioTruncated: media.audioTruncated,
    frameBudget: media.sampling.frameBudget,
    scanSampleCount: media.sampling.completedScanCount,
    scanTruncated: media.sampling.scanTruncated,
    totalFrameBytes: media.sampling.totalFrameBytes,
  }));
} finally {
  if (process.env.DOUYIN_KEEP_VIDEO_PROBE !== "true") {
    await removeVideoAnalysisJob(projectRoot, job.jobDirectory);
  }
}
