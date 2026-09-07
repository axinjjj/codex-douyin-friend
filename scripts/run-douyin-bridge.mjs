import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/codex-app-server-client.mjs";
import { ensureDouyinCompanionCwd } from "../src/douyin-companion-runtime.mjs";
import {
  CodexContextRecoveryError,
  resolveContextCompactionPolicy,
} from "../src/codex-context-compaction.mjs";
import { CdpClient } from "../src/cdp-client.mjs";
import {
  classifyBridgeTerminalFailure,
  createBridgeControlChannel,
  createBridgeTerminalEvent,
  writeBridgeEvent,
} from "../src/douyin-bridge-control.mjs";
import {
  buildChatIdentityMetadataExpression,
  buildChatMessageMetadataExpression,
  buildClassifyLatestIncomingMediaExpression,
  buildEnsureChatTailVisibleExpression,
  buildReadIncomingCommentShareExpression,
  buildReadIncomingMediaTextExpression,
  buildReadIncomingTextBatchExpression,
  isDouyinChatTarget,
} from "../src/douyin-chat-page.mjs";
import {
  DouyinSendAbortedError,
  generateDouyinReply,
  generateDouyinImageReply,
  generateDouyinVideoReply,
  sanitizeDouyinMediaDiagnostic,
  sendAndVerifyDouyinReply,
} from "../src/douyin-bridge-runtime.mjs";
import {
  douyinBridgeStartupDependencies,
  recoverBridgeStartup,
} from "../src/douyin-bridge-startup.mjs";
import { planDouyinIncomingQueue } from "../src/douyin-inbound-planner.mjs";
import {
  acquireBridgeRunLock,
  computeQuotedTextMessageFingerprint,
  computeTextMessageFingerprint,
  DouyinCheckpointBoundaryError,
  DouyinRecoverySafetyError,
  findAppendedMessages,
  normalizeBridgeSnapshot,
  rebindPendingMessages,
} from "../src/douyin-bridge-state.mjs";
import {
  cleanupStaleImageAnalysisJobs,
  DouyinNativeStickerUnavailableError,
  removeImageAnalysisJob,
} from "../src/douyin-image-runtime.mjs";
import { acquireDouyinMedia } from "../src/douyin-media-pipeline.mjs";
import { likeIncomingDouyinMediaMessage } from "../src/douyin-media-reaction.mjs";
import { runDouyinCleanupSteps } from "../src/douyin-runtime-cleanup.mjs";
import { shouldQuoteDouyinMediaReply } from "../src/douyin-message-quote.mjs";
import {
  cleanupStaleVideoAnalysisJobs,
  removeVideoAnalysisJob,
} from "../src/douyin-video-runtime.mjs";
import { repairCollapsedDouyinViewport } from "../src/douyin-window-runtime.mjs";
import {
  resolveOptionalSenseVoiceRuntime,
  transcribeSenseVoiceAudio,
} from "../src/sensevoice-runtime.mjs";
import {
  buildGetOrCreateDouyinPageEpochExpression,
  createDouyinSendCapability,
  douyinSendCapabilitiesMatch,
  parseDouyinSendCapability,
  selectDouyinChatTarget,
} from "../src/douyin-send-capability.mjs";
import {
  computeDouyinReplyDigest,
  computeDouyinTurnPromptDigest,
  createDouyinAction,
  invalidateDouyinReaction,
  rebaseDouyinReactionTarget,
  rollbackDouyinActionBeforeEnter,
  transitionDouyinAction,
} from "../src/douyin-action-journal.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const expectedPersonaPath = path.join(os.homedir(), ".codex", "AGENTS.md");
const port = Number.parseInt(process.env.DOUYIN_DEBUG_PORT || "9229", 10);
const timeoutMs = Number.parseInt(process.env.DOUYIN_BRIDGE_TIMEOUT_MS || "3600000", 10);
const sendEnabled = process.env.DOUYIN_SEND_ENABLED === "true";
const configuredSendCapability = parseDouyinSendCapability(
  process.env.DOUYIN_SEND_CAPABILITY || "",
);
const mediaReactionEnabled = process.env.DOUYIN_MEDIA_REACTION_ENABLED === "true";
const model = process.env.CODEX_DOUYIN_MODEL || "gpt-5.6-sol";
const effort = process.env.CODEX_DOUYIN_EFFORT || "xhigh";
const supervised = process.env.DOUYIN_SUPERVISED === "true";
const forceFreshThread = process.env.DOUYIN_FORCE_FRESH_THREAD === "true";
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const compactionPolicy = resolveContextCompactionPolicy();
const companionCwd = await ensureDouyinCompanionCwd({ projectRoot });
let stopRequested = false;
class DouyinUnsupportedIncomingError extends Error {
  constructor(reason = "unsupported-media-type") {
    super("A Douyin incoming item uses an unsupported media structure.");
    this.name = "DouyinUnsupportedIncomingError";
    this.reason = /^[a-z0-9-]{1,80}$/u.test(reason) ? reason : "unsupported-media-type";
  }
}
const requestStop = () => {
  stopRequested = true;
};
process.once("SIGINT", requestStop);
process.once("SIGTERM", requestStop);

const senseVoiceAvailability = await resolveOptionalSenseVoiceRuntime({ projectRoot });
const cleanedStaleVideoJobs = await cleanupStaleVideoAnalysisJobs(projectRoot);
const cleanedStaleImageJobs = await cleanupStaleImageAnalysisJobs(projectRoot);

const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
  signal: AbortSignal.timeout(3_000),
});
if (!response.ok) throw new Error(`Douyin debugger returned HTTP ${response.status}.`);
const targets = await response.json();
if (sendEnabled && !configuredSendCapability) {
  process.exitCode = 4;
  throw new Error("Automatic sending requires a verified Douyin chat capability.");
}
let target;
try {
  target = selectDouyinChatTarget(targets ?? [], {
    capability: configuredSendCapability,
    isChatTarget: isDouyinChatTarget,
  });
} catch (error) {
  process.exitCode = 4;
  throw error;
}

const cdp = new CdpClient(target.webSocketDebuggerUrl);
const codex = new CodexAppServerClient();
let bridgeLock = null;
let contextManager = null;
let controlChannel = null;
let pendingManualCompactionRequestId = null;
let currentPhase = "starting";
let lastLatencyMs = null;
let uncommittedStartupThreadId = null;
const emitBridgeEvent = (event) => writeBridgeEvent(process.stdout, event);
const emitBridgeStatus = (requestId = null) => emitBridgeEvent({
  ok: true,
  event: "bridge-status",
  requestId,
  phase: currentPhase,
  sendEnabled,
  mediaReactionEnabled,
  model,
  effort,
  lastLatencyMs,
  contextUsage: contextManager?.usage ?? null,
});
const setBridgePhase = (phase) => {
  currentPhase = phase;
  if (supervised) emitBridgeStatus();
};
if (supervised) {
  controlChannel = createBridgeControlChannel({
    input: process.stdin,
    onCommand(command) {
      if (command.command === "status") {
        emitBridgeStatus(command.requestId);
        return;
      }
      if (command.command === "stop") {
        requestStop();
        emitBridgeEvent({
          ok: true,
          event: "bridge-command-accepted",
          requestId: command.requestId,
          command: command.command,
        });
        return;
      }
      if (pendingManualCompactionRequestId) {
        emitBridgeEvent({
          ok: false,
          event: "bridge-command-result",
          requestId: command.requestId,
          command: command.command,
          reason: "already-pending",
        });
        return;
      }
      pendingManualCompactionRequestId = command.requestId;
      emitBridgeEvent({
        ok: true,
        event: "bridge-command-accepted",
        requestId: command.requestId,
        command: command.command,
      });
    },
    onInvalid(reason) {
      emitBridgeEvent({ ok: false, event: "bridge-control-rejected", reason });
    },
  });
}
codex.on("stderr", () => {
  // Diagnostics can contain local paths or prompt context. Keep them private.
});

try {
  await cdp.connect();
  await repairCollapsedDouyinViewport({ cdp, targetId: target.id });
  const pageBinding = await cdp.evaluate(buildGetOrCreateDouyinPageEpochExpression());
  if (!pageBinding?.ok) throw new Error("The Douyin page epoch is unavailable.");
  const startupTail = await cdp.evaluate(buildEnsureChatTailVisibleExpression());
  if (!startupTail?.ok) throw new Error("The Douyin message tail is unavailable.");
  await sleep(150);
  const lockedChat = await cdp.evaluate(buildChatIdentityMetadataExpression());
  if (!lockedChat?.found) throw new Error("The current Douyin chat could not be locked.");
  const sendBinding = createDouyinSendCapability({
    chatFingerprint: lockedChat.fingerprint,
    target,
    pageEpoch: pageBinding.pageEpoch,
  });
  if (sendBinding.pageUrlHash !== pageBinding.pageUrlHash
      || (configuredSendCapability
        && !douyinSendCapabilitiesMatch(configuredSendCapability, sendBinding))) {
    process.exitCode = 4;
    throw new Error("The active Douyin page does not match its verified send capability.");
  }
  const verifyActiveSendCapability = async () => {
    const [currentChat, currentPage] = await Promise.all([
      cdp.evaluate(buildChatIdentityMetadataExpression()),
      cdp.evaluate(buildGetOrCreateDouyinPageEpochExpression()),
    ]);
    if (!currentChat?.found || !currentPage?.ok) return false;
    const currentBinding = createDouyinSendCapability({
      chatFingerprint: currentChat.fingerprint,
      target: { id: target.id, url: target.url },
      pageEpoch: currentPage.pageEpoch,
    });
    return currentBinding.pageUrlHash === currentPage.pageUrlHash
      && douyinSendCapabilitiesMatch(sendBinding, currentBinding);
  };
  bridgeLock = await acquireBridgeRunLock(projectRoot, lockedChat.fingerprint);

  const startup = await recoverBridgeStartup({
    cdp,
    codex,
    projectRoot,
    lockedChat,
    forceFreshThread,
    companionCwd,
    expectedPersonaPath,
    model,
    effort,
    compactionPolicy,
    supervised,
    onDiagnostic: (diagnostic) => console.log(JSON.stringify(diagnostic)),
    emitBridgeEvent,
    getBridgePhase: () => currentPhase,
    setBridgePhase,
    setContextManager: (manager) => {
      contextManager = manager;
    },
    setUncommittedStartupThreadId: (threadId) => {
      uncommittedStartupThreadId = threadId;
    },
    dependencies: douyinBridgeStartupDependencies,
  });
  const {
    getActiveState,
    loadedState,
    persistState,
    runtime,
    session,
    storedState,
    taskGeneration,
  } = startup;
  let previous = startup.previous;
  let queuedIncoming = startup.queuedIncoming;
  let resumedReply = startup.resumedReply;
  if (session.replacedStoredThread && storedState?.threadId
      && storedState.threadId !== runtime.threadId) {
    await codex.request("thread/archive", { threadId: storedState.threadId }).catch(() => {});
  }
  console.log(JSON.stringify({
    ok: true,
    event: "bridge-ready",
    personaLoaded: true,
    chatLocked: true,
    sendEnabled,
    ...(supervised ? { sendBinding } : {}),
    mediaReactionEnabled,
    model: runtime.model,
    effort: runtime.effort,
    audioEnabled: senseVoiceAvailability.enabled,
    cleanedStaleVideoJobs,
    cleanedStaleImageJobs,
    stateLoad: loadedState.status,
    threadResumed: runtime.resumed,
    threadResumeFallback: runtime.resumeFallback,
    recoveredVerifiedSend,
    recoveredForFreshThread,
    seededMessageCount: session.seededMessageCount,
    baselineMessageCount: previous.messageCount,
    phase: "listening",
    contextCompaction: contextManager.policy,
  }));
  setBridgePhase("listening");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !stopRequested) {
    if (!(await contextManager.waitForIdle())) continue;
    if (pendingManualCompactionRequestId) {
      const requestId = pendingManualCompactionRequestId;
      pendingManualCompactionRequestId = null;
      const result = await contextManager.compactNow();
      emitBridgeEvent({
        ok: result.ok,
        event: "bridge-command-result",
        requestId,
        command: "compact",
        reason: result.reason ?? null,
      });
      continue;
    }
    const continuingQueue = Array.isArray(queuedIncoming) && queuedIncoming.length > 0;
    if (!continuingQueue) {
      await sleep(750);
      if (stopRequested) break;
    }
    await repairCollapsedDouyinViewport({ cdp, targetId: target.id });
    const tail = await cdp.evaluate(buildEnsureChatTailVisibleExpression());
    if (!tail?.ok) throw new Error("The Douyin message tail is unavailable.");
    let currentMetadata = await cdp.evaluate(buildChatMessageMetadataExpression());
    if (currentMetadata.chatFingerprint !== lockedChat.fingerprint) {
      setBridgePhase("blocked");
      console.log(JSON.stringify({ ok: false, event: "chat-changed-bridge-stopped" }));
      process.exitCode = 4;
      break;
    }

    let current = normalizeBridgeSnapshot({
      messageCount: currentMetadata.messageCount,
      messages: currentMetadata.messages,
    });
    let appended = findAppendedMessages(previous, current);
    if (appended.length === 0 && !continuingQueue) continue;
    if (!continuingQueue && appended.some((message) => message.side === "left")) {
      let chatChangedDuringSettle = false;
      for (let settleRound = 0; settleRound < 3 && !stopRequested; settleRound += 1) {
        await sleep(750);
        const settledTail = await cdp.evaluate(buildEnsureChatTailVisibleExpression());
        if (!settledTail?.ok) throw new Error("The Douyin message tail is unavailable during settle.");
        const settledMetadata = await cdp.evaluate(buildChatMessageMetadataExpression());
        if (settledMetadata.chatFingerprint !== lockedChat.fingerprint) {
          setBridgePhase("blocked");
          chatChangedDuringSettle = true;
          break;
        }
        const settled = normalizeBridgeSnapshot({
          messageCount: settledMetadata.messageCount,
          messages: settledMetadata.messages,
        });
        const additional = findAppendedMessages(current, settled);
        currentMetadata = settledMetadata;
        current = settled;
        if (additional.length === 0) break;
      }
      if (stopRequested) break;
      if (chatChangedDuringSettle) {
        console.log(JSON.stringify({ ok: false, event: "chat-changed-bridge-stopped" }));
        process.exitCode = 4;
        break;
      }
      appended = findAppendedMessages(previous, current);
    }
    const newlyIncoming = appended.filter((message) => (
      message.side === "left" && (message.kind === "text" || message.kind === "media")
    ));
    const unsupportedIncoming = appended.filter((message) => (
      message.side === "left" && message.kind !== "text" && message.kind !== "media"
    ));
    const outgoing = appended.filter((message) => message.side === "right");
    const incoming = continuingQueue
      ? rebindPendingMessages(current, [...queuedIncoming, ...newlyIncoming])
      : newlyIncoming;
    queuedIncoming = null;

    if (!sendEnabled) {
      previous = current;
      if (incoming.length > 0 || unsupportedIncoming.length > 0) {
        console.log(JSON.stringify({
          ok: true,
          event: "incoming-detected-not-processed",
          incomingCount: incoming.length,
          unsupportedCount: unsupportedIncoming.length,
        }));
      }
      continue;
    }

    const expectedOutboundFingerprint = getActiveState().checkpoint.outboundFingerprint;
    const expectedOutgoingIndex = expectedOutboundFingerprint === null
      ? -1
      : outgoing.findIndex((message) => (
        message.kind === "text" && message.fingerprint === expectedOutboundFingerprint
      ));
    const unexpectedOutgoingCount = outgoing.length - Number(expectedOutgoingIndex >= 0);

    if ((expectedOutboundFingerprint !== null && expectedOutgoingIndex < 0)
        || unexpectedOutgoingCount > 0) {
      setBridgePhase("blocked");
      await persistState("blocked", {
        snapshot: current,
        pending: incoming,
        blockedReason: expectedOutgoingIndex < 0
          ? "verified-outbound-missing"
          : "concurrent-outgoing-ambiguous",
      });
      console.log(JSON.stringify({
        ok: false,
        event: "outgoing-activity-ambiguous-bridge-stopped",
      }));
      process.exitCode = 6;
      break;
    }

    if (incoming.length === 0) {
      await persistState("ready", {
        snapshot: current,
      });
      previous = current;
      if (unsupportedIncoming.length > 0) {
        console.log(JSON.stringify({
          ok: true,
          event: "unsupported-incoming-detected",
          count: unsupportedIncoming.length,
        }));
      }
      continue;
    }

    const queuePlan = planDouyinIncomingQueue(incoming, {
      action: resumedReply?.action ?? null,
      chatKey: lockedChat.fingerprint,
    });
    if (resumedReply && !queuePlan.ok) {
      // Preserve the old action/turn receipt instead of replacing it with a generic block.
      throw new DouyinRecoverySafetyError("The recovered reply input boundary cannot be proved.");
    }
    if (unsupportedIncoming.length > 0) {
      console.log(JSON.stringify({
        ok: true,
        event: "unsupported-incoming-skipped",
        count: unsupportedIncoming.length,
      }));
    }
    if (!queuePlan.ok) {
      setBridgePhase("blocked");
      await persistState("blocked", {
        snapshot: current,
        pending: incoming,
        blockedReason: "ambiguous-incoming-batch",
      });
      console.log(JSON.stringify({
        ok: false,
        event: "ambiguous-incoming-batch-bridge-stopped",
      }));
      process.exitCode = 5;
      break;
    }
    const incomingBatch = queuePlan.batches[0];
    const remainingAfterBatch = incoming.slice(incomingBatch.messages.length);
    let currentAction = resumedReply?.action ?? createDouyinAction({
      chatKey: lockedChat.fingerprint,
      generation: taskGeneration,
      pending: incomingBatch.messages,
      replyKind: incomingBatch.mode === "text" ? "text" : null,
    });
    if (!resumedReply) {
      await persistState("processing", {
        snapshot: current,
        pending: incoming,
        action: currentAction,
      });
      setBridgePhase("processing");
    }
    const turnStartedAt = Date.now();

    let media = null;
    let contextRecoveryFailed = false;
    try {
      let reply = resumedReply?.reply ?? null;
      let replyKind = resumedReply?.replyKind ?? null;
      let mediaShouldLike = resumedReply?.mediaShouldLike ?? false;
      let reactionDecision = resumedReply?.action?.reactionDecision ?? null;
      const recoveringReply = Boolean(resumedReply);
      resumedReply = null;
      const journaledCodex = {
        runTurn: async (params) => {
          const promptDigest = computeDouyinTurnPromptDigest(params);
          if (currentAction.promptDigest && currentAction.promptDigest !== promptDigest) {
            throw new Error("The persisted Codex prompt digest changed before turn start.");
          }
          currentAction = transitionDouyinAction(currentAction, "turn-starting", {
            promptDigest,
          });
          await persistState("processing", {
            snapshot: current,
            pending: incoming,
            action: currentAction,
          });
          return contextManager.runTurn({
            ...params,
            onTurnStarted: async ({ turnId }) => {
              const turnIds = [...new Set([...currentAction.turnIds, turnId])].slice(-2);
              currentAction = transitionDouyinAction(currentAction, "turn-started", { turnIds });
              await persistState("processing", {
                snapshot: current,
                pending: incoming,
                action: currentAction,
              });
            },
          });
        },
      };
      if (!recoveringReply && incomingBatch.mode === "text") {
        const inbound = await cdp.evaluate(buildReadIncomingTextBatchExpression(incomingBatch.textMessages));
        if (inbound?.chatFingerprint !== lockedChat.fingerprint) {
          throw new Error("The Douyin chat changed before text capture; refusing the wrong conversation.");
        }
        if (!inbound.ok || !Array.isArray(inbound.texts)
            || inbound.texts.length !== incomingBatch.textMessages.length) {
          throw new Error("New incoming messages were detected but could not be read exactly.");
        }
        reply = await generateDouyinReply({
          codex: journaledCodex,
          threadId: runtime.threadId,
          inboundText: inbound.texts.length === 1
            ? inbound.texts[0]
            : inbound.texts.map((text, index) => `连续消息 ${index + 1}：${text}`).join("\n"),
          model: runtime.model,
          effort: runtime.effort,
          taskGeneration,
        });
        replyKind = "text";
        reactionDecision = "disabled";
      } else if (!recoveringReply) {
        const mediaCheckMetadata = await cdp.evaluate(buildChatMessageMetadataExpression());
        if (mediaCheckMetadata.chatFingerprint !== lockedChat.fingerprint) {
          throw new Error("The Douyin chat changed before video capture; refusing the wrong conversation.");
        }
        const mediaCheck = normalizeBridgeSnapshot({
          messageCount: mediaCheckMetadata.messageCount,
          messages: mediaCheckMetadata.messages,
        });
        if (findAppendedMessages(current, mediaCheck).length !== 0) {
          throw new Error("The Douyin chat changed before media capture; refusing to analyze the wrong item.");
        }
        const inboundTextParts = [];
        if (incomingBatch.textMessages.length > 0) {
          const inbound = await cdp.evaluate(buildReadIncomingTextBatchExpression(incomingBatch.textMessages));
          if (inbound?.chatFingerprint !== lockedChat.fingerprint
              || !inbound.ok || !Array.isArray(inbound.texts)
              || inbound.texts.length !== incomingBatch.textMessages.length) {
            throw new Error("Text accompanying the Douyin media could not be read exactly.");
          }
          inboundTextParts.push(...inbound.texts);
        }
        const mediaClassification = await cdp.evaluate(
          buildClassifyLatestIncomingMediaExpression(incomingBatch.mediaMessage),
        );
        if (!mediaClassification?.ok) {
          const diagnostic = sanitizeDouyinMediaDiagnostic(mediaClassification?.diagnostic);
          console.log(JSON.stringify({
            ok: false,
            event: "unknown-media-structure",
            reason: "unsupported-media-type",
            ...(diagnostic ? { diagnostic } : {}),
          }));
          if (mediaClassification?.reason === "unsupported-media-type") {
            throw new DouyinUnsupportedIncomingError(mediaClassification.reason);
          }
          throw new Error(`The latest Douyin media type is unavailable: ${mediaClassification?.reason || "unknown"}.`);
        }
        let sharedComment = null;
        let nativeStickerLabels = [];
        if (mediaClassification.mediaType === "comment_share") {
          const commentShare = await cdp.evaluate(
            buildReadIncomingCommentShareExpression(incomingBatch.mediaMessage),
          );
          if (!commentShare?.ok || commentShare.chatFingerprint !== lockedChat.fingerprint) {
            throw new Error(`The incoming Douyin comment share changed before capture: ${commentShare?.reason || "unknown"}.`);
          }
          sharedComment = commentShare.comment;
        } else {
          const mediaMessage = await cdp.evaluate(
            buildReadIncomingMediaTextExpression(incomingBatch.mediaMessage),
          );
          if (!mediaMessage?.ok || mediaMessage.chatFingerprint !== lockedChat.fingerprint) {
            throw new Error(`The incoming Douyin media changed before capture: ${mediaMessage?.reason || "unknown"}.`);
          }
          if (mediaMessage.text && !inboundTextParts.includes(mediaMessage.text)) {
            inboundTextParts.push(mediaMessage.text);
          }
          nativeStickerLabels = Array.isArray(mediaMessage.nativeStickerLabels)
            ? mediaMessage.nativeStickerLabels
            : [];
        }
        const inboundText = inboundTextParts.join("\n") || null;
        media = await acquireDouyinMedia({
          mediaType: mediaClassification.mediaType,
          cdp,
          projectRoot,
          port,
          mediaMessage: incomingBatch.mediaMessage,
          expectedChatFingerprint: lockedChat.fingerprint,
          analyzeAudio: senseVoiceAvailability.enabled
            ? ({ audioPath, timeoutMs: audioTimeoutMs }) => transcribeSenseVoiceAudio({
              audioPath,
              projectRoot,
              timeoutMs: audioTimeoutMs,
            })
            : null,
        });
        const currentChatAfterCapture = await cdp.evaluate(buildChatIdentityMetadataExpression());
        if (!currentChatAfterCapture?.found
            || currentChatAfterCapture.fingerprint !== lockedChat.fingerprint) {
          throw new Error("The Douyin chat changed during media capture; refusing the wrong conversation.");
        }
        const reactionNonce = mediaReactionEnabled ? randomBytes(12).toString("hex") : null;
        if (media.kind === "chat_image" || media.kind === "image_post"
            || media.kind === "shared_cover" || media.kind === "native_sticker") {
          currentAction = transitionDouyinAction(currentAction, "evidence-ready", {
            replyKind: "image",
            reactionNonce,
            reactionTarget: incomingBatch.mediaMessage,
          });
          await persistState("processing", {
            snapshot: current,
            pending: incoming,
            action: currentAction,
          });
          const decision = await generateDouyinImageReply({
            codex: journaledCodex,
            threadId: runtime.threadId,
            imagePaths: media.imagePaths,
            mediaType: media.kind,
            totalImageCount: media.totalImageCount ?? media.imagePaths.length,
            requestedImageCount: media.requestedImageCount ?? media.imagePaths.length,
            partial: Boolean(media.partial),
            evidence: media.evidence,
            inboundText,
            nativeStickerLabels,
            nativeStickerCount: media.emojiCount ?? null,
            sharedComment,
            mediaReactionEnabled,
            reactionNonce,
            model: runtime.model,
            effort: runtime.effort,
            taskGeneration,
          });
          reply = decision.reply;
          mediaShouldLike = decision.shouldLike;
          reactionDecision = decision.reactionDecision;
          replyKind = "image";
        } else {
          currentAction = transitionDouyinAction(currentAction, "evidence-ready", {
            replyKind: "video",
            reactionNonce,
            reactionTarget: incomingBatch.mediaMessage,
          });
          await persistState("processing", {
            snapshot: current,
            pending: incoming,
            action: currentAction,
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
          const decision = await generateDouyinVideoReply({
            codex: journaledCodex,
            threadId: runtime.threadId,
            framePaths: media.framePaths,
            durationSeconds: media.duration,
            audioUnderstanding,
            evidence: media.evidence,
            inboundText,
            sharedComment,
            mediaReactionEnabled,
            reactionNonce,
            model: runtime.model,
            effort: runtime.effort,
            taskGeneration,
          });
          reply = decision.reply;
          mediaShouldLike = decision.shouldLike;
          reactionDecision = decision.reactionDecision;
          media.audioUnderstanding = audioUnderstanding;
          replyKind = "video";
        }
      }

      const sendPreparationMetadata = await cdp.evaluate(buildChatMessageMetadataExpression());
      if (sendPreparationMetadata.chatFingerprint !== lockedChat.fingerprint) {
        throw new Error("The active Douyin chat changed while preparing a reply; refusing to send.");
      }
      const sendPreparationSnapshot = normalizeBridgeSnapshot({
        messageCount: sendPreparationMetadata.messageCount,
        messages: sendPreparationMetadata.messages,
      });
      const activityBeforeSend = findAppendedMessages(current, sendPreparationSnapshot);
      if (activityBeforeSend.some((message) => message.side === "right")) {
        throw new Error("Ambiguous Douyin activity appeared while preparing a reply.");
      }
      let discoveredQuoteTarget = null;
      let discoveredQuoteTargetFingerprint = null;
      if (incomingBatch.mediaMessage) {
        const rebasedMediaMessage = {
          ...incomingBatch.mediaMessage,
          ordinalFromEnd: incomingBatch.mediaMessage.ordinalFromEnd + activityBeforeSend.length,
        };
        const sendMediaClassification = await cdp.evaluate(
          buildClassifyLatestIncomingMediaExpression(rebasedMediaMessage),
        );
        if (!sendMediaClassification?.ok) {
          throw new Error("The incoming Douyin media changed before reply preparation.");
        }
        if (shouldQuoteDouyinMediaReply({
          replyKind,
          mediaType: sendMediaClassification.mediaType,
          quoteTargetFingerprint: sendMediaClassification.quoteTargetFingerprint,
        })) {
          discoveredQuoteTarget = rebasedMediaMessage;
          discoveredQuoteTargetFingerprint = sendMediaClassification.quoteTargetFingerprint;
        }
      }
      let quoteTarget = discoveredQuoteTarget;
      let quoteTargetFingerprint = discoveredQuoteTargetFingerprint;
      if (currentAction.stage === "reply-ready") {
        if (currentAction.quoteTargetFingerprint) {
          if (!discoveredQuoteTarget
              || discoveredQuoteTargetFingerprint !== currentAction.quoteTargetFingerprint) {
            throw new Error("The persisted Douyin quote target changed before recovery.");
          }
        } else {
          quoteTarget = null;
          quoteTargetFingerprint = null;
        }
      }
      const outboundFingerprint = quoteTarget
        ? computeQuotedTextMessageFingerprint(reply)
        : computeTextMessageFingerprint(reply);
      if (currentAction.stage === "turn-started") {
        currentAction = transitionDouyinAction(currentAction, "reply-ready", {
          replyDigest: computeDouyinReplyDigest(reply),
          replyKind,
          reactionDecision: reactionDecision ?? "disabled",
          quoteTargetFingerprint,
        });
      }
      if ((currentAction.quoteTargetFingerprint ?? null) !== quoteTargetFingerprint) {
        throw new Error("The prepared Douyin quote target does not match its action journal.");
      }
      await persistState("reply-ready", {
        snapshot: current,
        pending: incoming,
        outboundFingerprint,
        action: currentAction,
      });
      lastLatencyMs = Date.now() - turnStartedAt;
      setBridgePhase("reply-ready");
      if (stopRequested) {
        throw new Error("Bridge stop requested after reply generation; refusing to send.");
      }

      const currentChatBeforeSend = await cdp.evaluate(buildChatIdentityMetadataExpression());
      if (!currentChatBeforeSend?.found || currentChatBeforeSend.fingerprint !== lockedChat.fingerprint) {
        throw new Error("The active Douyin chat changed while generating a reply; refusing to send.");
      }
      let sendResult;
      try {
        sendResult = await sendAndVerifyDouyinReply({
          cdp,
          reply,
          beforeSend: sendPreparationMetadata,
          expectedChatFingerprint: lockedChat.fingerprint,
          quoteTarget,
          quoteTargetFingerprint,
          quoteNonce: quoteTarget ? currentAction.id.slice(0, 24) : null,
          shouldStop: () => stopRequested,
          canSend: async () => {
            return verifyActiveSendCapability();
          },
          onSendAttempted: async ({
            expectedFingerprint,
            expectedQuoteTargetFingerprint,
          }) => {
            if (expectedFingerprint !== outboundFingerprint
                || expectedQuoteTargetFingerprint !== currentAction.quoteTargetFingerprint) {
              throw new Error("The prepared Douyin outbound fingerprint changed before Enter.");
            }
            if (currentAction.reactionDecision === "yes" && incomingBatch.mediaMessage) {
              try {
                currentAction = rebaseDouyinReactionTarget(
                  currentAction,
                  incomingBatch.mediaMessage,
                );
              } catch {
                currentAction = invalidateDouyinReaction(currentAction);
                mediaShouldLike = false;
              }
            }
            currentAction = transitionDouyinAction(currentAction, "send-attempted");
            await persistState("sending", {
              snapshot: current,
              pending: incoming,
              outboundFingerprint,
              action: currentAction,
            });
            setBridgePhase("sending");
          },
          onSendCancelledBeforeEnter: async () => {
            if (currentAction.stage === "send-attempted") {
              currentAction = rollbackDouyinActionBeforeEnter(currentAction);
            }
            if (currentAction.stage !== "reply-ready") {
              throw new Error("The cancelled Douyin send action cannot return to reply-ready.");
            }
            await persistState("reply-ready", {
              snapshot: current,
              pending: incoming,
              outboundFingerprint,
              action: currentAction,
            });
            setBridgePhase("reply-ready");
          },
        });
      } catch (error) {
        if (!(error instanceof DouyinSendAbortedError)) throw error;
        await persistState("reply-ready", {
          snapshot: current,
          pending: incoming,
          outboundFingerprint,
          action: currentAction,
        });
        if (error.reason === "chat-changed") {
          process.exitCode = 4;
        } else if (["editor-authority-lost", "quote-authority-lost"].includes(error.reason)) {
          process.exitCode = 8;
        }
        setBridgePhase(error.reason === "stop" ? "stopping" : "blocked");
        console.log(JSON.stringify({
          ok: error.reason === "stop",
          event: error.reason === "stop"
            ? "bridge-stop-requested-before-send"
            : error.reason === "quote-authority-lost"
              ? "media-quote-authority-lost-before-send"
            : error.reason === "editor-authority-lost"
              ? "editor-authority-lost-before-send"
            : "chat-changed-before-send",
        }));
        if (supervised && ["editor-authority-lost", "quote-authority-lost"].includes(error.reason)) {
          emitBridgeEvent(createBridgeTerminalEvent({
            disposition: "recover",
            reason: "ui-authority-recovery-required",
            phase: "reply-ready",
          }));
        }
        break;
      }
      const { outgoing, afterSend } = sendResult;
      console.log(JSON.stringify({
        ok: Boolean(outgoing),
        event: outgoing ? `${replyKind}-reply-bubble-observed` : "send-unverified-bridge-stopped",
        deliveryEvidence: outgoing ? "local-dom-observed" : "unverified",
        replyLength: reply.length,
        frameCount: media?.framePaths?.length,
        imageCount: media?.imagePaths?.length,
        audioProcessed: media?.audioUnderstanding?.processed,
        transcriptLength: media?.audioUnderstanding?.transcript?.length || 0,
        audioLanguage: media?.audioUnderstanding?.language || null,
        audioEmotions: media?.audioUnderstanding?.emotions || [],
        audioEvents: media?.audioUnderstanding?.events || [],
        audioTimingSource: media?.audioUnderstanding?.timingSource || "unavailable",
        scanSampleCount: media?.sampling?.completedScanCount,
        scanTruncated: media?.sampling?.scanTruncated,
        messageCount: afterSend.messageCount,
      }));
      if (!outgoing) {
        setBridgePhase("blocked");
        process.exitCode = 3;
        break;
      }
      if (afterSend.chatFingerprint !== lockedChat.fingerprint) {
        throw new Error("The Douyin chat changed while verifying the local outgoing bubble.");
      }
      const afterSendSnapshot = normalizeBridgeSnapshot({
        messageCount: afterSend.messageCount,
        messages: afterSend.messages,
      });
      const appendedDuringSend = findAppendedMessages(current, afterSendSnapshot);
      const outgoingDuringSend = appendedDuringSend.filter((message) => message.side === "right");
      const unexpectedOutgoing = outgoingDuringSend.filter((message) => (
        message.kind !== "text" || message.fingerprint !== outboundFingerprint
        || (currentAction.quoteTargetFingerprint !== null
          && message.quoteTargetFingerprint !== currentAction.quoteTargetFingerprint)
      ));
      const incomingDuringSend = appendedDuringSend.filter((message) => (
        message.side === "left" && (message.kind === "text" || message.kind === "media")
      ));
      const unsupportedDuringSend = appendedDuringSend.filter((message) => (
        message.side === "left" && message.kind !== "text" && message.kind !== "media"
      ));
      const remainingMessages = [...remainingAfterBatch, ...incomingDuringSend];
      const reboundRemaining = remainingMessages.length > 0
        ? rebindPendingMessages(afterSendSnapshot, remainingMessages)
        : [];
      if (outgoingDuringSend.length !== 1 || unexpectedOutgoing.length > 0) {
        setBridgePhase("blocked");
        await persistState("blocked", {
          snapshot: afterSendSnapshot,
          pending: reboundRemaining,
          blockedReason: "concurrent-outgoing-ambiguous",
          action: currentAction,
        });
        console.log(JSON.stringify({
          ok: false,
          event: "activity-during-send-ambiguous-bridge-stopped",
        }));
        process.exitCode = 6;
        break;
      }
      if (unsupportedDuringSend.length > 0) {
        console.log(JSON.stringify({
          ok: true,
          event: "unsupported-incoming-skipped",
          count: unsupportedDuringSend.length,
        }));
      }
      currentAction = transitionDouyinAction(currentAction, "send-verified", {
        reactionOrdinalShift: appendedDuringSend.length,
      });
      await persistState("sending", {
        snapshot: current,
        pending: incoming,
        outboundFingerprint,
        action: currentAction,
      });
      if (mediaReactionEnabled && mediaShouldLike && incomingBatch.mediaMessage) {
        currentAction = transitionDouyinAction(currentAction, "reaction-attempted");
        await persistState("sending", {
          snapshot: current,
          pending: incoming,
          outboundFingerprint,
          action: currentAction,
        });
        try {
          const reaction = await likeIncomingDouyinMediaMessage({
            cdp,
            message: incomingBatch.mediaMessage,
            expectedChatFingerprint: lockedChat.fingerprint,
            ordinalShift: appendedDuringSend.length,
          });
          console.log(JSON.stringify({
            ok: true,
            event: reaction.applied ? "media-like-applied" : "media-like-skipped",
            reason: reaction.reason,
          }));
        } catch {
          console.log(JSON.stringify({
            ok: false,
            event: "media-like-failed",
            reason: "verification-failed",
          }));
        }
      }
      await persistState(reboundRemaining.length > 0 ? "queued" : "ready", {
        snapshot: afterSendSnapshot,
        pending: reboundRemaining,
      });
      queuedIncoming = reboundRemaining.length > 0 ? reboundRemaining : null;
      previous = afterSendSnapshot;
      setBridgePhase(queuedIncoming ? "queued" : "listening");
    } catch (error) {
      if (error instanceof DouyinUnsupportedIncomingError
          || error instanceof DouyinNativeStickerUnavailableError) {
        if (currentAction.stage !== "planned" || !incomingBatch.mediaMessage) throw error;
        const unsupportedIndex = incoming.indexOf(incomingBatch.mediaMessage);
        if (unsupportedIndex < 0) throw error;
        const remainingAfterUnsupported = incoming.filter((_, index) => index !== unsupportedIndex);
        const reboundRemaining = remainingAfterUnsupported.length > 0
          ? rebindPendingMessages(current, remainingAfterUnsupported)
          : [];
        await persistState(reboundRemaining.length > 0 ? "queued" : "ready", {
          snapshot: current,
          pending: reboundRemaining,
        });
        queuedIncoming = reboundRemaining.length > 0 ? reboundRemaining : null;
        previous = current;
        setBridgePhase(queuedIncoming ? "queued" : "listening");
        console.log(JSON.stringify({
          ok: true,
          event: "unsupported-media-skipped",
          reason: error.reason,
          remainingCount: reboundRemaining.length,
        }));
        continue;
      }
      if (!(error instanceof CodexContextRecoveryError)) throw error;
      contextRecoveryFailed = true;
      await persistState("blocked", {
        snapshot: current,
        pending: incoming,
        blockedReason: "context-recovery-failed",
        action: currentAction,
      });
      setBridgePhase("blocked");
      console.log(JSON.stringify({
        ok: false,
        event: "context-recovery-failed-bridge-stopped",
        reason: error.reason,
      }));
      process.exitCode = 7;
      break;
    } finally {
      if (media?.jobDirectory) {
        if (media.kind === "chat_image" || media.kind === "image_post"
            || media.kind === "shared_cover" || media.kind === "native_sticker") {
          await removeImageAnalysisJob(projectRoot, media.jobDirectory);
        } else {
          await removeVideoAnalysisJob(projectRoot, media.jobDirectory);
        }
      }
      // This loop is sequential: turn, media, cleanup, and sending are all idle here.
      if (!contextRecoveryFailed && !stopRequested) await contextManager.maybeCompact();
    }
  }

  if (Date.now() >= deadline) {
    console.log(JSON.stringify({ ok: true, event: "bridge-timeout" }));
  } else if (stopRequested) {
    console.log(JSON.stringify({ ok: true, event: "bridge-stop-requested" }));
  }
  setBridgePhase("stopped");
} catch (error) {
  if (supervised) emitBridgeEvent(classifyBridgeTerminalFailure({
    errorCode: error instanceof DouyinCheckpointBoundaryError
      || error instanceof DouyinRecoverySafetyError
      ? error.code
      : null,
    exitCode: process.exitCode,
    phase: currentPhase,
  }));
  if (uncommittedStartupThreadId) {
    await codex.request("thread/archive", { threadId: uncommittedStartupThreadId }).catch(() => {});
    uncommittedStartupThreadId = null;
  }
  throw error;
} finally {
  await runDouyinCleanupSteps([
    () => controlChannel?.close(),
    () => contextManager?.close(),
    () => codex.close(),
    () => cdp.close(),
    () => bridgeLock?.release(),
    () => process.removeListener("SIGINT", requestStop),
    () => process.removeListener("SIGTERM", requestStop),
  ]);
}
