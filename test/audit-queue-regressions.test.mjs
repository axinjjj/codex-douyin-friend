import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  computeDouyinReplyDigest,
  createDouyinAction,
  transitionDouyinAction,
} from "../src/douyin-action-journal.mjs";
import { planDouyinIncomingQueue } from "../src/douyin-inbound-planner.mjs";
import {
  computeTextMessageFingerprint,
  createBridgeState,
  loadBridgeState,
  rebindPendingMessages,
  recoverBridgeStateForStartup,
  saveBridgeState,
} from "../src/douyin-bridge-state.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const chatKey = hash("synthetic chat");
const message = (value, kind = "text", side = "left") => ({
  fingerprint: hash(value),
  kind,
  side,
});
const snapshot = (messages) => ({ messageCount: messages.length, messages });
const base = {
  chatKey,
  threadId: "synthetic-thread",
  model: "synthetic-model",
  effort: "high",
  generation: 1,
};

function actionFor(messages, currentSnapshot = snapshot(messages), replyKind = "text") {
  let action = createDouyinAction({
    ...base,
    pending: rebindPendingMessages(currentSnapshot, messages),
    replyKind,
  });
  action = transitionDouyinAction(action, "turn-starting", {
    promptDigest: hash("synthetic prompt"),
  });
  action = transitionDouyinAction(action, "turn-started", {
    turnIds: ["synthetic-turn"],
  });
  return transitionDouyinAction(action, "reply-ready", {
    replyDigest: computeDouyinReplyDigest("synthetic reply"),
    replyKind,
    reactionDecision: "disabled",
  });
}

const outboundFingerprint = computeTextMessageFingerprint("synthetic reply");

for (const kind of ["text", "media"]) {
  test(`audit: restart freezes the old ${kind} reply before a newly arrived text`, () => {
    const first = message("A", kind);
    const second = message("B");
    const oldSnapshot = snapshot([first]);
    const currentSnapshot = snapshot([first, second]);
    const action = actionFor([first], oldSnapshot, kind === "media" ? "image" : "text");
    const state = createBridgeState({
      ...base,
      snapshot: oldSnapshot,
      phase: "reply-ready",
      pending: [first],
      outboundFingerprint,
      action,
    });
    const recovered = recoverBridgeStateForStartup(state, currentSnapshot);
    const plan = planDouyinIncomingQueue(recovered.queuedPending, {
      action: recovered.resumeAction,
      chatKey,
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.batches[0].messages.length, 1);
    assert.deepEqual(
      plan.batches.slice(1).flatMap((batch) => batch.messages)
        .map((entry) => entry.fingerprint),
      [second.fingerprint],
    );
  });
}

test("audit: a second restart cannot absorb messages into the recovered action", async () => {
  const first = message("A");
  const second = message("B");
  const third = message("C");
  const oldSnapshot = snapshot([first]);
  const firstRecovery = recoverBridgeStateForStartup(createBridgeState({
    ...base,
    snapshot: oldSnapshot,
    phase: "reply-ready",
    pending: [first],
    outboundFingerprint,
    action: actionFor([first], oldSnapshot),
  }), snapshot([first, second]));
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "douyin-audit-"));
  try {
    await saveBridgeState(tempRoot, firstRecovery.state);
    const loaded = await loadBridgeState(tempRoot, chatKey);
    const secondRecovery = recoverBridgeStateForStartup(
      loaded.state,
      snapshot([first, second, third]),
    );
    const plan = planDouyinIncomingQueue(secondRecovery.queuedPending, {
      action: secondRecovery.resumeAction,
      chatKey,
    });
    assert.equal(plan.batches[0].messages.length, 1);
    assert.equal(plan.batches.slice(1).flatMap((batch) => batch.messages).length, 2);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("audit: crash after Enter consumes only the hash-committed input, even after an earlier restart", () => {
  const first = message("A");
  const second = message("B");
  const oldSnapshot = snapshot([first]);
  const currentSnapshot = snapshot([first, second]);
  const originalAction = actionFor([first], oldSnapshot);
  const recovery = recoverBridgeStateForStartup(createBridgeState({
    ...base,
    snapshot: oldSnapshot,
    phase: "reply-ready",
    pending: [first],
    outboundFingerprint,
    action: originalAction,
  }), currentSnapshot);
  const sendingState = createBridgeState({
    ...base,
    snapshot: currentSnapshot,
    phase: "sending",
    pending: recovery.queuedPending,
    outboundFingerprint,
    action: transitionDouyinAction(originalAction, "send-attempted"),
  });
  const outgoing = { fingerprint: outboundFingerprint, kind: "text", side: "right" };
  const after = recoverBridgeStateForStartup(
    sendingState,
    snapshot([first, second, outgoing]),
  );
  assert.equal(after.recoveredVerifiedSend, true);
  assert.deepEqual(after.queuedPending.map((entry) => entry.fingerprint), [second.fingerprint]);
});

test("audit: forged or unresolvable action commitment must not be guessed from the queue shape", () => {
  const first = message("A");
  const second = message("B");
  const action = { ...actionFor([first]), id: hash("not the action input") };
  const currentSnapshot = snapshot([first, second]);
  const plan = planDouyinIncomingQueue(
    rebindPendingMessages(currentSnapshot, currentSnapshot.messages),
    { action, chatKey },
  );
  assert.equal(plan.ok, false);
});

test("audit: no recovered action keeps the original compound-message grouping", () => {
  const firstText = message("A");
  const firstMedia = message("M", "media");
  const secondText = message("B");
  const secondMedia = message("N", "media");
  const plan = planDouyinIncomingQueue([firstText, firstMedia, secondText, secondMedia]);
  assert.equal(plan.batches.length, 2);
  assert.deepEqual(plan.batches[0].messages, [firstText, firstMedia, secondText]);
  assert.deepEqual(plan.batches[1].messages, [secondMedia]);
});

test("audit: bounded enumeration proves committed prefixes across media/text arrangements and appends", () => {
  let cases = 0;
  for (let length = 1; length <= 5; length += 1) {
    for (let mask = 0; mask < (1 << length); mask += 1) {
      const messages = Array.from({ length }, (_, index) => message(
        `original-${length}-${mask}-${index}`,
        ((mask >> index) & 1) ? "media" : "text",
      ));
      const oldSnapshot = snapshot(messages);
      const pending = rebindPendingMessages(oldSnapshot, messages);
      const batch = planDouyinIncomingQueue(pending).batches[0];
      const action = createDouyinAction({ ...base, pending: batch.messages });
      for (let extra = 0; extra <= 3; extra += 1) {
        const tail = Array.from({ length: extra }, (_, index) => message(
          `new-${index}`,
          index % 2 ? "media" : "text",
        ));
        const liveSnapshot = snapshot([...messages, ...tail]);
        const plan = planDouyinIncomingQueue(
          rebindPendingMessages(liveSnapshot, liveSnapshot.messages),
          { action, chatKey },
        );
        assert.equal(plan.ok, true);
        assert.equal(plan.batches[0].messages.length, batch.messages.length);
        assert.equal(
          plan.batches.flatMap((plannedBatch) => plannedBatch.messages).length,
          messages.length + tail.length,
        );
        cases += 1;
      }
    }
  }
  assert.equal(cases, 248);
});
