import test from "node:test";
import assert from "node:assert/strict";
import { CodexAppServerClient } from "../src/codex-app-server-client.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const threadId = "audit-thread";
const turnId = "audit-turn";

function completeTurn(client) {
  client.emit("notification", {
    method: "turn/completed",
    params: { threadId, turn: { id: turnId, status: "completed" } },
  });
}

function completeItem(client, value) {
  client.emit("notification", {
    method: "item/completed",
    params: { threadId, turnId, item: value },
  });
}

function emitDelta(client, value, itemId = null) {
  client.emit("notification", {
    method: "item/agentMessage/delta",
    params: {
      threadId,
      turnId,
      delta: value,
      ...(itemId ? { itemId } : {}),
    },
  });
}

function createClient() {
  const client = new CodexAppServerClient();
  client.request = async () => ({ turn: { id: turnId } });
  return client;
}

test("audit: completion waits for the durable turn-start callback, including notifications during it", async () => {
  const client = createClient();
  const gate = deferred();
  let returned = false;
  const run = client.runTurn({
    threadId,
    text: "synthetic",
    timeoutMs: 500,
    onTurnStarted: () => gate.promise,
  }).then((reply) => {
    returned = true;
    return reply;
  });
  await tick();
  emitDelta(client, "synthetic reply");
  completeTurn(client);
  await tick();
  const returnedBeforeCommit = returned;
  gate.resolve();
  await run;
  assert.equal(returnedBeforeCommit, false);
});

test("audit: a failed persistence callback cannot be hidden by a concurrent completed notification", async () => {
  const client = createClient();
  const gate = deferred();
  const run = client.runTurn({
    threadId,
    text: "synthetic",
    timeoutMs: 500,
    onTurnStarted: () => gate.promise,
  });
  const outcome = run.then((value) => ({ value }), (error) => ({ error }));
  await tick();
  emitDelta(client, "reply");
  completeTurn(client);
  gate.reject(new Error("synthetic disk failure"));
  assert.match((await outcome).error?.message ?? "", /synthetic disk failure/u);
});

test("audit: live output selects final_answer, never commentary", async () => {
  const client = createClient();
  const run = client.runTurn({ threadId, text: "synthetic", timeoutMs: 500 });
  await tick();
  emitDelta(client, "I will inspect the picture.", "comment-1");
  completeItem(client, {
    id: "comment-1",
    type: "agentMessage",
    phase: "commentary",
    text: "I will inspect the picture.",
  });
  emitDelta(client, "That little cat looks pleased.", "final-1");
  completeItem(client, {
    id: "final-1",
    type: "agentMessage",
    phase: "final_answer",
    text: "That little cat looks pleased.",
  });
  completeTurn(client);
  assert.equal(await run, "That little cat looks pleased.");
});

test("audit: completed final item is authoritative over partial streamed text", async () => {
  const client = createClient();
  const run = client.runTurn({ threadId, text: "synthetic", timeoutMs: 500 });
  await tick();
  emitDelta(client, "partial", "final-1");
  completeItem(client, {
    id: "final-1",
    type: "agentMessage",
    phase: "final_answer",
    text: "complete reply",
  });
  completeTurn(client);
  assert.equal(await run, "complete reply");
});

test("audit: readTurn uses the same final-answer projection as live completion", async () => {
  const client = createClient();
  client.request = async () => ({
    thread: {
      turns: [{
        id: turnId,
        status: "completed",
        items: [
          { id: "comment-1", type: "agentMessage", phase: "commentary", text: "Inspection notes" },
          { id: "final-1", type: "agentMessage", phase: "final_answer", text: "Reply only" },
        ],
      }],
    },
  });
  assert.equal((await client.readTurn({ threadId, turnId })).text, "Reply only");
});

test("audit: a late turn/start response after timeout must not mutate the journal", async () => {
  const client = createClient();
  const gate = deferred();
  let callbacks = 0;
  client.request = () => gate.promise;
  await assert.rejects(client.runTurn({
    threadId,
    text: "synthetic",
    timeoutMs: 10,
    onTurnStarted: () => { callbacks += 1; },
  }), /Timed out/u);
  gate.resolve({ turn: { id: turnId } });
  await tick();
  await tick();
  assert.equal(callbacks, 0);
});

test("audit: an already-started journal write is drained before timeout releases its owner", async () => {
  const client = createClient();
  const gate = deferred();
  let settled = false;
  const run = client.runTurn({
    threadId,
    text: "synthetic",
    timeoutMs: 10,
    onTurnStarted: () => gate.promise,
  });
  const outcome = run.then((value) => {
    settled = true;
    return { value };
  }, (error) => {
    settled = true;
    return { error };
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const releasedBeforeJournal = settled;
  gate.resolve();
  const result = await outcome;
  assert.equal(releasedBeforeJournal, false);
  assert.match(result.error?.message ?? "", /Timed out/u);
});

test("audit: a synchronous journal callback exception rejects the turn normally", async () => {
  const client = createClient();
  await assert.rejects(client.runTurn({
    threadId,
    text: "synthetic",
    timeoutMs: 100,
    onTurnStarted() { throw new Error("synthetic sync failure"); },
  }), /synthetic sync failure/u);
});

for (const callback of [
  () => { throw null; },
  () => Promise.reject(null),
]) {
  test("audit: a null journal callback failure cannot be mistaken for success", async () => {
    const client = createClient();
    const outcome = client.runTurn({
      threadId,
      text: "synthetic",
      timeoutMs: 100,
      onTurnStarted: callback,
    }).then(
      (value) => ({ status: "resolved", value }),
      (reason) => ({ status: "rejected", reason }),
    );
    assert.deepEqual(await outcome, { status: "rejected", reason: null });
  });
}

test("audit: transport exit waits for an in-flight journal write before rejecting", async () => {
  const client = createClient();
  const gate = deferred();
  let settled = false;
  const outcome = client.runTurn({
    threadId,
    text: "synthetic",
    timeoutMs: 500,
    onTurnStarted: () => gate.promise,
  }).then((value) => {
    settled = true;
    return { value };
  }, (error) => {
    settled = true;
    return { error };
  });
  await tick();
  client.emit("exit");
  await tick();
  const releasedBeforeJournal = settled;
  gate.resolve();
  const result = await outcome;
  assert.equal(releasedBeforeJournal, false);
  assert.match(result.error?.message ?? "", /exited before the turn completed/u);
});

test("audit: notifications retain order across the turn-start persistence barrier", async () => {
  const client = createClient();
  const gate = deferred();
  client.request = async () => {
    emitDelta(client, "before");
    return { turn: { id: turnId } };
  };
  const run = client.runTurn({
    threadId,
    text: "synthetic",
    timeoutMs: 500,
    onTurnStarted: () => gate.promise,
  });
  await tick();
  emitDelta(client, "after");
  completeTurn(client);
  gate.resolve();
  assert.equal(await run, "beforeafter");
});

for (const scenario of ["commentary-only", "missing-completed-final", "multiple-finals"]) {
  test(`audit: ${scenario} does not become an outgoing reply`, async () => {
    const client = createClient();
    const run = client.runTurn({ threadId, text: "synthetic", timeoutMs: 500 });
    const outcome = run.then((value) => ({ value }), (error) => ({ error }));
    await tick();
    if (scenario === "commentary-only") {
      completeItem(client, {
        id: "c",
        type: "agentMessage",
        phase: "commentary",
        text: "process text",
      });
    }
    if (scenario === "missing-completed-final") emitDelta(client, "incomplete", "f");
    if (scenario === "multiple-finals") {
      for (const id of ["f", "g"]) {
        completeItem(client, {
          id,
          type: "agentMessage",
          phase: "final_answer",
          text: `reply-${id}`,
        });
      }
    }
    completeTurn(client);
    assert.ok((await outcome).error);
  });
}

test("audit: single legacy completed item remains supported", async () => {
  const client = createClient();
  const run = client.runTurn({ threadId, text: "synthetic", timeoutMs: 500 });
  await tick();
  completeItem(client, { type: "agentMessage", content: [{ text: "legacy reply" }] });
  completeTurn(client);
  assert.equal(await run, "legacy reply");
});
