import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  classifyBridgeTerminalFailure,
  createBridgeControlChannel,
  createBridgeTerminalEvent,
  parseBridgeControlCommand,
  parseBridgeTerminalEvent,
  writeBridgeEvent,
} from "../src/douyin-bridge-control.mjs";

test("accepts only bounded allowlisted bridge commands", () => {
  assert.deepEqual(parseBridgeControlCommand(JSON.stringify({
    version: 1,
    command: "compact",
    requestId: "request_1",
  })), {
    version: 1,
    command: "compact",
    requestId: "request_1",
  });
  assert.throws(() => parseBridgeControlCommand("not json"), /valid JSON/u);
  assert.throws(() => parseBridgeControlCommand(JSON.stringify({
    version: 1,
    command: "send",
    requestId: "request_2",
  })), /unsupported/u);
  assert.throws(() => parseBridgeControlCommand(JSON.stringify({
    version: 1,
    command: "stop",
    requestId: "private text is not an id",
  })), /request id/u);
});

test("dispatches stdin commands and writes newline-delimited events", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let received;
  const receivedPromise = new Promise((resolve) => {
    const channel = createBridgeControlChannel({
      input,
      onCommand(command) {
        received = command;
        channel.close();
        resolve();
      },
    });
  });
  input.write(`${JSON.stringify({ version: 1, command: "status", requestId: "status_1" })}\n`);
  await receivedPromise;
  assert.equal(received.command, "status");

  let serialized = "";
  output.on("data", (chunk) => { serialized += chunk; });
  writeBridgeEvent(output, { ok: true, event: "bridge-status", phase: "listening" });
  assert.equal(serialized, '{"ok":true,"event":"bridge-status","phase":"listening"}\n');
});

test("accepts only content-free allowlisted bridge terminal events", () => {
  const event = createBridgeTerminalEvent({
    disposition: "recover",
    reason: "persisted-work-recovery-required",
    phase: "queued",
  });
  assert.deepEqual(parseBridgeTerminalEvent(event), event);
  assert.throws(() => parseBridgeTerminalEvent({
    ...event,
    reason: "private chat text",
  }), /terminal event is invalid/u);
  assert.throws(() => parseBridgeTerminalEvent({
    ...event,
    detail: "must-not-cross-the-boundary",
  }), /terminal event is invalid/u);
  assert.throws(() => createBridgeTerminalEvent({
    disposition: "retry",
    reason: "runtime-retry-required",
    phase: "unknown",
  }), /terminal event is invalid/u);
  assert.throws(() => createBridgeTerminalEvent({
    disposition: "recover",
    reason: "persisted-work-recovery-required",
    phase: "sending",
  }), /terminal event is invalid/u);
  assert.throws(() => createBridgeTerminalEvent({
    disposition: "retry",
    reason: "runtime-retry-required",
    phase: "sending",
  }), /terminal event is invalid/u);
  assert.throws(() => createBridgeTerminalEvent({
    disposition: "retry",
    reason: "ui-authority-recovery-required",
    phase: "reply-ready",
  }), /terminal event is invalid/u);
});

test("classifies checkpoint, recoverable, and retryable bridge failures without raw errors", () => {
  assert.equal(classifyBridgeTerminalFailure({
    errorCode: "DOUYIN_CHECKPOINT_BOUNDARY_UNAVAILABLE",
    phase: "listening",
  }).disposition, "block");
  assert.deepEqual(classifyBridgeTerminalFailure({
    errorCode: "DOUYIN_RECOVERY_SAFETY_STOP",
    phase: "starting",
  }), {
    version: 1,
    event: "bridge-terminal",
    disposition: "block",
    reason: "persisted-recovery-ambiguous",
    phase: "starting",
  });
  assert.deepEqual(classifyBridgeTerminalFailure({
    phase: "queued",
  }), {
    version: 1,
    event: "bridge-terminal",
    disposition: "recover",
    reason: "persisted-work-recovery-required",
    phase: "queued",
  });
  assert.equal(classifyBridgeTerminalFailure({
    phase: "sending",
  }).disposition, "block");
  assert.equal(classifyBridgeTerminalFailure({
    phase: "listening",
  }).disposition, "retry");
  assert.deepEqual(classifyBridgeTerminalFailure({
    phase: "degraded",
  }), {
    version: 1,
    event: "bridge-terminal",
    disposition: "retry",
    reason: "runtime-retry-required",
    phase: "degraded",
  });
  assert.equal(classifyBridgeTerminalFailure({
    exitCode: 4,
    phase: "starting",
  }).disposition, "block");
  assert.doesNotMatch(JSON.stringify(classifyBridgeTerminalFailure({
    errorCode: "private-chat-content-must-not-pass",
    phase: "starting",
  })), /private-chat-content/u);
});
