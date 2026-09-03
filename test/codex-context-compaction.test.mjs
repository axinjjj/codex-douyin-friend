import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  CodexContextCompactionManager,
  CodexContextRecoveryError,
  resolveContextCompactionPolicy,
  snapshotThreadTokenUsage,
} from "../src/codex-context-compaction.mjs";

class FakeCodex extends EventEmitter {
  constructor() {
    super();
    this.compactCalls = 0;
    this.turnCalls = 0;
    this.compactImplementation = async () => ({});
    this.turnImplementation = async () => "reply";
    this.emitCompactionLifecycle = true;
  }

  async request(method, params) {
    assert.equal(method, "thread/compact/start");
    this.compactCalls += 1;
    const response = await this.compactImplementation(params);
    if (this.emitCompactionLifecycle) {
      this.emit("notification", {
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: `compact-turn-${this.compactCalls}`,
          item: { id: `compact-item-${this.compactCalls}`, type: "contextCompaction" },
        },
      });
      this.emit("notification", {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: `compact-turn-${this.compactCalls}`,
          item: { id: `compact-item-${this.compactCalls}`, type: "contextCompaction" },
        },
      });
      this.emit("notification", {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: `compact-turn-${this.compactCalls}`, status: "completed" },
        },
      });
    }
    return response;
  }

  runTurn(params) {
    this.turnCalls += 1;
    return this.turnImplementation(params, this.turnCalls);
  }
}

function emitContextWindowExceeded(codex, turnId) {
  const error = {
    message: "private provider detail",
    codexErrorInfo: "contextWindowExceeded",
  };
  codex.emit("notification", {
    method: "error",
    params: {
      threadId: "thread-1",
      turnId,
      willRetry: false,
      error,
    },
  });
  codex.emit("notification", {
    method: "thread/status/changed",
    params: { threadId: "thread-1", status: { type: "idle" } },
  });
  codex.emit("notification", {
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: turnId, status: "failed", error },
    },
  });
}

function emitUsage(codex, contextTokens, modelContextWindow = 1_000) {
  codex.emit("notification", {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        last: { totalTokens: contextTokens },
        total: { totalTokens: contextTokens * 10 },
        modelContextWindow,
      },
    },
  });
  codex.emit("notification", {
    method: "thread/status/changed",
    params: { threadId: "thread-1", status: { type: "idle" } },
  });
}

test("uses last.totalTokens as current context instead of cumulative total", () => {
  assert.deepEqual(snapshotThreadTokenUsage({
    last: { totalTokens: 600 },
    total: { totalTokens: 9_999 },
    modelContextWindow: 1_000,
  }), {
    contextTokens: 600,
    modelContextWindow: 1_000,
    ratio: 0.6,
  });
});

test("reports sanitized usage snapshots and supports manual compaction", async () => {
  const codex = new FakeCodex();
  const usageSnapshots = [];
  const manager = new CodexContextCompactionManager({
    codex,
    threadId: "thread-1",
    cooldownMs: 0,
    onUsage: (usage) => usageSnapshots.push(usage),
  });
  emitUsage(codex, 420, 1_000);

  assert.deepEqual(usageSnapshots, [{
    contextTokens: 420,
    modelContextWindow: 1_000,
    ratio: 0.42,
  }]);
  assert.equal((await manager.compactNow()).action, "compacted");
  assert.equal(codex.compactCalls, 1);
  manager.close();
});

test("validates environment overrides as one compaction policy", () => {
  assert.deepEqual(resolveContextCompactionPolicy({
    CODEX_DOUYIN_COMPACTION_HIGH_WATERMARK: "0.8",
    CODEX_DOUYIN_COMPACTION_LOW_WATERMARK: "0.4",
    CODEX_DOUYIN_COMPACTION_COOLDOWN_MS: "250",
    CODEX_DOUYIN_COMPACTION_TIMEOUT_MS: "500",
  }), {
    highWatermark: 0.8,
    lowWatermark: 0.4,
    cooldownMs: 250,
    timeoutMs: 500,
  });
  assert.throws(
    () => resolveContextCompactionPolicy({
      CODEX_DOUYIN_COMPACTION_HIGH_WATERMARK: "0.4",
      CODEX_DOUYIN_COMPACTION_LOW_WATERMARK: "0.5",
    }),
    /0 <= low < high <= 1/u,
  );
});

test("waits for both the contextCompaction item and its completed turn", async () => {
  const codex = new FakeCodex();
  codex.emitCompactionLifecycle = false;
  const manager = new CodexContextCompactionManager({
    codex,
    threadId: "thread-1",
    cooldownMs: 0,
    timeoutMs: 1_000,
  });
  emitUsage(codex, 900);

  let settled = false;
  const compaction = manager.maybeCompact().then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  codex.emit("notification", {
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "compact-turn",
      item: { id: "compact-item", type: "contextCompaction" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  codex.emit("notification", {
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "compact-turn", status: "completed" },
    },
  });
  assert.equal((await compaction).action, "compacted");
  manager.close();
});

test("times out when the official compaction lifecycle never completes", async () => {
  const codex = new FakeCodex();
  codex.emitCompactionLifecycle = false;
  const manager = new CodexContextCompactionManager({
    codex,
    threadId: "thread-1",
    cooldownMs: 0,
    timeoutMs: 10,
  });
  emitUsage(codex, 900);

  const result = await manager.maybeCompact();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "timeout");
  manager.close();
});

test("applies threshold, hysteresis, and cooldown deterministically", async () => {
  const codex = new FakeCodex();
  let currentTime = 10_000;
  const manager = new CodexContextCompactionManager({
    codex,
    threadId: "thread-1",
    highWatermark: 0.75,
    lowWatermark: 0.5,
    cooldownMs: 1_000,
    now: () => currentTime,
  });

  emitUsage(codex, 749);
  assert.equal((await manager.maybeCompact()).reason, "below-threshold");
  emitUsage(codex, 750);
  assert.equal((await manager.maybeCompact()).action, "compacted");
  assert.equal(codex.compactCalls, 1);

  emitUsage(codex, 900);
  assert.equal((await manager.maybeCompact()).reason, "hysteresis");
  emitUsage(codex, 500);
  emitUsage(codex, 800);
  assert.equal((await manager.maybeCompact()).reason, "cooldown");
  currentTime += 1_000;
  assert.equal((await manager.maybeCompact()).action, "compacted");
  assert.equal(codex.compactCalls, 2);
  manager.close();
});

test("defers threshold compaction while media, sending, or the thread is active", async () => {
  const codex = new FakeCodex();
  const manager = new CodexContextCompactionManager({
    codex,
    threadId: "thread-1",
    cooldownMs: 0,
  });
  emitUsage(codex, 900);

  let finishMedia;
  const mediaGate = new Promise((resolve) => {
    finishMedia = resolve;
  });
  const media = manager.withActivity("media", () => mediaGate);
  assert.equal((await manager.maybeCompact()).reason, "busy");
  finishMedia();
  await media;

  let finishSend;
  const sendGate = new Promise((resolve) => {
    finishSend = resolve;
  });
  const sending = manager.withActivity("send", () => sendGate);
  assert.equal((await manager.maybeCompact()).reason, "busy");
  finishSend();
  await sending;

  codex.emit("notification", {
    method: "thread/status/changed",
    params: { threadId: "thread-1", status: { type: "active", activeFlags: [] } },
  });
  assert.equal((await manager.maybeCompact()).reason, "busy");
  assert.equal(codex.compactCalls, 0);
  manager.close();
});

test("coalesces concurrent compaction checks into one flight", async () => {
  const codex = new FakeCodex();
  let finishCompaction;
  codex.compactImplementation = () => new Promise((resolve) => {
    finishCompaction = resolve;
  });
  const manager = new CodexContextCompactionManager({
    codex,
    threadId: "thread-1",
    cooldownMs: 0,
  });
  emitUsage(codex, 900);

  const first = manager.maybeCompact();
  const second = manager.maybeCompact();
  assert.equal(first, second);
  assert.equal(codex.compactCalls, 1);
  finishCompaction({});
  assert.equal((await first).action, "compacted");
  manager.close();
});

test("disables repeated attempts after an unsupported method", async () => {
  const codex = new FakeCodex();
  const diagnostics = [];
  codex.compactImplementation = async () => {
    const error = new Error("Method not found and private detail");
    error.code = -32601;
    throw error;
  };
  const manager = new CodexContextCompactionManager({
    codex,
    threadId: "thread-1",
    cooldownMs: 0,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  emitUsage(codex, 900);

  const failed = await manager.maybeCompact();
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "unsupported");
  assert.equal(diagnostics[0].event, "context-compaction-failed");
  assert.equal(diagnostics[0].requestCode, -32601);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private detail/u);
  assert.equal((await manager.maybeCompact()).reason, "unsupported-disabled");
  assert.equal(codex.compactCalls, 1);
  manager.close();
});

test("reports a timeout and remains eligible after cooldown", async () => {
  const codex = new FakeCodex();
  const diagnostics = [];
  let currentTime = 0;
  codex.compactImplementation = async () => {
    throw new Error("Timed out waiting for thread/compact/start response with private detail.");
  };
  const manager = new CodexContextCompactionManager({
    codex,
    threadId: "thread-1",
    cooldownMs: 100,
    now: () => currentTime,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  emitUsage(codex, 900);

  assert.equal((await manager.maybeCompact()).reason, "timeout");
  assert.equal((await manager.maybeCompact()).reason, "cooldown");
  currentTime = 100;
  assert.equal((await manager.maybeCompact()).reason, "timeout");
  assert.equal(codex.compactCalls, 2);
  assert.deepEqual(diagnostics.map((value) => value.reason), ["timeout", "timeout"]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private detail/u);
  manager.close();
});

test("recovers ContextWindowExceeded with one compact and one retry", async () => {
  const codex = new FakeCodex();
  codex.turnImplementation = async (_params, callCount) => {
    if (callCount === 1) {
      emitContextWindowExceeded(codex, "turn-1");
      throw new Error("Codex turn ended with status failed.");
    }
    return "recovered reply";
  };
  const manager = new CodexContextCompactionManager({ codex, threadId: "thread-1" });

  assert.equal(await manager.runTurn({ threadId: "thread-1", text: "input" }), "recovered reply");
  assert.equal(codex.turnCalls, 2);
  assert.equal(codex.compactCalls, 1);
  manager.close();
});

test("never loops when the one recovery retry also exceeds context", async () => {
  const codex = new FakeCodex();
  codex.turnImplementation = async (_params, callCount) => {
    emitContextWindowExceeded(codex, `turn-${callCount}`);
    throw new Error("Codex turn ended with status failed.");
  };
  const manager = new CodexContextCompactionManager({ codex, threadId: "thread-1" });

  await assert.rejects(
    manager.runTurn({ threadId: "thread-1", text: "input" }),
    (error) => {
      assert.ok(error instanceof CodexContextRecoveryError);
      assert.equal(error.reason, "context-window-exceeded-after-retry");
      return true;
    },
  );
  assert.equal(codex.turnCalls, 2);
  assert.equal(codex.compactCalls, 1);
  manager.close();
});

test("does not retry the turn when recovery compaction fails", async () => {
  const codex = new FakeCodex();
  codex.turnImplementation = async () => {
    emitContextWindowExceeded(codex, "turn-1");
    throw new Error("Codex turn ended with status failed.");
  };
  codex.compactImplementation = async () => {
    throw new Error("Timed out waiting for thread/compact/start response.");
  };
  const manager = new CodexContextCompactionManager({ codex, threadId: "thread-1" });

  await assert.rejects(
    manager.runTurn({ threadId: "thread-1", text: "input" }),
    (error) => {
      assert.ok(error instanceof CodexContextRecoveryError);
      assert.equal(error.reason, "timeout");
      return true;
    },
  );
  assert.equal(codex.turnCalls, 1);
  assert.equal(codex.compactCalls, 1);
  manager.close();
});
