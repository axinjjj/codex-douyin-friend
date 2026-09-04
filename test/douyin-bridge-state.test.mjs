import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireBridgeRunLock,
  computeTextMessageFingerprint,
  createBridgeState,
  findAppendedMessages,
  loadBridgeState,
  rebindPendingMessages,
  recoverBridgeStateForFreshThread,
  recoverBridgeStateForStartup,
  resolveBridgeRecoveryStatePath,
  resolveBridgeStatePath,
  saveBridgeState,
} from "../src/douyin-bridge-state.mjs";

const chatKey = "c".repeat(64);
const fingerprint = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const message = (character, side = "left", kind = "text") => ({
  fingerprint: fingerprint(character),
  kind,
  side,
});
const snapshot = (messageCount, messages) => ({ messageCount, messages });

function readyState(checkpointSnapshot = snapshot(1, [message("a")])) {
  return createBridgeState({
    chatKey,
    threadId: "thread-1",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    snapshot: checkpointSnapshot,
  });
}

function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      reject(new Error("Timed out waiting for the lock fixture to exit."));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", onExit);
  });
}

function waitForReady(child, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.removeListener("data", onData);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
    };
    const onData = (value) => {
      if (!value.includes("ready")) return;
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Lock fixture exited early with code ${code}.`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for the lock fixture."));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

test("persists only non-sensitive allowlisted state with an atomic replacement", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-douyin-state-"));
  try {
    const privacyState = createBridgeState({
      chatKey,
      threadId: "thread-1",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      snapshot: snapshot(1, [{ ...message("a"), text: "private body", nickname: "private nickname" }]),
    });
    const filePath = await saveBridgeState(projectRoot, privacyState);
    assert.equal(filePath, resolveBridgeStatePath(projectRoot, chatKey));
    const serialized = await readFile(filePath, "utf8");
    const parsed = JSON.parse(serialized);
    assert.deepEqual(Object.keys(parsed).sort(), [
      "chatKey",
      "checkpoint",
      "effort",
      "generation",
      "model",
      "threadId",
      "version",
    ]);
    assert.deepEqual(Object.keys(parsed.checkpoint).sort(), [
      "action",
      "blockedReason",
      "outboundFingerprint",
      "pending",
      "phase",
      "snapshot",
    ]);
    assert.doesNotMatch(serialized, /private body|nickname|phone|cookie|token|persona/iu);
    const directoryEntries = await readdir(path.dirname(filePath));
    assert.deepEqual(directoryEntries.sort(), [
      `${chatKey}.json`,
      `${chatKey}.recovery.json`,
    ]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("recovers a damaged primary checkpoint from its atomic recovery copy", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-douyin-corrupt-"));
  const filePath = resolveBridgeStatePath(projectRoot, chatKey);
  try {
    await saveBridgeState(projectRoot, readyState());
    await writeFile(filePath, "{not-json", "utf8");
    const recovered = await loadBridgeState(projectRoot, chatKey);
    assert.equal(recovered.status, "recovered");
    assert.equal(recovered.requiresFreshThread, true);
    assert.equal(recovered.state.threadId, "thread-1");

    await saveBridgeState(projectRoot, readyState());
    const loaded = await loadBridgeState(projectRoot, chatKey);
    assert.equal(loaded.status, "ok");
    assert.equal(loaded.state.threadId, "thread-1");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("fails closed when both checkpoint copies are damaged", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-douyin-double-corrupt-"));
  const filePath = resolveBridgeStatePath(projectRoot, chatKey);
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "{not-json", "utf8");
    await writeFile(resolveBridgeRecoveryStatePath(projectRoot, chatKey), "{also-not-json", "utf8");
    const loaded = await loadBridgeState(projectRoot, chatKey);
    assert.equal(loaded.status, "corrupt");
    assert.equal(loaded.state, null);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("allows only one live bridge owner per chat key", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-douyin-lock-"));
  let firstLock;
  try {
    firstLock = await acquireBridgeRunLock(projectRoot, chatKey);
    await assert.rejects(
      acquireBridgeRunLock(projectRoot, chatKey),
      /already owns this Douyin chat/u,
    );
    await firstLock.release();
    firstLock = null;
    const nextLock = await acquireBridgeRunLock(projectRoot, chatKey);
    await nextLock.release();
  } finally {
    await firstLock?.release();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("releases the Windows bridge lock when its owner is terminated", async (context) => {
  if (process.platform !== "win32") {
    context.skip("The Douyin bridge runs on Windows.");
    return;
  }
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-douyin-lock-crash-"));
  const fixturePath = fileURLToPath(new URL("../fixtures/hold-bridge-lock.mjs", import.meta.url));
  const child = spawn(process.execPath, [fixturePath, projectRoot, chatKey], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForReady(child);
    const exited = waitForExit(child);
    child.kill();
    await exited;
    const recoveredLock = await acquireBridgeRunLock(projectRoot, chatKey);
    await recoveredLock.release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = waitForExit(child);
      child.kill();
      await exited.catch(() => {});
    }
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("derives every append in order across the bounded visible window", () => {
  const previousMessages = "abcdefghijkl".split("").map((value) => message(value));
  const currentMessages = "cdefghijklmn".split("").map((value) => message(value));
  const appended = findAppendedMessages(
    snapshot(12, previousMessages),
    snapshot(14, currentMessages),
  );
  assert.deepEqual(appended, [
    { ...message("m"), ordinalFromEnd: 2 },
    { ...message("n"), ordinalFromEnd: 1 },
  ]);
});

test("derives appends when Douyin replaces the oldest items in a fixed DOM window", () => {
  const previousMessages = "abcdefghijk".split("").map((value) => message(value));
  const currentMessages = "cdefghijklm".split("").map((value) => message(value));
  const appended = findAppendedMessages(
    snapshot(11, previousMessages),
    snapshot(11, currentMessages),
  );
  assert.deepEqual(appended, [
    { ...message("l"), ordinalFromEnd: 2 },
    { ...message("m"), ordinalFromEnd: 1 },
  ]);
});

test("does not invent an append when an unchanged fixed window has duplicate fingerprints", () => {
  const duplicate = message("same", "left", "media");
  const unchanged = snapshot(30, Array.from({ length: 12 }, () => ({ ...duplicate })));
  assert.deepEqual(findAppendedMessages(unchanged, unchanged), []);
});

test("refuses a fixed-size DOM replacement without a reliable overlap boundary", () => {
  assert.throws(
    () => findAppendedMessages(
      snapshot(3, [message("a"), message("b"), message("c")]),
      snapshot(3, [message("x"), message("y"), message("z")]),
    ),
    /no longer matches/u,
  );
});

test("fails closed when the append boundary is missing or exceeds the visible window", () => {
  assert.throws(
    () => findAppendedMessages(snapshot(20, [message("a")]), snapshot(19, [message("a")])),
    /moved backwards/u,
  );
  assert.throws(
    () => findAppendedMessages(snapshot(1, [message("a")]), snapshot(14, [message("n")])),
    /exceed the visible checkpoint window/u,
  );
  assert.throws(
    () => findAppendedMessages(
      snapshot(2, [message("a"), message("b")]),
      snapshot(3, [message("x"), message("c"), message("d")]),
    ),
    /no longer matches/u,
  );
});

test("recovers a sending checkpoint only when the expected outbound appears after it", () => {
  const beforeSend = snapshot(1, [message("a")]);
  const outboundFingerprint = computeTextMessageFingerprint("reply");
  const sending = createBridgeState({
    chatKey,
    threadId: "thread-1",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    snapshot: beforeSend,
    phase: "sending",
    pending: [message("a")],
    outboundFingerprint,
  });
  const afterSend = snapshot(2, [
    message("a"),
    { fingerprint: outboundFingerprint, kind: "text", side: "right" },
  ]);
  const recovered = recoverBridgeStateForStartup(sending, afterSend);
  assert.equal(recovered.recoveredVerifiedSend, true);
  assert.equal(recovered.state.checkpoint.phase, "ready");
  assert.equal(recovered.state.checkpoint.outboundFingerprint, null);
  assert.deepEqual(recovered.state.checkpoint.snapshot, afterSend);
  assert.deepEqual(recovered.queuedPending, []);

  assert.throws(
    () => recoverBridgeStateForStartup(sending, beforeSend),
    /cannot be verified/u,
  );
});

test("recovers only the unfinished tail after a verified queued send", () => {
  const attachedText = message("attached-text");
  const firstMedia = message("first-media", "left", "media");
  const secondMedia = message("second-media", "left", "media");
  const beforeSend = snapshot(3, [attachedText, firstMedia, secondMedia]);
  const outboundFingerprint = computeTextMessageFingerprint("first reply");
  const sending = createBridgeState({
    chatKey,
    threadId: "thread-1",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    snapshot: beforeSend,
    phase: "sending",
    pending: [attachedText, firstMedia, secondMedia],
    outboundFingerprint,
  });
  const newlyArrived = message("newly-arrived");
  const afterSend = snapshot(5, [
    attachedText,
    firstMedia,
    secondMedia,
    { fingerprint: outboundFingerprint, kind: "text", side: "right" },
    newlyArrived,
  ]);

  const recovered = recoverBridgeStateForStartup(sending, afterSend);
  assert.equal(recovered.state.checkpoint.phase, "queued");
  assert.deepEqual(recovered.state.checkpoint.snapshot, afterSend);
  assert.deepEqual(recovered.queuedPending, [
    { ...secondMedia, ordinalFromEnd: 3 },
    { ...newlyArrived, ordinalFromEnd: 1 },
  ]);
});

test("verified-send recovery consumes a media item and its following caption together", () => {
  const firstMedia = message("first-media", "left", "media");
  const followingCaption = message("following-caption");
  const secondMedia = message("second-media", "left", "media");
  const beforeSend = snapshot(3, [firstMedia, followingCaption, secondMedia]);
  const outboundFingerprint = computeTextMessageFingerprint("first reply");
  const sending = createBridgeState({
    chatKey,
    threadId: "thread-1",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    snapshot: beforeSend,
    phase: "sending",
    pending: [firstMedia, followingCaption, secondMedia],
    outboundFingerprint,
  });
  const afterSend = snapshot(4, [
    firstMedia,
    followingCaption,
    secondMedia,
    { fingerprint: outboundFingerprint, kind: "text", side: "right" },
  ]);
  const recovered = recoverBridgeStateForStartup(sending, afterSend);
  assert.deepEqual(recovered.queuedPending, [{ ...secondMedia, ordinalFromEnd: 2 }]);
});

test("rebinds a paused queue by occurrence and appends newly visible input", () => {
  const repeated = message("same", "left", "media");
  const reply = message("reply", "right");
  const before = snapshot(3, [repeated, repeated, reply]);
  const queued = createBridgeState({
    chatKey,
    threadId: "thread-1",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    snapshot: before,
    phase: "queued",
    pending: [repeated],
  });
  const newlyArrived = message("new");
  const current = snapshot(4, [repeated, repeated, reply, newlyArrived]);
  const recovered = recoverBridgeStateForStartup(queued, current);
  assert.equal(recovered.state.checkpoint.phase, "queued");
  assert.deepEqual(recovered.queuedPending, [
    { ...repeated, ordinalFromEnd: 3 },
    { ...newlyArrived, ordinalFromEnd: 1 },
  ]);
  assert.deepEqual(rebindPendingMessages(before, [repeated, repeated]), [
    { ...repeated, ordinalFromEnd: 3 },
    { ...repeated, ordinalFromEnd: 2 },
  ]);
  assert.throws(
    () => createBridgeState({
      chatKey,
      threadId: "thread-1",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      snapshot: before,
      phase: "queued",
      pending: [message("wrong-side", "right")],
    }),
    /queued bridge checkpoint is inconsistent/u,
  );
});

test("refuses automatic recovery for an ambiguous in-flight Codex turn", () => {
  const processing = createBridgeState({
    chatKey,
    threadId: "thread-1",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    snapshot: snapshot(1, [message("a")]),
    phase: "processing",
    pending: [message("a")],
  });
  assert.throws(
    () => recoverBridgeStateForStartup(processing, snapshot(1, [message("a")])),
    /incomplete/u,
  );
});

test("fresh-thread recovery rewinds an exact interrupted pending boundary", () => {
  const beforePending = message("before", "right");
  const pending = message("pending");
  const interruptedSnapshot = snapshot(2, [beforePending, pending]);
  const processing = createBridgeState({
    chatKey,
    threadId: "thread-1",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    snapshot: interruptedSnapshot,
    phase: "processing",
    pending: [pending],
  });
  const recovered = recoverBridgeStateForFreshThread(processing, interruptedSnapshot);
  assert.equal(recovered.recoveredPendingCount, 1);
  assert.equal(recovered.state.checkpoint.phase, "ready");
  assert.deepEqual(recovered.state.checkpoint.snapshot, snapshot(1, [beforePending]));
  assert.deepEqual(
    findAppendedMessages(recovered.state.checkpoint.snapshot, interruptedSnapshot),
    [{ ...pending, ordinalFromEnd: 1 }],
  );
});

test("fresh-thread recovery preserves an exact paused queue", () => {
  const pendingMedia = message("pending-media", "left", "media");
  const replied = message("already-replied", "right");
  const current = snapshot(2, [pendingMedia, replied]);
  const queued = createBridgeState({
    chatKey,
    threadId: "thread-1",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    snapshot: current,
    phase: "queued",
    pending: [pendingMedia],
  });
  const recovered = recoverBridgeStateForFreshThread(queued, current);
  assert.equal(recovered.state.checkpoint.phase, "queued");
  assert.equal(recovered.recoveredPendingCount, 1);
  assert.deepEqual(recovered.queuedPending, [{ ...pendingMedia, ordinalFromEnd: 2 }]);
});

test("fresh-thread recovery rebinds interrupted later media before a verified reply", () => {
  const firstMedia = message("first-media", "left", "media");
  const pendingMedia = message("pending-media", "left", "media");
  const verifiedReply = message("verified-reply", "right");
  const current = snapshot(3, [firstMedia, pendingMedia, verifiedReply]);
  const processing = createBridgeState({
    chatKey,
    threadId: "thread-1",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    snapshot: current,
    phase: "processing",
    pending: [pendingMedia],
  });
  const recovered = recoverBridgeStateForFreshThread(processing, current);
  assert.equal(recovered.state.checkpoint.phase, "queued");
  assert.equal(recovered.recoveredPendingCount, 1);
  assert.deepEqual(recovered.queuedPending, [{ ...pendingMedia, ordinalFromEnd: 2 }]);
  assert.deepEqual(recovered.state.checkpoint.snapshot, current);
});

test("fresh-thread recovery refuses changed chats and sending checkpoints", () => {
  const pending = message("pending");
  const processing = createBridgeState({
    chatKey,
    threadId: "thread-1",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    snapshot: snapshot(1, [pending]),
    phase: "processing",
    pending: [pending],
  });
  assert.throws(
    () => recoverBridgeStateForFreshThread(processing, snapshot(2, [pending, message("new")])),
    /chat changed/u,
  );
  const sending = createBridgeState({
    chatKey,
    threadId: "thread-1",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    snapshot: snapshot(1, [pending]),
    phase: "sending",
    pending: [pending],
    outboundFingerprint: computeTextMessageFingerprint("reply"),
  });
  assert.throws(
    () => recoverBridgeStateForFreshThread(sending, snapshot(1, [pending])),
    /cannot be moved/u,
  );
});
