import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

const STATE_VERSION = 1;
const MAX_VISIBLE_MESSAGES = 12;
const CHAT_KEY_PATTERN = /^[0-9a-f]{64}$/u;
const MESSAGE_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const THREAD_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u;
const MODEL_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/u;
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const SIDES = new Set(["left", "right", "center"]);
const KINDS = new Set(["text", "media", "system", "unknown"]);
const PHASES = new Set(["ready", "queued", "processing", "reply-ready", "sending", "blocked"]);
const BLOCKED_REASON_PATTERN = /^[a-z0-9-]{1,80}$/u;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function normalizeMessageMetadata(message) {
  if (!hasExactKeys(message, ["fingerprint", "kind", "side"])) {
    throw new Error("Bridge state contains unsupported message metadata.");
  }
  if (!MESSAGE_FINGERPRINT_PATTERN.test(message.fingerprint)) {
    throw new Error("Bridge state contains an invalid message fingerprint.");
  }
  if (!KINDS.has(message.kind) || !SIDES.has(message.side)) {
    throw new Error("Bridge state contains invalid message metadata.");
  }
  return {
    fingerprint: message.fingerprint,
    kind: message.kind,
    side: message.side,
  };
}

export function normalizeBridgeSnapshot(snapshot) {
  if (!hasExactKeys(snapshot, ["messageCount", "messages"])) {
    throw new Error("Bridge checkpoint snapshot has an invalid shape.");
  }
  if (!Number.isSafeInteger(snapshot.messageCount) || snapshot.messageCount < 0) {
    throw new Error("Bridge checkpoint message count is invalid.");
  }
  if (!Array.isArray(snapshot.messages) || snapshot.messages.length > MAX_VISIBLE_MESSAGES) {
    throw new Error("Bridge checkpoint visible-message window is invalid.");
  }
  if (snapshot.messageCount < snapshot.messages.length) {
    throw new Error("Bridge checkpoint message count is smaller than its visible window.");
  }
  return {
    messageCount: snapshot.messageCount,
    messages: snapshot.messages.map((message) => normalizeMessageMetadata({
      fingerprint: message?.fingerprint,
      kind: message?.kind,
      side: message?.side,
    })),
  };
}

export function createBridgeState({
  chatKey,
  threadId,
  model,
  effort,
  snapshot,
  phase = "ready",
  pending = [],
  outboundFingerprint = null,
  blockedReason = null,
}) {
  const candidate = {
    version: STATE_VERSION,
    chatKey,
    threadId,
    model,
    effort,
    checkpoint: {
      phase,
      snapshot: normalizeBridgeSnapshot(snapshot),
      pending: pending.map((message) => normalizeMessageMetadata({
        fingerprint: message?.fingerprint,
        kind: message?.kind,
        side: message?.side,
      })),
      outboundFingerprint,
      blockedReason,
    },
  };
  return validateBridgeState(candidate);
}

export function validateBridgeState(value, expectedChatKey = null) {
  if (!hasExactKeys(value, ["version", "chatKey", "threadId", "model", "effort", "checkpoint"])) {
    throw new Error("Bridge state has an invalid shape.");
  }
  if (value.version !== STATE_VERSION) throw new Error("Bridge state version is incompatible.");
  if (!CHAT_KEY_PATTERN.test(value.chatKey) || (expectedChatKey && value.chatKey !== expectedChatKey)) {
    throw new Error("Bridge state chat key is invalid.");
  }
  if (!THREAD_ID_PATTERN.test(value.threadId)) throw new Error("Bridge state thread id is invalid.");
  if (!MODEL_PATTERN.test(value.model)) throw new Error("Bridge state model is invalid.");
  if (!EFFORTS.has(value.effort)) throw new Error("Bridge state effort is invalid.");
  if (!hasExactKeys(
    value.checkpoint,
    ["phase", "snapshot", "pending", "outboundFingerprint", "blockedReason"],
  )) {
    throw new Error("Bridge checkpoint has an invalid shape.");
  }

  const phase = value.checkpoint.phase;
  if (!PHASES.has(phase)) throw new Error("Bridge checkpoint phase is invalid.");
  const snapshot = normalizeBridgeSnapshot(value.checkpoint.snapshot);
  if (!Array.isArray(value.checkpoint.pending) || value.checkpoint.pending.length > MAX_VISIBLE_MESSAGES) {
    throw new Error("Bridge checkpoint pending-message list is invalid.");
  }
  const pending = value.checkpoint.pending.map(normalizeMessageMetadata);
  const outboundFingerprint = value.checkpoint.outboundFingerprint;
  if (outboundFingerprint !== null && !MESSAGE_FINGERPRINT_PATTERN.test(outboundFingerprint)) {
    throw new Error("Bridge checkpoint outbound fingerprint is invalid.");
  }
  const blockedReason = value.checkpoint.blockedReason;
  if (blockedReason !== null && !BLOCKED_REASON_PATTERN.test(blockedReason)) {
    throw new Error("Bridge checkpoint blocked reason is invalid.");
  }

  if (phase === "ready" && (pending.length !== 0 || blockedReason !== null)) {
    throw new Error("A ready bridge checkpoint cannot contain pending work.");
  }
  if (phase === "queued" && (pending.length === 0 || outboundFingerprint !== null || blockedReason !== null
      || pending.some((message) => (
        message.side !== "left" || (message.kind !== "text" && message.kind !== "media")
      )))) {
    throw new Error("A queued bridge checkpoint is inconsistent.");
  }
  if (phase === "processing" && (pending.length === 0 || outboundFingerprint !== null || blockedReason !== null)) {
    throw new Error("A processing bridge checkpoint is inconsistent.");
  }
  if ((phase === "reply-ready" || phase === "sending")
      && (pending.length === 0 || outboundFingerprint === null || blockedReason !== null)) {
    throw new Error("An outbound bridge checkpoint is inconsistent.");
  }
  if (phase === "blocked" && (blockedReason === null || outboundFingerprint !== null)) {
    throw new Error("A blocked bridge checkpoint is inconsistent.");
  }

  return {
    version: STATE_VERSION,
    chatKey: value.chatKey,
    threadId: value.threadId,
    model: value.model,
    effort: value.effort,
    checkpoint: {
      phase,
      snapshot,
      pending,
      outboundFingerprint,
      blockedReason,
    },
  };
}

export function resolveBridgeStatePath(projectRoot, chatKey) {
  if (!CHAT_KEY_PATTERN.test(chatKey)) throw new Error("Refusing an invalid Douyin chat key.");
  return path.resolve(projectRoot, ".runtime", "douyin-bridge-state", `v${STATE_VERSION}`, `${chatKey}.json`);
}

export function resolveBridgeRecoveryStatePath(projectRoot, chatKey) {
  const primaryPath = resolveBridgeStatePath(projectRoot, chatKey);
  return primaryPath.replace(/\.json$/u, ".recovery.json");
}

async function readStateFile(filePath, chatKey) {
  try {
    const serialized = await readFile(filePath, "utf8");
    return { status: "ok", state: validateBridgeState(JSON.parse(serialized), chatKey) };
  } catch (error) {
    if (error.code === "ENOENT") return { status: "missing", state: null };
    return { status: "corrupt", state: null };
  }
}

export async function loadBridgeState(projectRoot, chatKey) {
  const filePath = resolveBridgeStatePath(projectRoot, chatKey);
  const recoveryFilePath = resolveBridgeRecoveryStatePath(projectRoot, chatKey);
  const primary = await readStateFile(filePath, chatKey);
  if (primary.status === "ok") {
    return { status: "ok", filePath, recoveryFilePath, state: primary.state };
  }
  const recovery = await readStateFile(recoveryFilePath, chatKey);
  if (recovery.status === "ok") {
    return {
      status: "recovered",
      filePath,
      recoveryFilePath,
      state: recovery.state,
      requiresFreshThread: true,
    };
  }
  return {
    status: primary.status === "missing" && recovery.status === "missing" ? "missing" : "corrupt",
    filePath,
    recoveryFilePath,
    state: null,
  };
}

export async function acquireBridgeRunLock(projectRoot, chatKey) {
  resolveBridgeStatePath(projectRoot, chatKey);
  if (process.platform !== "win32") {
    throw new Error("The Douyin bridge run lock currently requires Windows.");
  }
  const endpoint = `\\\\.\\pipe\\codex-douyin-bridge-v${STATE_VERSION}-${chatKey}`;
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error("Another bridge process already owns this Douyin chat; refusing to start."));
      } else {
        reject(error);
      }
    });
    server.listen(endpoint, resolve);
  });

  let released = false;
  return {
    endpoint,
    async release() {
      if (released) return;
      released = true;
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

async function writeAtomicStateFile(filePath, serialized) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle = null;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(serialized, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function saveBridgeState(projectRoot, state) {
  const normalized = validateBridgeState(state);
  const filePath = resolveBridgeStatePath(projectRoot, normalized.chatKey);
  const recoveryFilePath = resolveBridgeRecoveryStatePath(projectRoot, normalized.chatKey);
  const serialized = `${JSON.stringify(normalized)}\n`;
  await writeAtomicStateFile(filePath, serialized);
  await writeAtomicStateFile(recoveryFilePath, serialized);
  return filePath;
}

function sameMessage(left, right) {
  return left.fingerprint === right.fingerprint
    && left.kind === right.kind
    && left.side === right.side;
}

export function rebindPendingMessages(snapshot, pendingMessages) {
  const current = normalizeBridgeSnapshot(snapshot);
  if (!Array.isArray(pendingMessages) || pendingMessages.length === 0
      || pendingMessages.length > MAX_VISIBLE_MESSAGES) {
    throw new Error("A bounded pending-message queue is required.");
  }
  const pending = pendingMessages.map((message) => normalizeMessageMetadata({
    fingerprint: message?.fingerprint,
    kind: message?.kind,
    side: message?.side,
  }));
  const rebound = new Array(pending.length);
  let currentIndex = current.messages.length - 1;
  for (let pendingIndex = pending.length - 1; pendingIndex >= 0; pendingIndex -= 1) {
    while (currentIndex >= 0 && !sameMessage(pending[pendingIndex], current.messages[currentIndex])) {
      currentIndex -= 1;
    }
    if (currentIndex < 0) {
      throw new Error("A queued Douyin message is no longer visible at its checkpoint.");
    }
    rebound[pendingIndex] = {
      ...pending[pendingIndex],
      ordinalFromEnd: current.messages.length - currentIndex,
    };
    currentIndex -= 1;
  }
  return rebound;
}

function firstPendingBatchLength(pending) {
  let length = 0;
  while (length < pending.length && pending[length].kind === "text") length += 1;
  if (length < pending.length && pending[length].kind === "media") return length + 1;
  if (length === pending.length) return length;
  throw new Error("The persisted Douyin queue contains an unsupported message kind.");
}

export function findAppendedMessages(previousSnapshot, currentSnapshot) {
  const previous = normalizeBridgeSnapshot(previousSnapshot);
  const current = normalizeBridgeSnapshot(currentSnapshot);
  const appendedCount = current.messageCount - previous.messageCount;

  if (appendedCount === 0
      && previous.messages.length === current.messages.length
      && current.messages.length >= 3) {
    let overlapCount = 0;
    for (let candidate = current.messages.length - 1; candidate >= 2; candidate -= 1) {
      const previousBoundary = previous.messages.slice(-candidate);
      const currentBoundary = current.messages.slice(0, candidate);
      if (previousBoundary.every((message, index) => sameMessage(message, currentBoundary[index]))) {
        overlapCount = candidate;
        break;
      }
    }
    if (overlapCount > 0) {
      return current.messages.slice(overlapCount).map((message, index) => ({
        ...message,
        ordinalFromEnd: current.messages.length - overlapCount - index,
      }));
    }
  }

  if (appendedCount < 0) {
    throw new Error("Douyin message count moved backwards; refusing checkpoint recovery.");
  }
  if (appendedCount > current.messages.length) {
    throw new Error("New Douyin messages exceed the visible checkpoint window.");
  }

  const retainedCount = current.messages.length - appendedCount;
  if (retainedCount > previous.messages.length) {
    throw new Error("Douyin visible history grew without an append-only checkpoint boundary.");
  }
  const retainedPrevious = previous.messages.slice(previous.messages.length - retainedCount);
  const retainedCurrent = current.messages.slice(0, retainedCount);
  if (!retainedPrevious.every((message, index) => sameMessage(message, retainedCurrent[index]))) {
    throw new Error("Douyin visible history no longer matches the persisted checkpoint.");
  }

  return current.messages.slice(retainedCount).map((message, index) => ({
    ...message,
    ordinalFromEnd: current.messages.length - retainedCount - index,
  }));
}

export function computeTextMessageFingerprint(text, side = "right") {
  if (side !== "left" && side !== "right") throw new Error("Text message side is invalid.");
  const structuralKey = ["text", side, String(text ?? "").trim()].join("|");
  return createHash("sha256").update(structuralKey, "utf8").digest("hex");
}

export function recoverBridgeStateForStartup(state, currentSnapshot) {
  const normalized = validateBridgeState(state);
  if (normalized.checkpoint.phase === "ready") {
    return { state: normalized, recoveredVerifiedSend: false };
  }
  if (normalized.checkpoint.phase === "queued") {
    const current = normalizeBridgeSnapshot(currentSnapshot);
    const appended = findAppendedMessages(normalized.checkpoint.snapshot, current);
    if (appended.some((message) => message.side === "right")) {
      throw new Error("Unexpected outgoing activity appeared while a media queue was paused.");
    }
    const unsupportedIncoming = appended.filter((message) => (
      message.side === "left" && message.kind !== "text" && message.kind !== "media"
    ));
    if (unsupportedIncoming.length > 0) {
      throw new Error("Unsupported incoming activity appeared while a media queue was paused.");
    }
    const queuedPending = rebindPendingMessages(current, [
      ...normalized.checkpoint.pending,
      ...appended.filter((message) => (
        message.side === "left" && (message.kind === "text" || message.kind === "media")
      )),
    ]);
    return {
      state: createBridgeState({
        chatKey: normalized.chatKey,
        threadId: normalized.threadId,
        model: normalized.model,
        effort: normalized.effort,
        snapshot: current,
        phase: "queued",
        pending: queuedPending,
      }),
      recoveredVerifiedSend: false,
      queuedPending,
    };
  }
  if (normalized.checkpoint.phase !== "sending") {
    throw new Error("The persisted bridge checkpoint is incomplete; refusing automatic recovery.");
  }

  const current = normalizeBridgeSnapshot(currentSnapshot);
  const appended = findAppendedMessages(normalized.checkpoint.snapshot, current);
  const outgoing = appended.filter((message) => message.side === "right");
  const sent = outgoing.length === 1
    && outgoing[0].kind === "text"
    && outgoing[0].fingerprint === normalized.checkpoint.outboundFingerprint;
  if (!sent) {
    throw new Error("The previous Douyin send cannot be verified; refusing to resend.");
  }
  const unsupportedIncoming = appended.filter((message) => (
    message.side === "left" && message.kind !== "text" && message.kind !== "media"
  ));
  if (unsupportedIncoming.length > 0) {
    throw new Error("Unsupported incoming activity appeared while a verified send was recovering.");
  }
  const completedBatchLength = firstPendingBatchLength(normalized.checkpoint.pending);
  const queuedMessages = [
    ...normalized.checkpoint.pending.slice(completedBatchLength),
    ...appended.filter((message) => (
      message.side === "left" && (message.kind === "text" || message.kind === "media")
    )),
  ];
  const queuedPending = queuedMessages.length > 0
    ? rebindPendingMessages(current, queuedMessages)
    : [];

  return {
    state: createBridgeState({
      chatKey: normalized.chatKey,
      threadId: normalized.threadId,
      model: normalized.model,
      effort: normalized.effort,
      snapshot: current,
      phase: queuedPending.length > 0 ? "queued" : "ready",
      pending: queuedPending,
    }),
    recoveredVerifiedSend: true,
    queuedPending,
  };
}

export function recoverBridgeStateForFreshThread(state, currentSnapshot) {
  const normalized = validateBridgeState(state);
  const phase = normalized.checkpoint.phase;
  const explicitlyRecoverable = phase === "processing"
    || phase === "reply-ready"
    || phase === "queued"
    || (phase === "blocked" && normalized.checkpoint.blockedReason === "context-recovery-failed");
  if (!explicitlyRecoverable || normalized.checkpoint.pending.length === 0) {
    throw new Error("The persisted bridge checkpoint cannot be moved to a fresh thread safely.");
  }
  const current = normalizeBridgeSnapshot(currentSnapshot);
  const checkpoint = normalized.checkpoint.snapshot;
  if (current.messageCount !== checkpoint.messageCount
      || current.messages.length !== checkpoint.messages.length
      || !current.messages.every((message, index) => sameMessage(message, checkpoint.messages[index]))) {
    throw new Error("The Douyin chat changed after interrupted work; refusing fresh-thread recovery.");
  }
  if (phase === "queued") {
    const queuedPending = rebindPendingMessages(current, normalized.checkpoint.pending);
    return {
      state: createBridgeState({
        chatKey: normalized.chatKey,
        threadId: normalized.threadId,
        model: normalized.model,
        effort: normalized.effort,
        snapshot: current,
        phase: "queued",
        pending: queuedPending,
      }),
      recoveredPendingCount: queuedPending.length,
      queuedPending,
    };
  }
  const pending = normalized.checkpoint.pending;
  if (pending.length > checkpoint.messages.length) {
    throw new Error("The interrupted pending batch is outside the visible checkpoint window.");
  }
  const pendingBoundary = checkpoint.messages.slice(-pending.length);
  if (!pending.every((message, index) => sameMessage(message, pendingBoundary[index]))) {
    throw new Error("The interrupted pending batch no longer matches the checkpoint boundary.");
  }
  const baselineSnapshot = {
    messageCount: checkpoint.messageCount - pending.length,
    messages: checkpoint.messages.slice(0, -pending.length),
  };
  return {
    state: createBridgeState({
      chatKey: normalized.chatKey,
      threadId: normalized.threadId,
      model: normalized.model,
      effort: normalized.effort,
      snapshot: baselineSnapshot,
    }),
    recoveredPendingCount: pending.length,
  };
}
