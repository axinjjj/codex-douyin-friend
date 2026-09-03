import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/codex-app-server-client.mjs";
import {
  CodexContextCompactionManager,
  CodexContextRecoveryError,
  resolveContextCompactionPolicy,
} from "../src/codex-context-compaction.mjs";
import { CdpClient } from "../src/cdp-client.mjs";
import {
  createBridgeControlChannel,
  writeBridgeEvent,
} from "../src/douyin-bridge-control.mjs";
import {
  buildChatIdentityMetadataExpression,
  buildChatMessageMetadataExpression,
  buildBridgeStartupViewExpression,
  buildClassifyLatestIncomingMediaExpression,
  buildReadCompatibleAwemeMediaExpression,
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
  planDouyinIncomingQueue,
  preparePersistentBridgeSession,
  sendAndVerifyDouyinReply,
} from "../src/douyin-bridge-runtime.mjs";
import {
  acquireBridgeRunLock,
  computeTextMessageFingerprint,
  createBridgeState,
  findAppendedMessages,
  loadBridgeState,
  normalizeBridgeSnapshot,
  rebindPendingMessages,
  recoverBridgeStateForFreshThread,
  recoverBridgeStateForStartup,
  saveBridgeState,
} from "../src/douyin-bridge-state.mjs";
import {
  captureLatestDouyinChatImage,
  cleanupStaleImageAnalysisJobs,
  prepareDouyinImagePost,
  removeImageAnalysisJob,
} from "../src/douyin-image-runtime.mjs";
import { likeIncomingDouyinMediaMessage } from "../src/douyin-media-reaction.mjs";
import {
  cleanupStaleVideoAnalysisJobs,
  prepareLatestDouyinVideoMedia,
  removeVideoAnalysisJob,
} from "../src/douyin-video-runtime.mjs";
import { repairCollapsedDouyinViewport } from "../src/douyin-window-runtime.mjs";
import {
  transcribeSenseVoiceAudio,
  verifySenseVoiceRuntime,
} from "../src/sensevoice-runtime.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const expectedPersonaPath = path.join(os.homedir(), ".codex", "AGENTS.md");
const port = Number.parseInt(process.env.DOUYIN_DEBUG_PORT || "9229", 10);
const timeoutMs = Number.parseInt(process.env.DOUYIN_BRIDGE_TIMEOUT_MS || "3600000", 10);
const sendEnabled = process.env.DOUYIN_SEND_ENABLED === "true";
const mediaReactionEnabled = process.env.DOUYIN_MEDIA_REACTION_ENABLED === "true";
const model = process.env.CODEX_DOUYIN_MODEL || "gpt-5.6-sol";
const effort = process.env.CODEX_DOUYIN_EFFORT || "xhigh";
const supervised = process.env.DOUYIN_SUPERVISED === "true";
const forceFreshThread = process.env.DOUYIN_FORCE_FRESH_THREAD === "true";
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const compactionPolicy = resolveContextCompactionPolicy();
let stopRequested = false;
const requestStop = () => {
  stopRequested = true;
};
process.once("SIGINT", requestStop);
process.once("SIGTERM", requestStop);

await verifySenseVoiceRuntime({ projectRoot });
const cleanedStaleVideoJobs = await cleanupStaleVideoAnalysisJobs(projectRoot);
const cleanedStaleImageJobs = await cleanupStaleImageAnalysisJobs(projectRoot);

const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
  signal: AbortSignal.timeout(3_000),
});
if (!response.ok) throw new Error(`Douyin debugger returned HTTP ${response.status}.`);
const targets = await response.json();
const target = (targets ?? []).find(isDouyinChatTarget);
if (!target) throw new Error("No debuggable Douyin chat page was found.");

const cdp = new CdpClient(target.webSocketDebuggerUrl);
const codex = new CodexAppServerClient();
let bridgeLock = null;
let contextManager = null;
let controlChannel = null;
let pendingManualCompactionRequestId = null;
let currentPhase = "starting";
let lastLatencyMs = null;
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
  const lockedChat = await cdp.evaluate(buildChatIdentityMetadataExpression());
  if (!lockedChat?.found) throw new Error("The current Douyin chat could not be locked.");
  bridgeLock = await acquireBridgeRunLock(projectRoot, lockedChat.fingerprint);

  const startupView = await cdp.evaluate(buildBridgeStartupViewExpression());
  if (!startupView?.ok) throw new Error("The Douyin message list is unavailable.");
  if (startupView.chatFingerprint !== lockedChat.fingerprint) {
    throw new Error("The Douyin chat changed during startup; refusing to seed the wrong conversation.");
  }
  const startupSnapshot = normalizeBridgeSnapshot(startupView.snapshot);
  const loadedState = await loadBridgeState(projectRoot, lockedChat.fingerprint);
  if (loadedState.status === "corrupt") {
    throw new Error("Both bridge checkpoint copies are unreadable; refusing an ambiguous restart.");
  }
  let storedState = loadedState.state;
  let recoveredVerifiedSend = false;
  let recoveredForFreshThread = false;
  let startupQueuedPending = null;
  if (storedState) {
    const canAttemptFreshRecovery = forceFreshThread
      && storedState.checkpoint.phase !== "ready"
      && storedState.checkpoint.phase !== "sending";
    const recovery = canAttemptFreshRecovery
      ? recoverBridgeStateForFreshThread(storedState, startupSnapshot)
      : recoverBridgeStateForStartup(storedState, startupSnapshot);
    storedState = recovery.state;
    recoveredVerifiedSend = recovery.recoveredVerifiedSend;
    recoveredForFreshThread = canAttemptFreshRecovery;
    startupQueuedPending = recovery.queuedPending?.length > 0
      ? recovery.queuedPending
      : null;
    if (recoveredVerifiedSend || recoveredForFreshThread || startupQueuedPending) {
      await saveBridgeState(projectRoot, storedState);
    }
  }
  const startupPendingMessages = startupQueuedPending ?? (storedState
    ? findAppendedMessages(storedState.checkpoint.snapshot, startupSnapshot)
    : []);

  const session = await preparePersistentBridgeSession({
    codex,
    cwd: projectRoot,
    expectedPersonaPath,
    model,
    effort,
    storedState,
    allowStoredThreadResume: !loadedState.requiresFreshThread && !forceFreshThread,
    currentSnapshot: startupSnapshot,
    visibleMessages: startupView.conversation,
    pendingMessages: startupPendingMessages,
  });
  const runtime = session.runtime;
  contextManager = new CodexContextCompactionManager({
    codex,
    threadId: runtime.threadId,
    ...compactionPolicy,
    onDiagnostic: (diagnostic) => console.log(JSON.stringify(diagnostic)),
    onUsage: (usage) => {
      if (supervised) emitBridgeEvent({
        ok: true,
        event: "context-usage-updated",
        contextUsage: usage,
      });
    },
  });
  let previous = normalizeBridgeSnapshot(session.baselineSnapshot);
  let queuedIncoming = startupQueuedPending;
  let activeState = queuedIncoming
    ? createBridgeState({
      chatKey: lockedChat.fingerprint,
      threadId: runtime.threadId,
      model: runtime.model,
      effort: runtime.effort,
      snapshot: previous,
      phase: "queued",
      pending: queuedIncoming,
    })
    : createBridgeState({
      chatKey: lockedChat.fingerprint,
      threadId: runtime.threadId,
      model: runtime.model,
      effort: runtime.effort,
      snapshot: previous,
      outboundFingerprint: storedState?.checkpoint.outboundFingerprint ?? null,
    });
  await saveBridgeState(projectRoot, activeState);
  console.log(JSON.stringify({
    ok: true,
    event: "bridge-ready",
    personaLoaded: true,
    chatLocked: true,
    sendEnabled,
    mediaReactionEnabled,
    model: runtime.model,
    effort: runtime.effort,
    audioEnabled: true,
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
      setBridgePhase("compacting");
      const result = await contextManager.compactNow();
      emitBridgeEvent({
        ok: result.ok,
        event: "bridge-command-result",
        requestId,
        command: "compact",
        reason: result.reason ?? null,
      });
      setBridgePhase("listening");
      continue;
    }
    const continuingQueue = Array.isArray(queuedIncoming) && queuedIncoming.length > 0;
    if (!continuingQueue) {
      await sleep(750);
      if (stopRequested) break;
    }
    await repairCollapsedDouyinViewport({ cdp, targetId: target.id });
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

    const expectedOutboundFingerprint = activeState.checkpoint.outboundFingerprint;
    const expectedOutgoingIndex = expectedOutboundFingerprint === null
      ? -1
      : outgoing.findIndex((message) => (
        message.kind === "text" && message.fingerprint === expectedOutboundFingerprint
      ));
    const unexpectedOutgoingCount = outgoing.length - Number(expectedOutgoingIndex >= 0);

    if ((expectedOutboundFingerprint !== null && expectedOutgoingIndex < 0)
        || unexpectedOutgoingCount > 0) {
      setBridgePhase("blocked");
      activeState = createBridgeState({
        chatKey: lockedChat.fingerprint,
        threadId: runtime.threadId,
        model: runtime.model,
        effort: runtime.effort,
        snapshot: current,
        phase: "blocked",
        pending: incoming,
        blockedReason: expectedOutgoingIndex < 0
          ? "verified-outbound-missing"
          : "concurrent-outgoing-ambiguous",
      });
      await saveBridgeState(projectRoot, activeState);
      console.log(JSON.stringify({
        ok: false,
        event: "outgoing-activity-ambiguous-bridge-stopped",
      }));
      process.exitCode = 6;
      break;
    }

    if (incoming.length === 0) {
      activeState = createBridgeState({
        chatKey: lockedChat.fingerprint,
        threadId: runtime.threadId,
        model: runtime.model,
        effort: runtime.effort,
        snapshot: current,
      });
      await saveBridgeState(projectRoot, activeState);
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

    const queuePlan = planDouyinIncomingQueue(incoming);
    if (!queuePlan.ok || unsupportedIncoming.length > 0) {
      setBridgePhase("blocked");
      activeState = createBridgeState({
        chatKey: lockedChat.fingerprint,
        threadId: runtime.threadId,
        model: runtime.model,
        effort: runtime.effort,
        snapshot: current,
        phase: "blocked",
        pending: incoming,
        blockedReason: unsupportedIncoming.length > 0
          ? "unsupported-incoming-batch"
          : "ambiguous-incoming-batch",
      });
      await saveBridgeState(projectRoot, activeState);
      console.log(JSON.stringify({
        ok: false,
        event: "ambiguous-incoming-batch-bridge-stopped",
      }));
      process.exitCode = 5;
      break;
    }
    const incomingBatch = queuePlan.batches[0];
    const remainingAfterBatch = incoming.slice(incomingBatch.messages.length);

    activeState = createBridgeState({
      chatKey: lockedChat.fingerprint,
      threadId: runtime.threadId,
      model: runtime.model,
      effort: runtime.effort,
      snapshot: current,
      phase: "processing",
      pending: incoming,
    });
    await saveBridgeState(projectRoot, activeState);
    setBridgePhase("processing");
    const turnStartedAt = Date.now();

    let media = null;
    let contextRecoveryFailed = false;
    try {
      let reply;
      let replyKind;
      let mediaShouldLike = false;
      if (incomingBatch.mode === "text") {
        const inbound = await cdp.evaluate(buildReadIncomingTextBatchExpression(incomingBatch.textMessages));
        if (inbound?.chatFingerprint !== lockedChat.fingerprint) {
          throw new Error("The Douyin chat changed before text capture; refusing the wrong conversation.");
        }
        if (!inbound.ok || !Array.isArray(inbound.texts)
            || inbound.texts.length !== incomingBatch.textMessages.length) {
          throw new Error("New incoming messages were detected but could not be read exactly.");
        }
        reply = await generateDouyinReply({
          codex: contextManager,
          threadId: runtime.threadId,
          inboundText: inbound.texts.length === 1
            ? inbound.texts[0]
            : inbound.texts.map((text, index) => `连续消息 ${index + 1}：${text}`).join("\n"),
          model: runtime.model,
          effort: runtime.effort,
        });
        replyKind = "text";
      } else {
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
          throw new Error(`The latest Douyin media type is unsupported: ${mediaClassification?.reason || "unknown"}.`);
        }
        let sharedComment = null;
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
        }
        const inboundText = inboundTextParts.join("\n") || null;
        if (mediaClassification.mediaType === "chat_image") {
          media = {
            kind: "chat_image",
            ...await captureLatestDouyinChatImage({
              cdp,
              projectRoot,
              mediaMessage: incomingBatch.mediaMessage,
            }),
          };
        } else if (mediaClassification.mediaType === "shared_aweme"
            || mediaClassification.mediaType === "comment_share") {
          const sharedManifest = await cdp.evaluate(
            buildReadCompatibleAwemeMediaExpression(incomingBatch.mediaMessage),
          );
          if (!sharedManifest?.ok) {
            throw new Error(`The shared Douyin work is unavailable: ${sharedManifest?.reason || "unknown"}.`);
          }
          if (sharedManifest.mediaType === "video") {
            media = {
              kind: "video",
              ...await prepareLatestDouyinVideoMedia({
                cdp,
                projectRoot,
                port,
                sourceResult: sharedManifest,
                analyzeAudio: ({ audioPath }) => transcribeSenseVoiceAudio({
                  audioPath,
                  projectRoot,
                }),
              }),
            };
          } else if (sharedManifest.mediaType === "image_post"
              || sharedManifest.mediaType === "shared_cover") {
            media = await prepareDouyinImagePost({
              projectRoot,
              manifest: sharedManifest,
            });
          } else {
            throw new Error("The shared Douyin work type is unsupported.");
          }
        } else {
          throw new Error("The latest Douyin media type is unsupported.");
        }
        const currentChatAfterCapture = await cdp.evaluate(buildChatIdentityMetadataExpression());
        if (!currentChatAfterCapture?.found
            || currentChatAfterCapture.fingerprint !== lockedChat.fingerprint) {
          throw new Error("The Douyin chat changed during media capture; refusing the wrong conversation.");
        }
        if (media.kind === "chat_image" || media.kind === "image_post" || media.kind === "shared_cover") {
          const decision = await generateDouyinImageReply({
            codex: contextManager,
            threadId: runtime.threadId,
            imagePaths: media.imagePaths,
            mediaType: media.kind,
            totalImageCount: media.totalImageCount ?? media.imagePaths.length,
            inboundText,
            sharedComment,
            mediaReactionEnabled,
            model: runtime.model,
            effort: runtime.effort,
          });
          reply = decision.reply;
          mediaShouldLike = decision.shouldLike;
          replyKind = "image";
        } else {
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
            codex: contextManager,
            threadId: runtime.threadId,
            framePaths: media.framePaths,
            durationSeconds: media.duration,
            audioUnderstanding,
            inboundText,
            sharedComment,
            mediaReactionEnabled,
            model: runtime.model,
            effort: runtime.effort,
          });
          reply = decision.reply;
          mediaShouldLike = decision.shouldLike;
          media.audioUnderstanding = audioUnderstanding;
          replyKind = "video";
        }
      }

      const outboundFingerprint = computeTextMessageFingerprint(reply);
      activeState = createBridgeState({
        chatKey: lockedChat.fingerprint,
        threadId: runtime.threadId,
        model: runtime.model,
        effort: runtime.effort,
        snapshot: current,
        phase: "reply-ready",
        pending: incoming,
        outboundFingerprint,
      });
      await saveBridgeState(projectRoot, activeState);
      lastLatencyMs = Date.now() - turnStartedAt;
      setBridgePhase("reply-ready");
      if (stopRequested) {
        throw new Error("Bridge stop requested after reply generation; refusing to send.");
      }

      activeState = createBridgeState({
        chatKey: lockedChat.fingerprint,
        threadId: runtime.threadId,
        model: runtime.model,
        effort: runtime.effort,
        snapshot: current,
        phase: "sending",
        pending: incoming,
        outboundFingerprint,
      });
      await saveBridgeState(projectRoot, activeState);
      setBridgePhase("sending");
      const currentChatBeforeSend = await cdp.evaluate(buildChatIdentityMetadataExpression());
      if (!currentChatBeforeSend?.found || currentChatBeforeSend.fingerprint !== lockedChat.fingerprint) {
        throw new Error("The active Douyin chat changed while generating a reply; refusing to send.");
      }
      let sendResult;
      try {
        sendResult = await sendAndVerifyDouyinReply({
          cdp,
          reply,
          beforeSend: currentMetadata,
          shouldStop: () => stopRequested,
          canSend: async () => {
            const currentChat = await cdp.evaluate(buildChatIdentityMetadataExpression());
            return Boolean(
              currentChat?.found && currentChat.fingerprint === lockedChat.fingerprint,
            );
          },
        });
      } catch (error) {
        if (!(error instanceof DouyinSendAbortedError)) throw error;
        activeState = createBridgeState({
          chatKey: lockedChat.fingerprint,
          threadId: runtime.threadId,
          model: runtime.model,
          effort: runtime.effort,
          snapshot: current,
          phase: "reply-ready",
          pending: incoming,
          outboundFingerprint,
        });
        await saveBridgeState(projectRoot, activeState);
        if (error.reason === "chat-changed") process.exitCode = 4;
        setBridgePhase(error.reason === "stop" ? "stopping" : "blocked");
        console.log(JSON.stringify({
          ok: error.reason === "stop",
          event: error.reason === "stop"
            ? "bridge-stop-requested-before-send"
            : "chat-changed-before-send",
        }));
        break;
      }
      const { outgoing, afterSend } = sendResult;
      console.log(JSON.stringify({
        ok: Boolean(outgoing),
        event: outgoing ? `${replyKind}-reply-sent` : "send-unverified-bridge-stopped",
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
        throw new Error("The Douyin chat changed while verifying a sent reply.");
      }
      const afterSendSnapshot = normalizeBridgeSnapshot({
        messageCount: afterSend.messageCount,
        messages: afterSend.messages,
      });
      const appendedDuringSend = findAppendedMessages(current, afterSendSnapshot);
      const outgoingDuringSend = appendedDuringSend.filter((message) => message.side === "right");
      const unexpectedOutgoing = outgoingDuringSend.filter((message) => (
        message.kind !== "text" || message.fingerprint !== outboundFingerprint
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
      if (outgoingDuringSend.length !== 1 || unexpectedOutgoing.length > 0
          || unsupportedDuringSend.length > 0) {
        setBridgePhase("blocked");
        activeState = createBridgeState({
          chatKey: lockedChat.fingerprint,
          threadId: runtime.threadId,
          model: runtime.model,
          effort: runtime.effort,
          snapshot: afterSendSnapshot,
          phase: "blocked",
          pending: reboundRemaining,
          blockedReason: unsupportedDuringSend.length > 0
            ? "unsupported-incoming-batch"
            : "concurrent-outgoing-ambiguous",
        });
        await saveBridgeState(projectRoot, activeState);
        console.log(JSON.stringify({
          ok: false,
          event: "activity-during-send-ambiguous-bridge-stopped",
        }));
        process.exitCode = 6;
        break;
      }
      activeState = createBridgeState({
        chatKey: lockedChat.fingerprint,
        threadId: runtime.threadId,
        model: runtime.model,
        effort: runtime.effort,
        snapshot: afterSendSnapshot,
        phase: reboundRemaining.length > 0 ? "queued" : "ready",
        pending: reboundRemaining,
      });
      await saveBridgeState(projectRoot, activeState);
      if (mediaReactionEnabled && mediaShouldLike && incomingBatch.mediaMessage) {
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
      queuedIncoming = reboundRemaining.length > 0 ? reboundRemaining : null;
      previous = afterSendSnapshot;
      setBridgePhase(queuedIncoming ? "queued" : "listening");
    } catch (error) {
      if (!(error instanceof CodexContextRecoveryError)) throw error;
      contextRecoveryFailed = true;
      activeState = createBridgeState({
        chatKey: lockedChat.fingerprint,
        threadId: runtime.threadId,
        model: runtime.model,
        effort: runtime.effort,
        snapshot: current,
        phase: "blocked",
        pending: incoming,
        blockedReason: "context-recovery-failed",
      });
      await saveBridgeState(projectRoot, activeState);
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
        if (media.kind === "chat_image" || media.kind === "image_post" || media.kind === "shared_cover") {
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
} finally {
  controlChannel?.close();
  contextManager?.close();
  try {
    await codex.close();
  } finally {
    cdp.close();
    await bridgeLock?.release();
  }
  process.removeListener("SIGINT", requestStop);
  process.removeListener("SIGTERM", requestStop);
}
