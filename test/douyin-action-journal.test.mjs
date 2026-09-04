import test from "node:test";
import assert from "node:assert/strict";
import {
  computeDouyinReplyDigest,
  computeDouyinTurnPromptDigest,
  createDouyinAction,
  transitionDouyinAction,
} from "../src/douyin-action-journal.mjs";
import {
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

function actionAt(stage) {
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
