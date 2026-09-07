import { CodexContextCompactionManager } from "./codex-context-compaction.mjs";
import {
  buildBridgeStartupViewExpression,
  normalizeOutboundText,
} from "./douyin-chat-page.mjs";
import {
  parseDouyinMediaReply,
  preparePersistentBridgeSession,
} from "./douyin-bridge-runtime.mjs";
import {
  createBridgeState,
  DouyinRecoverySafetyError,
  findAppendedMessages,
  loadBridgeState,
  normalizeBridgeSnapshot,
  recoverBridgeStateForFreshThread,
  recoverBridgeStateForStartup,
  saveBridgeState,
} from "./douyin-bridge-state.mjs";
import {
  computeDouyinReplyDigest,
  transitionDouyinAction,
} from "./douyin-action-journal.mjs";
import { likeIncomingDouyinMediaMessage } from "./douyin-media-reaction.mjs";
import { cleanupRecoveredDouyinMediaQuote } from "./douyin-message-quote.mjs";
import { DOUYIN_OUTBOUND_DEGRADED_REASON } from "./douyin-outbound-ledger.mjs";

export const douyinBridgeStartupDependencies = Object.freeze({
  CodexContextCompactionManager,
  DOUYIN_OUTBOUND_DEGRADED_REASON,
  buildBridgeStartupViewExpression,
  cleanupRecoveredDouyinMediaQuote,
  computeDouyinReplyDigest,
  createBridgeState,
  DouyinRecoverySafetyError,
  findAppendedMessages,
  likeIncomingDouyinMediaMessage,
  loadBridgeState,
  normalizeBridgeSnapshot,
  normalizeOutboundText,
  parseDouyinMediaReply,
  preparePersistentBridgeSession,
  recoverBridgeStateForFreshThread,
  recoverBridgeStateForStartup,
  saveBridgeState,
  transitionDouyinAction,
});

export async function recoverBridgeStartup({
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
  onDiagnostic,
  emitBridgeEvent,
  getBridgePhase,
  setBridgePhase,
  setContextManager,
  setUncommittedStartupThreadId,
  dependencies,
}) {
  const {
    CodexContextCompactionManager: ContextCompactionManager,
    DOUYIN_OUTBOUND_DEGRADED_REASON: outboundDegradedReason,
    buildBridgeStartupViewExpression,
    cleanupRecoveredDouyinMediaQuote,
    computeDouyinReplyDigest,
    createBridgeState,
    DouyinRecoverySafetyError,
    findAppendedMessages,
    likeIncomingDouyinMediaMessage,
    loadBridgeState,
    normalizeBridgeSnapshot,
    normalizeOutboundText,
    parseDouyinMediaReply,
    preparePersistentBridgeSession,
    recoverBridgeStateForFreshThread,
    recoverBridgeStateForStartup,
    saveBridgeState,
    transitionDouyinAction,
  } = dependencies;

  const startupView = await cdp.evaluate(buildBridgeStartupViewExpression());
  if (!startupView?.ok) throw new Error("The Douyin message list is unavailable.");
  if (startupView.chatFingerprint !== lockedChat.fingerprint) {
    throw new Error("The Douyin chat changed during startup; refusing to seed the wrong conversation.");
  }
  const startupSnapshot = normalizeBridgeSnapshot(startupView.snapshot);
  const loadedState = await loadBridgeState(projectRoot, lockedChat.fingerprint);
  if (loadedState.status === "corrupt") {
    throw new DouyinRecoverySafetyError(
      "Both bridge checkpoint copies are unreadable; refusing an ambiguous restart.",
    );
  }
  let storedState = loadedState.state;
  let recoveredVerifiedSend = false;
  let recoveredForFreshThread = false;
  let recoveredDegradation = false;
  let recoveredLegacySystemBlock = false;
  let degradedOutgoing = false;
  let startupQueuedPending = null;
  let startupResumeAction = null;
  if (storedState) {
    const canAttemptFreshRecovery = forceFreshThread
      && storedState.checkpoint.phase !== "ready"
      && storedState.checkpoint.phase !== "sending"
      && storedState.checkpoint.phase !== "degraded";
    const recovery = canAttemptFreshRecovery
      ? recoverBridgeStateForFreshThread(storedState, startupSnapshot)
      : recoverBridgeStateForStartup(storedState, startupSnapshot);
    storedState = recovery.state;
    recoveredVerifiedSend = recovery.recoveredVerifiedSend;
    recoveredForFreshThread = canAttemptFreshRecovery;
    recoveredDegradation = Boolean(recovery.recoveredDegradation);
    recoveredLegacySystemBlock = Boolean(recovery.recoveredLegacySystemBlock);
    degradedOutgoing = Boolean(recovery.degradedOutgoing);
    startupQueuedPending = recovery.queuedPending?.length > 0
      ? recovery.queuedPending
      : null;
    startupResumeAction = recovery.resumeAction ?? null;
    // Keep the original sending checkpoint durable until quote cleanup succeeds.
    // A crash here will therefore repeat the same idempotent recovery on restart.
    if (recoveredVerifiedSend && startupResumeAction?.quoteTargetFingerprint) {
      await cleanupRecoveredDouyinMediaQuote({
        cdp,
        expectedChatFingerprint: lockedChat.fingerprint,
        quoteNonce: startupResumeAction.id.slice(0, 24),
        quoteTargetFingerprint: startupResumeAction.quoteTargetFingerprint,
      });
    }
    if (recoveredVerifiedSend || recoveredForFreshThread || startupQueuedPending
        || recovery.checkpointChanged) {
      await saveBridgeState(projectRoot, storedState);
    }
  }
  const startupPendingMessages = startupQueuedPending ?? (storedState
    ? findAppendedMessages(storedState.checkpoint.snapshot, startupSnapshot)
    : []);

  const session = await preparePersistentBridgeSession({
    codex,
    cwd: companionCwd,
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
  if (!runtime.resumed) setUncommittedStartupThreadId(runtime.threadId);
  let phaseBeforeCompaction = null;
  const contextManager = new ContextCompactionManager({
    codex,
    threadId: runtime.threadId,
    generation: taskGeneration,
    ...compactionPolicy,
    onDiagnostic,
    onOperationStart: () => {
      phaseBeforeCompaction = getBridgePhase();
      setBridgePhase("compacting");
    },
    onOperationEnd: () => {
      if (getBridgePhase() === "compacting") {
        setBridgePhase(phaseBeforeCompaction || "listening");
      }
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
  setContextManager(contextManager);
  const previous = normalizeBridgeSnapshot(session.baselineSnapshot);
  const queuedIncoming = startupQueuedPending;
  let resumedReply = null;
  if (startupResumeAction
      && ["turn-started", "reply-ready"].includes(startupResumeAction.stage)) {
    const turnId = startupResumeAction.turnIds.at(-1);
    const recoveredTurn = await codex.readTurn({ threadId: runtime.threadId, turnId });
    if (!recoveredTurn.found || recoveredTurn.status !== "completed" || !recoveredTurn.text) {
      throw new DouyinRecoverySafetyError(
        "The persisted Codex turn cannot be recovered without duplication.",
      );
    }
    let recoveredReply;
    let reactionDecision = "disabled";
    let shouldLike = false;
    if (startupResumeAction.replyKind === "text") {
      recoveredReply = normalizeOutboundText(recoveredTurn.text);
    } else {
      let parsed;
      try {
        parsed = parseDouyinMediaReply(recoveredTurn.text, {
          reactionEnabled: Boolean(startupResumeAction.reactionNonce),
          nonce: startupResumeAction.reactionNonce,
        });
      } catch (error) {
        throw new DouyinRecoverySafetyError(
          "The persisted Codex media reply is invalid.",
          { cause: error },
        );
      }
      recoveredReply = parsed.reply;
      reactionDecision = parsed.reactionDecision;
      shouldLike = parsed.shouldLike;
    }
    if (!recoveredReply) {
      throw new DouyinRecoverySafetyError("The persisted Codex reply is empty.");
    }
    const replyDigest = computeDouyinReplyDigest(recoveredReply);
    if (startupResumeAction.replyDigest
        && startupResumeAction.replyDigest !== replyDigest) {
      throw new DouyinRecoverySafetyError(
        "The persisted Codex reply digest does not match the recovered turn.",
      );
    }
    resumedReply = {
      action: startupResumeAction,
      reply: recoveredReply,
      replyKind: startupResumeAction.replyKind,
      mediaShouldLike: shouldLike,
    };
  }
  let activeState;
  const persistState = async (phase, overrides) => {
    activeState = createBridgeState({
      chatKey: lockedChat.fingerprint,
      threadId: runtime.threadId,
      model: runtime.model,
      effort: runtime.effort,
      generation: taskGeneration,
      phase,
      ...overrides,
    });
    await saveBridgeState(projectRoot, activeState);
  };
  if (degradedOutgoing) {
    await persistState("degraded", {
      snapshot: previous,
      pending: queuedIncoming ?? [],
      blockedReason: outboundDegradedReason,
      action: startupResumeAction,
    });
  } else if (resumedReply) {
    await persistState("queued", {
      snapshot: previous,
      pending: queuedIncoming,
      action: resumedReply.action,
    });
  } else if (queuedIncoming) {
    await persistState("queued", {
      snapshot: previous,
      pending: queuedIncoming,
      action: startupResumeAction,
    });
  } else {
    await persistState("ready", {
      snapshot: previous,
      outboundFingerprint: storedState?.checkpoint.outboundFingerprint ?? null,
      action: startupResumeAction,
    });
  }
  if (!degradedOutgoing && startupResumeAction
      && ["send-verified", "reaction-attempted"].includes(startupResumeAction.stage)) {
    if (startupResumeAction.stage === "send-verified"
        && startupResumeAction.reactionDecision === "yes"
        && startupResumeAction.reactionTarget) {
      startupResumeAction = transitionDouyinAction(
        startupResumeAction,
        "reaction-attempted",
      );
      await persistState(queuedIncoming?.length ? "queued" : "ready", {
        snapshot: previous,
        pending: queuedIncoming ?? [],
        action: startupResumeAction,
      });
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
    await persistState(queuedIncoming?.length ? "queued" : "ready", {
      snapshot: previous,
      pending: queuedIncoming ?? [],
    });
  }
  setUncommittedStartupThreadId(null);

  return {
    contextManager,
    getActiveState: () => activeState,
    loadedState,
    persistState,
    previous,
    queuedIncoming,
    degradedOutgoing,
    recoveredDegradation,
    recoveredForFreshThread,
    recoveredLegacySystemBlock,
    recoveredVerifiedSend,
    resumedReply,
    runtime,
    session,
    storedState,
    taskGeneration,
  };
}
