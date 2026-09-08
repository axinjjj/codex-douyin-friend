import test from "node:test";
import assert from "node:assert/strict";
import { recoverBridgeStartup } from "../src/douyin-bridge-startup.mjs";

class FakeRecoverySafetyError extends Error {}

function createHarness({
  loadedState = { status: "missing", state: null, requiresFreshThread: false },
  recovery = null,
  recoveredTurn = null,
  resumed = false,
  startupHasUnreadyDirectImage = false,
} = {}) {
  const calls = [];
  const savedStates = [];
  const uncommittedThreadIds = [];
  const contextManagers = [];
  let preparedSessionParams = null;
  const startupSnapshot = { source: "startup" };
  const baselineSnapshot = { source: "baseline" };
  const runtime = {
    threadId: resumed ? "thread-resumed" : "thread-new",
    model: "model-live",
    effort: "high",
    resumed,
  };

  class FakeContextCompactionManager {
    constructor(options) {
      this.options = options;
      this.policy = { enabled: true };
      calls.push("context-manager-created");
    }
  }

  const dependencies = {
    CodexContextCompactionManager: FakeContextCompactionManager,
    DOUYIN_OUTBOUND_DEGRADED_REASON: "unknown-outgoing-observed",
    buildBridgeStartupViewExpression() {
      calls.push("startup-expression-built");
      return "startup-expression";
    },
    containsUnreadyDouyinDirectImage() {
      calls.push("direct-image-readiness-checked");
      return startupHasUnreadyDirectImage;
    },
    async cleanupRecoveredDouyinMediaQuote() {
      calls.push("quote-cleaned");
    },
    computeDouyinReplyDigest() {
      return "reply-digest";
    },
    createBridgeState(value) {
      calls.push(`state-created:${value.phase}`);
      return {
        ...value,
        checkpoint: {
          phase: value.phase,
          snapshot: value.snapshot,
          pending: value.pending ?? [],
          outboundFingerprint: value.outboundFingerprint ?? null,
          blockedReason: value.blockedReason ?? null,
          action: value.action ?? null,
        },
      };
    },
    DouyinRecoverySafetyError: FakeRecoverySafetyError,
    findAppendedMessages() {
      calls.push("appended-found");
      return [];
    },
    async likeIncomingDouyinMediaMessage() {
      calls.push("media-liked");
    },
    async loadBridgeState() {
      calls.push("state-loaded");
      return loadedState;
    },
    normalizeBridgeSnapshot(snapshot) {
      calls.push(`snapshot-normalized:${snapshot.source}`);
      return snapshot === startupSnapshot
        ? { normalized: "startup" }
        : { normalized: "baseline" };
    },
    normalizeOutboundText(text) {
      return text.trim();
    },
    parseDouyinMediaReply() {
      throw new Error("media parsing was not expected");
    },
    async preparePersistentBridgeSession(params) {
      calls.push("session-prepared");
      preparedSessionParams = params;
      return {
        runtime,
        baselineSnapshot,
        seededMessageCount: 0,
        replacedStoredThread: false,
      };
    },
    recoverBridgeStateForFreshThread() {
      calls.push("fresh-state-recovered");
      return recovery;
    },
    recoverBridgeStateForStartup() {
      calls.push("startup-state-recovered");
      return recovery;
    },
    async saveBridgeState(_projectRoot, state) {
      calls.push(`state-saved:${state.checkpoint?.phase ?? "existing"}`);
      savedStates.push(state);
    },
    transitionDouyinAction() {
      throw new Error("action transition was not expected");
    },
  };
  const cdp = {
    async evaluate(expression) {
      calls.push(`cdp-evaluated:${expression}`);
      return {
        ok: true,
        chatFingerprint: "chat-key",
        snapshot: startupSnapshot,
        conversation: ["visible-message"],
      };
    },
  };
  const codex = {
    async readTurn(params) {
      calls.push(`turn-read:${params.turnId}`);
      return recoveredTurn;
    },
  };
  const args = {
    cdp,
    codex,
    projectRoot: "project-root",
    lockedChat: { fingerprint: "chat-key" },
    forceFreshThread: false,
    companionCwd: "companion-cwd",
    expectedPersonaPath: "persona-path",
    model: "requested-model",
    effort: "requested-effort",
    compactionPolicy: { threshold: 10 },
    supervised: false,
    onDiagnostic() {},
    emitBridgeEvent() {},
    getBridgePhase: () => "starting",
    setBridgePhase() {},
    setContextManager(manager) {
      calls.push("context-manager-set");
      contextManagers.push(manager);
    },
    setUncommittedStartupThreadId(threadId) {
      calls.push(`uncommitted-set:${threadId}`);
      uncommittedThreadIds.push(threadId);
    },
    dependencies,
  };

  return {
    args,
    calls,
    contextManagers,
    getPreparedSessionParams: () => preparedSessionParams,
    runtime,
    savedStates,
    uncommittedThreadIds,
  };
}

test("starts normally without stored state and persists one ready checkpoint", async () => {
  const harness = createHarness();
  const result = await recoverBridgeStartup(harness.args);

  assert.equal(result.loadedState.status, "missing");
  assert.equal(result.storedState, null);
  assert.equal(result.runtime, harness.runtime);
  assert.equal(result.taskGeneration, 1);
  assert.equal(result.queuedIncoming, null);
  assert.equal(result.recoveredForFreshThread, false);
  assert.equal(result.recoveredVerifiedSend, false);
  assert.equal(result.resumedReply, null);
  assert.deepEqual(harness.getPreparedSessionParams().pendingMessages, []);
  assert.deepEqual(harness.uncommittedThreadIds, ["thread-new", null]);
  assert.equal(harness.contextManagers.length, 1);
  assert.equal(harness.savedStates.length, 1);
  assert.equal(harness.savedStates[0].checkpoint.phase, "ready");
  assert.deepEqual(harness.savedStates[0].checkpoint.snapshot, { normalized: "baseline" });
  assert.equal(result.getActiveState(), harness.savedStates[0]);
  assert.ok(
    harness.calls.indexOf("context-manager-set")
      < harness.calls.indexOf("state-saved:ready"),
  );
});

test("waits for visible direct images to load before checkpoint recovery", async () => {
  const harness = createHarness({ startupHasUnreadyDirectImage: true });

  await assert.rejects(
    recoverBridgeStartup(harness.args),
    /direct Douyin image is still loading/u,
  );
  assert.ok(harness.calls.includes("direct-image-readiness-checked"));
  assert.equal(harness.calls.includes("state-loaded"), false);
  assert.equal(harness.calls.includes("session-prepared"), false);
});

test("recovers a pending action and reuses its completed Codex turn", async () => {
  const action = {
    stage: "turn-started",
    turnIds: ["turn-1"],
    replyKind: "text",
    replyDigest: null,
    reactionNonce: null,
  };
  const storedState = {
    generation: 7,
    checkpoint: { phase: "processing", snapshot: { normalized: "old" } },
  };
  const pending = [{ fingerprint: "pending-message" }];
  const harness = createHarness({
    loadedState: { status: "primary", state: storedState, requiresFreshThread: false },
    recovery: {
      state: storedState,
      recoveredVerifiedSend: false,
      queuedPending: pending,
      resumeAction: action,
    },
    recoveredTurn: { found: true, status: "completed", text: " recovered reply " },
    resumed: true,
  });

  const result = await recoverBridgeStartup(harness.args);

  assert.equal(result.taskGeneration, 7);
  assert.equal(result.queuedIncoming, pending);
  assert.equal(result.recoveredForFreshThread, false);
  assert.equal(result.recoveredVerifiedSend, false);
  assert.deepEqual(result.resumedReply, {
    action,
    reply: "recovered reply",
    replyKind: "text",
    mediaShouldLike: false,
  });
  assert.equal(harness.getPreparedSessionParams().pendingMessages, pending);
  assert.deepEqual(harness.uncommittedThreadIds, [null]);
  assert.equal(harness.savedStates.length, 2);
  assert.equal(harness.savedStates[0], storedState);
  assert.equal(harness.savedStates[1].checkpoint.phase, "queued");
  assert.equal(harness.savedStates[1].checkpoint.action, action);
  assert.ok(
    harness.calls.indexOf("state-saved:processing")
      < harness.calls.indexOf("session-prepared"),
  );
  assert.ok(
    harness.calls.indexOf("turn-read:turn-1")
      < harness.calls.indexOf("state-saved:queued"),
  );
});

test("fails closed when a pending action turn cannot be recovered", async () => {
  const action = {
    stage: "turn-started",
    turnIds: ["turn-missing"],
    replyKind: "text",
    replyDigest: null,
    reactionNonce: null,
  };
  const storedState = {
    generation: 3,
    checkpoint: { phase: "processing", snapshot: { normalized: "old" } },
  };
  const harness = createHarness({
    loadedState: { status: "primary", state: storedState, requiresFreshThread: false },
    recovery: {
      state: storedState,
      recoveredVerifiedSend: false,
      queuedPending: [{ fingerprint: "pending-message" }],
      resumeAction: action,
    },
    recoveredTurn: { found: false, status: null, text: null },
    resumed: true,
  });

  await assert.rejects(
    () => recoverBridgeStartup(harness.args),
    (error) => error instanceof FakeRecoverySafetyError
      && /cannot be recovered without duplication/u.test(error.message),
  );
  assert.equal(harness.contextManagers.length, 1);
  assert.equal(harness.savedStates.length, 1);
  assert.equal(harness.savedStates[0], storedState);
  assert.deepEqual(harness.uncommittedThreadIds, []);
  assert.equal(harness.calls.includes("state-saved:queued"), false);
});

test("keeps a recovered unknown-outgoing degradation durable across startup", async () => {
  const storedState = {
    generation: 4,
    checkpoint: { phase: "degraded", snapshot: { normalized: "degraded" } },
  };
  const pending = [{ fingerprint: "pending-message" }];
  const harness = createHarness({
    loadedState: { status: "primary", state: storedState, requiresFreshThread: false },
    recovery: {
      state: storedState,
      recoveredVerifiedSend: false,
      queuedPending: pending,
      degradedOutgoing: true,
      recoveredDegradation: false,
      checkpointChanged: true,
    },
    resumed: true,
  });

  const result = await recoverBridgeStartup(harness.args);

  assert.equal(result.degradedOutgoing, true);
  assert.equal(result.recoveredDegradation, false);
  assert.equal(result.queuedIncoming, pending);
  assert.equal(harness.savedStates.length, 2);
  assert.equal(harness.savedStates[0], storedState);
  assert.equal(harness.savedStates[1].checkpoint.phase, "degraded");
  assert.equal(harness.savedStates[1].checkpoint.blockedReason, "unknown-outgoing-observed");
  assert.deepEqual(harness.savedStates[1].checkpoint.pending, pending);
});
