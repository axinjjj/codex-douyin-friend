import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/codex-app-server-client.mjs";
import { ensureDouyinCompanionCwd } from "../src/douyin-companion-runtime.mjs";
import { CdpClient } from "../src/cdp-client.mjs";
import {
  buildChatIdentityMetadataExpression,
  buildReadRecentConversationExpression,
  isDouyinChatTarget,
} from "../src/douyin-chat-page.mjs";
import {
  generateDouyinVideoReply,
  injectConversationHistory,
  startVerifiedPersonaThread,
} from "../src/douyin-bridge-runtime.mjs";
import { acquireBridgeRunLock } from "../src/douyin-bridge-state.mjs";
import { runDouyinCleanupSteps } from "../src/douyin-runtime-cleanup.mjs";
import {
  cleanupStaleVideoAnalysisJobs,
  prepareLatestDouyinVideoMedia,
  removeVideoAnalysisJob,
} from "../src/douyin-video-runtime.mjs";
import {
  transcribeSenseVoiceAudio,
  verifySenseVoiceRuntime,
} from "../src/sensevoice-runtime.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const expectedPersonaPath = path.join(os.homedir(), ".codex", "AGENTS.md");
const port = Number.parseInt(process.env.DOUYIN_DEBUG_PORT || "9229", 10);
const model = process.env.CODEX_DOUYIN_MODEL || "gpt-5.6-sol";
const effort = process.env.CODEX_DOUYIN_EFFORT || "xhigh";
const companionCwd = await ensureDouyinCompanionCwd({ projectRoot });

await verifySenseVoiceRuntime({ projectRoot });
await cleanupStaleVideoAnalysisJobs(projectRoot);

const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
  signal: AbortSignal.timeout(3_000),
});
if (!response.ok) throw new Error(`Douyin debugger returned HTTP ${response.status}.`);
const targets = await response.json();
const target = (targets ?? []).find(isDouyinChatTarget);
if (!target) throw new Error("No debuggable Douyin chat page was found.");

const cdp = new CdpClient(target.webSocketDebuggerUrl);
const codex = new CodexAppServerClient();
codex.on("stderr", () => {
  // App Server diagnostics can include private local context.
});
let media;
let bridgeLock = null;
try {
  await cdp.connect();
  const lockedChat = await cdp.evaluate(buildChatIdentityMetadataExpression());
  if (!lockedChat?.found) throw new Error("The current Douyin chat could not be locked.");
  bridgeLock = await acquireBridgeRunLock(projectRoot, lockedChat.fingerprint);
  const recentConversation = await cdp.evaluate(buildReadRecentConversationExpression());
  const runtime = await startVerifiedPersonaThread({
    codex,
    cwd: companionCwd,
    expectedPersonaPath,
    model,
    effort,
  });
  await injectConversationHistory({
    codex,
    threadId: runtime.threadId,
    messages: recentConversation?.ok ? recentConversation.messages : [],
  });
  media = await prepareLatestDouyinVideoMedia({
    cdp,
    projectRoot,
    port,
    analyzeAudio: ({ audioPath }) => transcribeSenseVoiceAudio({
      audioPath,
      projectRoot,
    }),
  });
  const audioUnderstanding = media.audioUnderstanding || {
    processed: false,
    reason: media.audioReason || "audio-track-unavailable",
  };
  if (audioUnderstanding.reason === "transcription-failed") {
    console.log(JSON.stringify({
      ok: false,
      event: "audio-understanding-unavailable",
      reason: "transcription-failed",
    }));
  }
  media.audioUnderstanding = audioUnderstanding;
  const { reply } = await generateDouyinVideoReply({
    codex,
    threadId: runtime.threadId,
    framePaths: media.framePaths,
    durationSeconds: media.duration,
    audioUnderstanding,
    model: runtime.model,
    effort: runtime.effort,
  });
  console.log(JSON.stringify({
    ok: true,
    event: "video-reply-generated-not-sent",
    frameCount: media.framePaths.length,
    audioProcessed: audioUnderstanding.processed,
    transcriptLength: audioUnderstanding.transcript?.length || 0,
    audioLanguage: audioUnderstanding.language || null,
    audioEmotions: audioUnderstanding.emotions || [],
    audioEvents: audioUnderstanding.events || [],
    audioTimingSource: audioUnderstanding.timingSource || "unavailable",
    scanSampleCount: media.sampling.completedScanCount,
    scanTruncated: media.sampling.scanTruncated,
    replyLength: reply.length,
  }));
} finally {
  await runDouyinCleanupSteps([
    () => media?.jobDirectory
      ? removeVideoAnalysisJob(projectRoot, media.jobDirectory)
      : undefined,
    () => codex.close(),
    () => cdp.close(),
    () => bridgeLock?.release(),
  ]);
}
