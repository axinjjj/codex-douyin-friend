import { randomBytes } from "node:crypto";
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
  buildEnsureChatTailVisibleExpression,
  buildReadIncomingCommentShareExpression,
  buildReadIncomingMediaTextExpression,
  buildReadIncomingTextBatchExpression,
  isDouyinChatTarget,
  normalizeOutboundText,
} from "../src/douyin-chat-page.mjs";
import {
  DouyinSendAbortedError,
  generateDouyinReply,
  generateDouyinImageReply,
  generateDouyinVideoReply,
  parseDouyinMediaReply,
  preparePersistentBridgeSession,
  sanitizeDouyinMediaDiagnostic,
  sendAndVerifyDouyinReply,
} from "../src/douyin-bridge-runtime.mjs";
import { planDouyinIncomingQueue } from "../src/douyin-inbound-planner.mjs";
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
  cleanupStaleImageAnalysisJobs,
  removeImageAnalysisJob,
} from "../src/douyin-image-runtime.mjs";
import { acquireDouyinMedia } from "../src/douyin-media-pipeline.mjs";
import { likeIncomingDouyinMediaMessage } from "../src/douyin-media-reaction.mjs";
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
let stopRequested = false;
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
let phaseBeforeCompaction = null;
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
  let startupResumeAction = null;
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
    startupResumeAction = recovery.resumeAction ?? null;
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
  const taskGeneration = runtime.resumed
    ? (storedState?.generation ?? 1)
    : (storedState?.generation ?? 0) + 1;
  if (!runtime.resumed) uncommittedStartupThreadId = runtime.threadId;
  contextManager = new CodexContextCompactionManager({
    codex,
    threadId: runtime.threadId,
    generation: taskGeneration,
    ...compactionPolicy,
    onDiagnostic: (diagnostic) => console.log(JSON.stringify(diagnostic)),
    onOperationStart: () => {
      phaseBeforeCompaction = currentPhase;
      setBridgePhase("compacting");
    },
    onOperationEnd: () => {
      if (currentPhase === "compacting") setBridgePhase(phaseBeforeCompaction || "listening");
      phaseBeforeCompaction = null;
    },
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
  let resumedReply = null;
  if (startupResumeAction
      && ["turn-started", "reply-ready"].includes(startupResumeAction.stage)) {
    const turnId = startupResumeAction.turnIds.at(-1);
    const recoveredTurn = await codex.readTurn({ threadId: runtime.threadId, turnId });
    if (!recoveredTurn.found || recoveredTurn.status !== "completed" || !recoveredTurn.text) {
      throw new Error("The persisted Codex turn cannot be recovered without duplication.");
    }
    let recoveredReply;
    let reactionDecision = "disabled";
    let shouldLike = false;
    if (startupResumeAction.replyKind === "text") {
      recoveredReply = normalizeOutboundText(recoveredTurn.text);
    } else {
      const parsed = parseDouyinMediaReply(recoveredTurn.text, {
        reactionEnabled: Boolean(startupResumeAction.reactionNonce),
        nonce: startupResumeAction.reactionNonce,
      });
      recoveredReply = parsed.reply;
      reactionDecision = parsed.reactionDecision;
      shouldLike = parsed.shouldLike;
    }
    if (!recoveredReply) throw new Error("The persisted Codex reply is empty.");
    const replyDigest = computeDouyinReplyDigest(recoveredReply);
    if (startupResumeAction.replyDigest
        && startupResumeAction.replyDigest !== replyDigest) {
      throw new Error("The persisted Codex reply digest does not match the recovered turn.");
    }
    if (startupResumeAction.stage === "turn-started") {
      startupResumeAction = transitionDouyinAction(startupResumeAction, "reply-ready", {
        replyDigest,
        reactionDecision,
      });
    }
    resumedReply = {
      action: startupResumeAction,
      reply: recoveredReply,
      replyKind: startupResumeAction.replyKind,
      mediaShouldLike: shouldLike,
    };
  }
  let activeState = resumedReply
    ? createBridgeState({
      chatKey: lockedChat.fingerprint,
      threadId: runtime.threadId,
      model: runtime.model,
      effort: runtime.effort,
      generation: taskGeneration,
      snapshot: previous,
      phase: "reply-ready",
      pending: queuedIncoming,
      outboundFingerprint: computeTextMessageFingerprint(resumedReply.reply),
      action: resumedReply.action,
    })
    : queuedIncoming
    ? createBridgeState({
      chatKey: lockedChat.fingerprint,
      threadId: runtime.threadId,
      model: runtime.model,
      effort: runtime.effort,
      generation: taskGeneration,
      snapshot: previous,
      phase: "queued",
      pending: queuedIncoming,
      action: startupResumeAction,
    })
    : createBridgeState({
      chatKey: lockedChat.fingerprint,
      threadId: runtime.threadId,
      model: runtime.model,
      effort: runtime.effort,
      generation: taskGeneration,
      snapshot: previous,
      outboundFingerprint: storedState?.checkpoint.outboundFingerprint ?? null,
      action: startupResumeAction,
    });
  await saveBridgeState(projectRoot, activeState);
  if (startupResumeAction
      && ["send-verified", "reaction-attempted"].includes(startupResumeAction.stage)) {
    if (startupResumeAction.stage === "send-verified"
        && startupResumeAction.reactionDecision === "yes"
        && startupResumeAction.reactionTarget) {
      startupResumeAction = transitionDouyinAction(
        startupResumeAction,
        "reaction-attempted",
      );
      activeState = createBridgeState({
        chatKey: lockedChat.fingerprint,
        threadId: runtime.threadId,
        model: runtime.model,
        effort: runtime.effort,
        generation: taskGeneration,
        snapshot: previous,
        phase: queuedIncoming?.length ? "queued" : "ready",
        pending: queuedIncoming ?? [],
        action: startupResumeAction,
      });
      await saveBridgeState(projectRoot, activeState);
      try {
        await likeIncomingDouyinMediaMessage({
          cdp,
          message: startupResumeAction.reactionTarget,
          expectedChatFingerprint: lockedChat.fingerprint,
          ordinalShift: startupResumeAction.reactionOrdinalShift,
        });
      } catch {
        // The journal is already reaction-attempted, so restart will not repeat the click.
      }
    }
    startupResumeAction = null;
    activeState = createBridgeState({
      chatKey: lockedChat.fingerprint,
      threadId: runtime.threadId,
      model: runtime.model,
      effort: runtime.effort,
      generation: taskGeneration,
      snapshot: previous,
      phase: queuedIncoming?.length ? "queued" : "ready",
      pending: queuedIncoming ?? [],
    });
    await saveBridgeState(projectRoot, activeState);
  }
  uncommittedStartupThreadId = null;
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
        generation: taskGeneration,
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
        generation: taskGeneration,
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
        generation: taskGeneration,
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
    let currentAction = resumedReply?.action ?? createDouyinAction({
      chatKey: lockedChat.fingerprint,
      generation: taskGeneration,
      pending: incomingBatch.messages,
      replyKind: incomingBatch.mode === "text" ? "text" : null,
    });
    if (!resumedReply) {
      activeState = createBridgeState({
        chatKey: lockedChat.fingerprint,
        threadId: runtime.threadId,
        model: runtime.model,
        effort: runtime.effort,
        generation: taskGeneration,
        snapshot: current,
        phase: "processing",
        pending: incoming,
        action: currentAction,
      });
      await saveBridgeState(projectRoot, activeState);
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
          activeState = createBridgeState({
            chatKey: lockedChat.fingerprint,
            threadId: runtime.threadId,
            model: runtime.model,
            effort: runtime.effort,
            generation: taskGeneration,
            snapshot: current,
            phase: "processing",
            pending: incoming,
            action: currentAction,
          });
          await saveBridgeState(projectRoot, activeState);
          return contextManager.runTurn({
            ...params,
            onTurnStarted: async ({ turnId }) => {
              const turnIds = [...new Set([...currentAction.turnIds, turnId])].slice(-2);
              currentAction = transitionDouyinAction(currentAction, "turn-started", { turnIds });
              activeState = createBridgeState({
                chatKey: lockedChat.fingerprint,
                threadId: runtime.threadId,
                model: runtime.model,
                effort: runtime.effort,
                generation: taskGeneration,
                snapshot: current,
                phase: "processing",
                pending: incoming,
                action: currentAction,
              });
              await saveBridgeState(projectRoot, activeState);
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
        if (media.kind === "chat_image" || media.kind === "image_post" || media.kind === "shared_cover") {
          currentAction = transitionDouyinAction(currentAction, "evidence-ready", {
            replyKind: "image",
            reactionNonce,
            reactionTarget: incomingBatch.mediaMessage,
          });
          activeState = createBridgeState({
            chatKey: lockedChat.fingerprint,
            threadId: runtime.threadId,
            model: runtime.model,
            effort: runtime.effort,
            generation: taskGeneration,
            snapshot: current,
            phase: "processing",
            pending: incoming,
            action: currentAction,
          });
          await saveBridgeState(projectRoot, activeState);
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
          activeState = createBridgeState({
            chatKey: lockedChat.fingerprint,
            threadId: runtime.threadId,
            model: runtime.model,
            effort: runtime.effort,
            generation: taskGeneration,
            snapshot: current,
            phase: "processing",
            pending: incoming,
            action: currentAction,
          });
          await saveBridgeState(projectRoot, activeState);
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

      const outboundFingerprint = computeTextMessageFingerprint(reply);
      if (currentAction.stage === "turn-started") {
        currentAction = transitionDouyinAction(currentAction, "reply-ready", {
          replyDigest: computeDouyinReplyDigest(reply),
          replyKind,
          reactionDecision: reactionDecision ?? "disabled",
        });
      }
      activeState = createBridgeState({
        chatKey: lockedChat.fingerprint,
        threadId: runtime.threadId,
        model: runtime.model,
        effort: runtime.effort,
        generation: taskGeneration,
        snapshot: current,
        phase: "reply-ready",
        pending: incoming,
        outboundFingerprint,
        action: currentAction,
      });
      await saveBridgeState(projectRoot, activeState);
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
          beforeSend: currentMetadata,
          expectedChatFingerprint: lockedChat.fingerprint,
          shouldStop: () => stopRequested,
          canSend: async () => {
            return verifyActiveSendCapability();
          },
          onSendAttempted: async () => {
            currentAction = transitionDouyinAction(currentAction, "send-attempted");
            activeState = createBridgeState({
              chatKey: lockedChat.fingerprint,
              threadId: runtime.threadId,
              model: runtime.model,
              effort: runtime.effort,
              generation: taskGeneration,
              snapshot: current,
              phase: "sending",
              pending: incoming,
              outboundFingerprint,
              action: currentAction,
            });
            await saveBridgeState(projectRoot, activeState);
            setBridgePhase("sending");
          },
        });
      } catch (error) {
        if (!(error instanceof DouyinSendAbortedError)) throw error;
        activeState = createBridgeState({
          chatKey: lockedChat.fingerprint,
          threadId: runtime.threadId,
          model: runtime.model,
          effort: runtime.effort,
          generation: taskGeneration,
          snapshot: current,
          phase: "reply-ready",
          pending: incoming,
          outboundFingerprint,
          action: currentAction,
        });
        await saveBridgeState(projectRoot, activeState);
        if (error.reason === "chat-changed" || error.reason === "editor-authority-lost") {
          process.exitCode = 4;
        }
        setBridgePhase(error.reason === "stop" ? "stopping" : "blocked");
        console.log(JSON.stringify({
          ok: error.reason === "stop",
          event: error.reason === "stop"
            ? "bridge-stop-requested-before-send"
            : error.reason === "editor-authority-lost"
              ? "editor-authority-lost-before-send"
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
          generation: taskGeneration,
          snapshot: afterSendSnapshot,
          phase: "blocked",
          pending: reboundRemaining,
          blockedReason: unsupportedDuringSend.length > 0
            ? "unsupported-incoming-batch"
            : "concurrent-outgoing-ambiguous",
          action: currentAction,
        });
        await saveBridgeState(projectRoot, activeState);
        console.log(JSON.stringify({
          ok: false,
          event: "activity-during-send-ambiguous-bridge-stopped",
        }));
        process.exitCode = 6;
        break;
      }
      currentAction = transitionDouyinAction(currentAction, "send-verified", {
        reactionOrdinalShift: appendedDuringSend.length,
      });
      activeState = createBridgeState({
        chatKey: lockedChat.fingerprint,
        threadId: runtime.threadId,
        model: runtime.model,
        effort: runtime.effort,
        generation: taskGeneration,
        snapshot: current,
        phase: "sending",
        pending: incoming,
        outboundFingerprint,
        action: currentAction,
      });
      await saveBridgeState(projectRoot, activeState);
      if (mediaReactionEnabled && mediaShouldLike && incomingBatch.mediaMessage) {
        currentAction = transitionDouyinAction(currentAction, "reaction-attempted");
        activeState = createBridgeState({
          chatKey: lockedChat.fingerprint,
          threadId: runtime.threadId,
          model: runtime.model,
          effort: runtime.effort,
          generation: taskGeneration,
          snapshot: current,
          phase: "sending",
          pending: incoming,
          outboundFingerprint,
          action: currentAction,
        });
        await saveBridgeState(projectRoot, activeState);
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
      activeState = createBridgeState({
        chatKey: lockedChat.fingerprint,
        threadId: runtime.threadId,
        model: runtime.model,
        effort: runtime.effort,
        generation: taskGeneration,
        snapshot: afterSendSnapshot,
        phase: reboundRemaining.length > 0 ? "queued" : "ready",
        pending: reboundRemaining,
      });
      await saveBridgeState(projectRoot, activeState);
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
        generation: taskGeneration,
        snapshot: current,
        phase: "blocked",
        pending: incoming,
        blockedReason: "context-recovery-failed",
        action: currentAction,
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
} catch (error) {
  if (uncommittedStartupThreadId) {
    await codex.request("thread/archive", { threadId: uncommittedStartupThreadId }).catch(() => {});
    uncommittedStartupThreadId = null;
  }
  throw error;
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
