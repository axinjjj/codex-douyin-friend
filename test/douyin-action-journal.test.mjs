import test from "node:test";
import assert from "node:assert/strict";
import {
  computeDouyinReplyDigest,
  computeDouyinTurnPromptDigest,
  createDouyinAction,
  rollbackDouyinActionBeforeEnter,
  transitionDouyinAction,
  validateDouyinAction,
} from "../src/douyin-action-journal.mjs";
import {
  computeQuotedTextMessageFingerprint,
  computeTextMessageFingerprint,
  createBridgeState,
  recoverBridgeStateForStartup,
} from "../src/douyin-bridge-state.mjs";

const chatKey = "a".repeat(64);
const incoming = {
  fingerprint: "b".repeat(64),
  kind: "media",
  side: "left",
  ordinalFromEnd: 1,
};
const baseline = { messageCount: 0, messages: [] };
const withIncoming = {
  messageCount: 1,
  messages: [{ fingerprint: incoming.fingerprint, kind: "media", side: "left" }],
};

function actionAt(stage, { quoteTargetFingerprint = null } = {}) {
  let action = createDouyinAction({ chatKey, generation: 2, pending: [incoming] });
  if (stage === "planned") return action;
  action = transitionDouyinAction(action, "evidence-ready", {
    replyKind: "video",
    reactionNonce: "c".repeat(24),
    reactionTarget: incoming,
  });
  if (stage === "evidence-ready") return action;
  action = transitionDouyinAction(action, "turn-starting", {
    promptDigest: computeDouyinTurnPromptDigest({
      threadId: "thread-1",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      input: [{ type: "text", text: "private fixture body" }],
    }),
  });
  if (stage === "turn-starting") return action;
  action = transitionDouyinAction(action, "turn-started", { turnIds: ["turn-1"] });
  if (stage === "turn-started") return action;
  action = transitionDouyinAction(action, "reply-ready", {
    replyDigest: computeDouyinReplyDigest("private reply"),
    reactionDecision: "yes",
    quoteTargetFingerprint,
  });
  if (stage === "reply-ready") return action;
  action = transitionDouyinAction(action, "send-attempted");
  if (stage === "send-attempted") return action;
  action = transitionDouyinAction(action, "send-verified", { reactionOrdinalShift: 1 });
  if (stage === "send-verified") return action;
  return transitionDouyinAction(action, "reaction-attempted");
}

test("journals external stages without persisting prompt or reply bodies", () => {
  const action = actionAt("reaction-attempted");
  assert.equal(action.stage, "reaction-attempted");
  assert.deepEqual(action.turnIds, ["turn-1"]);
  assert.equal(action.reactionOrdinalShift, 1);
  const serialized = JSON.stringify(action);
  assert.doesNotMatch(serialized, /private fixture body|private reply/u);
  assert.throws(
    () => transitionDouyinAction(actionAt("planned"), "send-attempted"),
    /Invalid Douyin action transition/u,
  );
});

test("upgrades the bounded version-one action shape without inventing quote authority", () => {
  const current = actionAt("reply-ready");
  const legacy = { ...current, version: 1 };
  delete legacy.quoteTargetFingerprint;
  const normalized = validateDouyinAction(legacy);
  assert.equal(normalized.version, 2);
  assert.equal(normalized.quoteTargetFingerprint, null);
});

test("canonicalizes a migrated native-sticker reaction target", () => {
  const migratedSticker = {
    ...incoming,
    legacyFingerprint: "d".repeat(64),
  };
  const action = transitionDouyinAction(actionAt("planned"), "evidence-ready", {
    replyKind: "image",
    reactionNonce: "c".repeat(24),
    reactionTarget: migratedSticker,
  });
  assert.deepEqual(action.reactionTarget, incoming);
  assert.equal(Object.hasOwn(action.reactionTarget, "legacyFingerprint"), false);
  assert.throws(
    () => transitionDouyinAction(actionAt("planned"), "evidence-ready", {
      replyKind: "image",
      reactionNonce: "c".repeat(24),
      reactionTarget: { ...migratedSticker, unexpected: true },
    }),
    /invalid shape/u,
  );
});

test("rolls back only a journaled attempt that has not pressed Enter", () => {
  let action = actionAt("reply-ready");
  action = transitionDouyinAction(action, "send-attempted");
  const rolledBack = rollbackDouyinActionBeforeEnter(action);
  assert.equal(rolledBack.stage, "reply-ready");
  assert.equal(rolledBack.id, action.id);
  assert.throws(() => rollbackDouyinActionBeforeEnter(rolledBack), /pre-Enter/u);
});

test("requeues pre-turn work but fails closed on an ambiguous turn start", () => {
  const plannedState = createBridgeState({
    chatKey,
    threadId: "thread-1",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    generation: 2,
    snapshot: withIncoming,
    phase: "processing",
    pending: [incoming],
    action: actionAt("planned"),
  });
  const recovered = recoverBridgeStateForStartup(plannedState, withIncoming);
  assert.equal(recovered.state.checkpoint.phase, "queued");
  assert.equal(recovered.state.checkpoint.action, null);
  assert.equal(recovered.queuedPending[0].ordinalFromEnd, 1);

  const ambiguous = createBridgeState({
    ...plannedState,
    generation: 2,
    snapshot: withIncoming,
    phase: "processing",
    pending: [incoming],
    action: actionAt("turn-starting"),
  });
  assert.throws(
    () => recoverBridgeStateForStartup(ambiguous, withIncoming),
    /turn start is ambiguous/u,
  );
});

test("upgrades an in-flight empty-text sticker fingerprint to canonical media", () => {
  const legacySticker = {
    fingerprint: "d".repeat(64),
    kind: "text",
    side: "left",
    ordinalFromEnd: 2,
  };
  const followingText = {
    fingerprint: "e".repeat(64),
    kind: "text",
    side: "left",
    ordinalFromEnd: 1,
  };
  const currentSticker = {
    fingerprint: "f".repeat(64),
    legacyFingerprint: legacySticker.fingerprint,
    kind: "media",
    side: "left",
  };
  const oldSnapshot = {
    messageCount: 2,
    messages: [legacySticker, followingText],
  };
  const currentSnapshot = {
    messageCount: 2,
    messages: [currentSticker, followingText],
  };
  const state = createBridgeState({
    chatKey,
    threadId: "thread-1",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    generation: 2,
    snapshot: oldSnapshot,
    phase: "processing",
    pending: [legacySticker, followingText],
    action: createDouyinAction({
      chatKey,
      generation: 2,
      pending: [legacySticker, followingText],
    }),
  });
  const recovered = recoverBridgeStateForStartup(state, currentSnapshot);
  assert.equal(recovered.state.checkpoint.phase, "queued");
  assert.deepEqual(recovered.queuedPending, [
    { ...currentSticker, ordinalFromEnd: 2 },
    { ...followingText, ordinalFromEnd: 1 },
  ]);
});

test("resumes a completed turn by id and never starts a second turn implicitly", () => {
  const state = createBridgeState({
    chatKey,
    threadId: "thread-1",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    generation: 2,
    snapshot: withIncoming,
    phase: "processing",
    pending: [incoming],
    action: actionAt("turn-started"),
  });
  const recovered = recoverBridgeStateForStartup(state, withIncoming);
  assert.equal(recovered.state.checkpoint.phase, "queued");
  assert.equal(recovered.resumeAction.stage, "turn-started");
  assert.deepEqual(recovered.resumeAction.turnIds, ["turn-1"]);
});

test("a verified Enter resumes at reaction and a recorded reaction is at-most-once", () => {
  const reply = "private reply";
  const outbound = {
    fingerprint: computeTextMessageFingerprint(reply),
    kind: "text",
    side: "right",
  };
  for (const stage of ["send-attempted", "send-verified", "reaction-attempted"]) {
    const state = createBridgeState({
      chatKey,
      threadId: "thread-1",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      generation: 2,
      snapshot: withIncoming,
      phase: "sending",
      pending: [incoming],
      outboundFingerprint: outbound.fingerprint,
      action: actionAt(stage),
    });
    const recovered = recoverBridgeStateForStartup(state, {
      messageCount: 2,
      messages: [...withIncoming.messages, outbound],
    });
    assert.equal(recovered.recoveredVerifiedSend, true);
    assert.equal(
      recovered.resumeAction.stage,
      stage === "reaction-attempted" ? "reaction-attempted" : "send-verified",
    );
  }
});

test("quoted-send recovery requires the exact referenced shared-work identity", () => {
  const reply = "private reply";
  const quoteTargetFingerprint = "d".repeat(64);
  const outbound = {
    fingerprint: computeQuotedTextMessageFingerprint(reply),
    kind: "text",
    side: "right",
    quoteTargetFingerprint,
  };
  const state = createBridgeState({
    chatKey,
    threadId: "thread-1",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    generation: 2,
    snapshot: withIncoming,
    phase: "sending",
    pending: [incoming],
    outboundFingerprint: outbound.fingerprint,
    action: actionAt("send-attempted", { quoteTargetFingerprint }),
  });
  assert.throws(() => recoverBridgeStateForStartup(state, {
    messageCount: 2,
    messages: [
      ...withIncoming.messages,
      { ...outbound, quoteTargetFingerprint: "e".repeat(64) },
    ],
  }), /cannot be verified/u);
  const recovered = recoverBridgeStateForStartup(state, {
    messageCount: 2,
    messages: [...withIncoming.messages, outbound],
  });
  assert.equal(recovered.recoveredVerifiedSend, true);
  assert.equal(recovered.resumeAction.quoteTargetFingerprint, quoteTargetFingerprint);
});

test("quoted recovery consumes only the first adjacent video and rebinds the remaining queue", () => {
  const firstVideo = { ...incoming, ordinalFromEnd: 2 };
  const secondVideo = {
    fingerprint: "f".repeat(64),
    kind: "media",
    side: "left",
    ordinalFromEnd: 1,
  };
  const quoteTargetFingerprint = "d".repeat(64);
  let action = createDouyinAction({
    chatKey,
    generation: 2,
    pending: [firstVideo],
  });
  action = transitionDouyinAction(action, "evidence-ready", {
    replyKind: "video",
    reactionNonce: null,
    reactionTarget: firstVideo,
  });
  action = transitionDouyinAction(action, "turn-starting", {
    promptDigest: "1".repeat(64),
  });
  action = transitionDouyinAction(action, "turn-started", { turnIds: ["turn-1"] });
  action = transitionDouyinAction(action, "reply-ready", {
    replyDigest: computeDouyinReplyDigest("first quoted reply"),
    reactionDecision: "disabled",
    quoteTargetFingerprint,
  });
  action = transitionDouyinAction(action, "send-attempted");
  const before = {
    messageCount: 2,
    messages: [
      { fingerprint: firstVideo.fingerprint, kind: "media", side: "left" },
      { fingerprint: secondVideo.fingerprint, kind: "media", side: "left" },
    ],
  };
  const state = createBridgeState({
    chatKey,
    threadId: "thread-1",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    generation: 2,
    snapshot: before,
    phase: "sending",
    pending: [firstVideo, secondVideo],
    outboundFingerprint: computeQuotedTextMessageFingerprint("first quoted reply"),
    action,
  });
  const newIncoming = { fingerprint: "9".repeat(64), kind: "text", side: "left" };
  const after = {
    messageCount: 4,
    messages: [
      ...before.messages,
      {
        fingerprint: computeQuotedTextMessageFingerprint("first quoted reply"),
        kind: "text",
        side: "right",
        quoteTargetFingerprint,
      },
      newIncoming,
    ],
  };
  const recovered = recoverBridgeStateForStartup(state, after);
  assert.equal(recovered.recoveredVerifiedSend, true);
  assert.equal(recovered.resumeAction.stage, "send-verified");
  assert.equal(recovered.resumeAction.id.slice(0, 24), action.id.slice(0, 24));
  assert.deepEqual(recovered.queuedPending, [
    { fingerprint: secondVideo.fingerprint, kind: "media", side: "left", ordinalFromEnd: 3 },
    { ...newIncoming, ordinalFromEnd: 1 },
  ]);
});
