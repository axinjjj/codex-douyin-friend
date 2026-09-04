import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  CodexAppServerClient,
  extractAgentText,
  instructionSourcesContain,
} from "../src/codex-app-server-client.mjs";
import { summarizeTargets } from "../src/cdp-client.mjs";

class FakeCodexProcess extends EventEmitter {
  constructor({ initializeError = null, respondToInitialize = true } = {}) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exited = false;
    let buffered = "";
    this.stdin.on("data", (chunk) => {
      buffered += String(chunk);
      while (buffered.includes("\n")) {
        const newline = buffered.indexOf("\n");
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const message = JSON.parse(line);
        if (message.method !== "initialize" || !respondToInitialize) continue;
        this.stdout.write(`${JSON.stringify(initializeError
          ? { id: message.id, error: initializeError }
          : { id: message.id, result: { userAgent: "fixture" } })}\n`);
      }
    });
    this.stdin.once("finish", () => this.exit(0, null));
  }

  exit(code, signal) {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, signal);
  }

  kill() {
    this.exit(null, "SIGTERM");
  }
}

test("extractAgentText reads a completed agent message", () => {
  assert.equal(
    extractAgentText({
      type: "agentMessage",
      content: [{ type: "outputText", text: "hello" }, { text: " world" }],
    }),
    "hello world",
  );
});

test("extractAgentText ignores non-agent items", () => {
  assert.equal(extractAgentText({ type: "commandExecution", text: "secret" }), "");
});

test("instructionSourcesContain compares Windows paths safely", () => {
  const expected = path.win32.join("C:\\project", "persona", "AGENTS.md");
  assert.equal(
    instructionSourcesContain(
      [{ path: "c:/project/persona/AGENTS.md" }],
      expected,
    ),
    true,
  );
});

test("starts persistent threads and resumes them with the same safety overrides", async () => {
  const calls = [];
  const client = new CodexAppServerClient();
  client.request = async (method, params) => {
    calls.push({ method, params });
    return {};
  };

  await client.startThread({ cwd: "C:/project", model: "gpt-5.6-sol", ephemeral: false });
  await client.resumeThread({
    threadId: "thread-1",
    cwd: "C:/project",
    model: "gpt-5.6-sol",
  });
  await client.setThreadName({ threadId: "thread-1", name: "bridge task" });

  assert.deepEqual(calls[0], {
    method: "thread/start",
    params: {
      cwd: "C:/project",
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false,
      serviceName: "codex_douyin_friend",
      model: "gpt-5.6-sol",
    },
  });
  assert.deepEqual(calls[1], {
    method: "thread/resume",
    params: {
      threadId: "thread-1",
      cwd: "C:/project",
      approvalPolicy: "never",
      sandbox: "read-only",
      model: "gpt-5.6-sol",
    },
  });
  assert.deepEqual(calls[2], {
    method: "thread/name/set",
    params: {
      threadId: "thread-1",
      name: "bridge task",
    },
  });
});

test("summarizeTargets removes titles, URLs, and debugger addresses", () => {
  assert.deepEqual(
    summarizeTargets([
      {
        type: "page",
        title: "private chat title",
        url: "https://example.invalid/private",
        webSocketDebuggerUrl: "ws://127.0.0.1/private",
      },
    ]),
    [{ type: "page", hasDebuggerEndpoint: true, hasUrl: true }],
  );
});

test("clears an exited App Server process and starts a new child", async () => {
  const children = [];
  const client = new CodexAppServerClient({
    spawnProcess() {
      const child = new FakeCodexProcess();
      children.push(child);
      return child;
    },
  });
  await client.start();
  children[0].exit(1, null);
  assert.equal(client.process, null);
  await client.start();
  assert.equal(children.length, 2);
  await client.close();
});

test("coalesces concurrent starts until initialization has completed", async () => {
  const child = new FakeCodexProcess({ respondToInitialize: false });
  let spawnCount = 0;
  const client = new CodexAppServerClient({
    spawnProcess() {
      spawnCount += 1;
      return child;
    },
  });
  const firstStart = client.start();
  let secondSettled = false;
  const secondStart = client.start().then(() => {
    secondSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawnCount, 1);
  assert.equal(secondSettled, false);
  child.stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: "fixture" } })}\n`);
  await Promise.all([firstStart, secondStart]);
  assert.equal(secondSettled, true);
  await client.close();
});

test("tears down initialization failures and can retry with a fresh child", async () => {
  const children = [];
  const client = new CodexAppServerClient({
    spawnProcess() {
      const child = new FakeCodexProcess(children.length === 0 ? {
        initializeError: { code: -32600, message: "fixture initialization failure" },
      } : {});
      children.push(child);
      return child;
    },
  });
  await assert.rejects(client.start(), /fixture initialization failure/u);
  assert.equal(client.process, null);
  await client.start();
  assert.equal(children.length, 2);
  await client.close();
});

test("rejects pending requests and clears the child after stdin EPIPE", async () => {
  const child = new FakeCodexProcess();
  const client = new CodexAppServerClient({ spawnProcess: () => child });
  await client.start();
  const pending = client.request("thread/list");
  const transportError = new Error("fixture pipe closed");
  transportError.code = "EPIPE";
  child.stdin.emit("error", transportError);
  await assert.rejects(pending, /input stream failed/u);
  assert.equal(client.pendingRequests.size, 0);
  assert.equal(client.process, null);
});

test("handles a child spawn error without an unhandled event and permits restart", async () => {
  const children = [];
  const client = new CodexAppServerClient({
    spawnProcess() {
      const child = new FakeCodexProcess({ respondToInitialize: children.length > 0 });
      children.push(child);
      if (children.length === 1) queueMicrotask(() => child.emit("error", new Error("ENOENT")));
      return child;
    },
  });
  await assert.rejects(client.start(), /process failed to start/u);
  await client.start();
  assert.equal(children.length, 2);
  await client.close();
});

test("runTurn consumes only notifications for the returned turn id", async () => {
  const client = new CodexAppServerClient();
  client.request = async (method) => {
    assert.equal(method, "turn/start");
    client.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "other-turn", delta: "wrong" },
    });
    client.emit("notification", {
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "other-turn", status: "completed" } },
    });
    client.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "target-turn", delta: "right" },
    });
    client.emit("notification", {
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "target-turn", status: "completed" } },
    });
    return { turn: { id: "target-turn" } };
  };
  assert.equal(await client.runTurn({ threadId: "thread-1", text: "fixture" }), "right");
});

test("persists the turn id callback before consuming buffered completion", async () => {
  const events = [];
  const client = new CodexAppServerClient();
  client.request = async () => {
    client.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", delta: "reply" },
    });
    client.emit("notification", {
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
    });
    return { turn: { id: "turn-1" } };
  };
  const reply = await client.runTurn({
    threadId: "thread-1",
    text: "fixture",
    async onTurnStarted({ turnId }) {
      events.push(`persist:${turnId}`);
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  events.push(`reply:${reply}`);
  assert.deepEqual(events, ["persist:turn-1", "reply:reply"]);
});

test("reads one completed turn by id without returning non-agent items", async () => {
  const client = new CodexAppServerClient();
  client.request = async (method, params) => {
    assert.equal(method, "thread/read");
    assert.deepEqual(params, { threadId: "thread-1", includeTurns: true });
    return {
      thread: {
        turns: [{
          id: "turn-1",
          status: "completed",
          items: [
            { type: "commandExecution", text: "private tool output" },
            { type: "agentMessage", content: [{ type: "outputText", text: "reply" }] },
          ],
        }],
      },
    };
  };
  assert.deepEqual(await client.readTurn({ threadId: "thread-1", turnId: "turn-1" }), {
    found: true,
    status: "completed",
    text: "reply",
  });
});
