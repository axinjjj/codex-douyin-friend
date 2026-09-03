import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  createBridgeControlChannel,
  parseBridgeControlCommand,
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
