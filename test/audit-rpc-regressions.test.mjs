import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { CodexAppServerClient } from "../src/codex-app-server-client.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.seen = [];
    this.exited = false;
    let text = "";
    this.stdin.on("data", (chunk) => {
      text += chunk;
      while (text.includes("\n")) {
        const newlineIndex = text.indexOf("\n");
        const message = JSON.parse(text.slice(0, newlineIndex));
        text = text.slice(newlineIndex + 1);
        this.seen.push(message);
        if (message.method === "initialize") {
          this.send({ id: message.id, result: { userAgent: "synthetic" } });
        }
      }
    });
    this.stdin.once("finish", () => setImmediate(() => this.kill()));
  }

  send(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  kill() {
    if (!this.exited) {
      this.exited = true;
      this.emit("exit", 0, null);
    }
  }
}

test("audit: server request id cannot resolve a colliding client request or authorize tools", async () => {
  const process = new FakeProcess();
  const client = new CodexAppServerClient({ spawnProcess: () => process });
  try {
    await client.start();
    let settled = false;
    const pendingRequest = client.request("thread/read", { threadId: "synthetic" })
      .then((value) => {
        settled = true;
        return value;
      });
    const request = process.seen.find((message) => message.method === "thread/read");
    process.send({
      id: request.id,
      method: "item/tool/requestUserInput",
      params: { threadId: "synthetic", questions: [] },
    });
    await tick();
    const prematurelySettled = settled;
    process.send({ id: request.id, result: { thread: { id: "synthetic" } } });
    const answer = await pendingRequest;
    assert.equal(prematurelySettled, false);
    assert.deepEqual(answer, { thread: { id: "synthetic" } });
    const refusal = process.seen.find((message) => message.id === request.id && message.error);
    assert.equal(refusal?.error.code, -32601);
    assert.equal(process.seen.some((message) => message.result?.decision === "accept"), false);
  } finally {
    await client.close();
  }
});
