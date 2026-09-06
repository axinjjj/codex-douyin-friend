import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import {
  createDouyinSupervisor,
  findInstalledEdge,
  loadSupervisorConfig,
  saveSupervisorConfig,
} from "../src/douyin-supervisor.mjs";

class FakeChild extends EventEmitter {
  constructor({ exitOnStop = false } = {}) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.unref = () => {};
    if (exitOnStop) {
      this.stdin.on("data", (chunk) => {
        if (String(chunk).includes('"command":"stop"')) this.emit("exit", 0, null);
      });
    }
  }
}

function modelList() {
  return [{
    id: "gpt-5.6-sol",
    displayName: "GPT 5.6 Sol",
    supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "xhigh" }],
    inputModalities: ["text", "image"],
  }, {
    id: "text-only",
    supportedReasoningEfforts: ["high"],
    inputModalities: ["text"],
  }];
}

async function temporaryRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "douyin-supervisor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function readyFetch() {
  return Promise.resolve({ ok: true });
}

test("uses isolated temporary files for overlapping atomic config writes", async (t) => {
  const root = await temporaryRoot(t);
  const configPath = path.join(root, ".runtime", "supervisor", "config.json");
  const base = await loadSupervisorConfig(configPath);
  const writes = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => (
    saveSupervisorConfig(configPath, {
      ...base,
      mediaReactionEnabled: Boolean(index % 2),
    })
  )));
  assert.equal(writes.every(({ status }) => status === "fulfilled"), true);
  assert.equal((await loadSupervisorConfig(configPath)).version, 1);
});

test("finds Edge in Windows Program Files without duplicate candidates", () => {
  assert.deepEqual(findInstalledEdge({
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    PROGRAMFILES_X86: "C:\\Program Files (x86)",
    ProgramFiles: "C:\\Program Files",
  }), [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ]);
});

test("starts a supervised hidden bridge and exposes sanitized live status", async (t) => {
  const root = await temporaryRoot(t);
  const children = [];
  const calls = [];
  const supervisor = await createDouyinSupervisor({
    projectRoot: root,
    nodePath: process.execPath,
    fetchFn: readyFetch,
    listModelsFn: async () => modelList(),
    spawnProcess(executable, args, options) {
      const child = new FakeChild();
      children.push(child);
      calls.push({ executable, args, options });
      return child;
    },
  });

  await supervisor.start();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, process.execPath);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.env.DOUYIN_SUPERVISED, "true");
  assert.equal(calls[0].options.env.DOUYIN_SEND_ENABLED, "false");
  assert.equal(calls[0].options.env.DOUYIN_MEDIA_REACTION_ENABLED, "false");
  assert.equal(calls[0].options.env.CODEX_DOUYIN_MODEL, "gpt-5.6-sol");

  children[0].stdout.write(`${JSON.stringify({
    ok: true,
    event: "bridge-ready",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    audioEnabled: true,
  })}\n`);
  children[0].stdout.write(`${JSON.stringify({
    ok: true,
    event: "context-usage-updated",
    contextUsage: { contextTokens: 25, modelContextWindow: 100, ratio: 0.25 },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));

  const status = supervisor.getStatus();
  assert.equal(status.phase, "listening");
  assert.equal(status.audio, "ready");
  assert.equal(status.contextUsage.ratio, 0.25);
  assert.equal(status.actionPermissions.compact, true);
  assert.equal(status.actionPermissions.setMediaReactions, true);
  assert.doesNotMatch(JSON.stringify(status), /threadId|chatKey|prompt|messageText/iu);

  let command = "";
  children[0].stdin.on("data", (chunk) => { command += chunk; });
  assert.deepEqual(supervisor.compact("compact_1"), { ok: true, accepted: true });
  assert.match(command, /"command":"compact"/u);
});

test("enables sending only from a live verified binding and revokes it on authority loss", async (t) => {
  const root = await temporaryRoot(t);
  const configPath = path.join(root, ".runtime", "supervisor", "config.json");
  const children = [];
  const calls = [];
  const binding = {
    version: 1,
    chatFingerprint: "a".repeat(64),
    targetId: "target-1",
    pageEpoch: "b".repeat(64),
    pageUrlHash: "c".repeat(64),
  };
  const supervisor = await createDouyinSupervisor({
    projectRoot: root,
    configPath,
    nodePath: process.execPath,
    fetchFn: readyFetch,
    spawnProcess(executable, args, options) {
      const child = new FakeChild({ exitOnStop: true });
      children.push(child);
      calls.push({ executable, args, options });
      return child;
    },
  });
  await assert.rejects(supervisor.setAutoSend(true), /has not produced/u);
  await supervisor.start();
  children[0].stdout.write(`${JSON.stringify({
    event: "bridge-ready",
    audioEnabled: true,
    sendBinding: binding,
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  await supervisor.setAutoSend(true);
  assert.equal(calls[1].options.env.DOUYIN_SEND_ENABLED, "true");
  assert.deepEqual(JSON.parse(calls[1].options.env.DOUYIN_SEND_CAPABILITY), binding);
  assert.doesNotMatch(JSON.stringify(supervisor.getStatus()), /target-1|pageEpoch|chatFingerprint/u);

  children[1].emit("exit", 4, null);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await loadSupervisorConfig(configPath)).sendEnabled) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal((await loadSupervisorConfig(configPath)).sendEnabled, false);
  assert.equal((await loadSupervisorConfig(configPath)).sendCapability, null);
});

test("blocks safely after an unknown media structure crashes during processing", async (t) => {
  const root = await temporaryRoot(t);
  const child = new FakeChild();
  const timers = [];
  const supervisor = await createDouyinSupervisor({
    projectRoot: root,
    nodePath: process.execPath,
    fetchFn: readyFetch,
    spawnProcess: () => child,
    setTimer(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimer() {},
  });
  await supervisor.start();
  child.stdout.write('{"event":"bridge-status","phase":"processing"}\n');
  child.stdout.write(`${JSON.stringify({
    event: "unknown-media-structure",
    reason: "unsupported-media-type",
    diagnostic: {
      version: 1,
      signature: "a".repeat(64),
      body: "must-not-enter-status",
      url: "https://example.invalid/must-not-enter-status",
      accountId: "must-not-enter-status",
      itemId: "must-not-enter-status",
    },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("exit", 1, null);

  const status = supervisor.getStatus();
  assert.equal(status.phase, "blocked");
  assert.equal(status.actionPermissions.reconnect, true);
  assert.doesNotMatch(JSON.stringify(status), /must-not-enter-status/u);
  assert.equal(timers.length, 0);
});

test("restarts an idle crash with bounded backoff", async (t) => {
  const root = await temporaryRoot(t);
  const children = [];
  const timers = [];
  const supervisor = await createDouyinSupervisor({
    projectRoot: root,
    nodePath: process.execPath,
    fetchFn: readyFetch,
    spawnProcess() {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    setTimer(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimer() {},
  });
  await supervisor.start();
  children[0].stdout.write('{"event":"bridge-ready","audioEnabled":true}\n');
  await new Promise((resolve) => setImmediate(resolve));
  children[0].emit("exit", 1, null);

  assert.equal(supervisor.getStatus().phase, "restarting");
  assert.equal(timers[0].delay, 2_000);
  timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children.length, 2);
});

test("blocks once on an explicit checkpoint terminal event without preserving stderr", async (t) => {
  const root = await temporaryRoot(t);
  const child = new FakeChild();
  const timers = [];
  const supervisor = await createDouyinSupervisor({
    projectRoot: root,
    nodePath: process.execPath,
    fetchFn: readyFetch,
    spawnProcess: () => child,
    setTimer(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimer() {},
  });
  await supervisor.start();
  child.stdout.write(`${JSON.stringify({
    version: 1,
    event: "bridge-terminal",
    disposition: "block",
    reason: "checkpoint-boundary-unavailable",
    phase: "listening",
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stderr.write("private-chat-content-must-not-enter-status");
  child.emit("exit", 1, null);

  const status = supervisor.getStatus();
  assert.equal(status.phase, "blocked");
  assert.equal(status.lastError.reason, "checkpoint-boundary-unavailable");
  assert.equal(timers.length, 0);
  assert.doesNotMatch(JSON.stringify(status), /private-chat-content/u);
});

test("restarts an explicitly recoverable persisted action even from a dangerous phase", async (t) => {
  const root = await temporaryRoot(t);
  const child = new FakeChild();
  const timers = [];
  const sendCapability = {
    version: 1,
    chatFingerprint: "a".repeat(64),
    targetId: "target-1",
    pageEpoch: "b".repeat(64),
    pageUrlHash: "c".repeat(64),
  };
  const supervisor = await createDouyinSupervisor({
    projectRoot: root,
    nodePath: process.execPath,
    config: { version: 1, sendEnabled: true, sendCapability },
    fetchFn: readyFetch,
    spawnProcess: () => child,
    setTimer(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimer() {},
  });
  await supervisor.start();
  child.stdout.write('{"event":"bridge-status","phase":"sending"}\n');
  child.stdout.write(`${JSON.stringify({
    version: 1,
    event: "bridge-terminal",
    disposition: "recover",
    reason: "ui-authority-recovery-required",
    phase: "reply-ready",
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("exit", 8, null);

  assert.equal(supervisor.getStatus().phase, "restarting");
  assert.equal(supervisor.getStatus().sendEnabled, true);
  assert.equal(timers[0].delay, 2_000);
});

test("rejects an invalid retry tuple in a dangerous phase", async (t) => {
  const root = await temporaryRoot(t);
  const child = new FakeChild();
  const timers = [];
  const supervisor = await createDouyinSupervisor({
    projectRoot: root,
    nodePath: process.execPath,
    fetchFn: readyFetch,
    spawnProcess: () => child,
    setTimer(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimer() {},
  });
  await supervisor.start();
  child.stdout.write('{"event":"bridge-status","phase":"sending"}\n');
  child.stdout.write(`${JSON.stringify({
    version: 1,
    event: "bridge-terminal",
    disposition: "retry",
    reason: "runtime-retry-required",
    phase: "sending",
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("exit", 1, null);

  assert.equal(supervisor.getStatus().phase, "blocked");
  assert.equal(supervisor.getStatus().lastError.reason, "bridge-exit-1");
  assert.equal(timers.length, 0);
});

test("requires exit code eight for explicit UI authority recovery", async (t) => {
  const root = await temporaryRoot(t);
  const child = new FakeChild();
  const timers = [];
  const supervisor = await createDouyinSupervisor({
    projectRoot: root,
    nodePath: process.execPath,
    fetchFn: readyFetch,
    spawnProcess: () => child,
    setTimer(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimer() {},
  });
  await supervisor.start();
  child.stdout.write(`${JSON.stringify({
    version: 1,
    event: "bridge-terminal",
    disposition: "recover",
    reason: "ui-authority-recovery-required",
    phase: "reply-ready",
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("exit", 1, null);

  assert.equal(supervisor.getStatus().phase, "blocked");
  assert.equal(supervisor.getStatus().lastError.reason, "terminal-exit-mismatch");
  assert.equal(timers.length, 0);
});

test("blocks a deterministic persisted-recovery ambiguity without restart churn", async (t) => {
  const root = await temporaryRoot(t);
  const child = new FakeChild();
  const timers = [];
  const supervisor = await createDouyinSupervisor({
    projectRoot: root,
    nodePath: process.execPath,
    fetchFn: readyFetch,
    spawnProcess: () => child,
    setTimer(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimer() {},
  });
  await supervisor.start();
  child.stdout.write(`${JSON.stringify({
    version: 1,
    event: "bridge-terminal",
    disposition: "block",
    reason: "persisted-recovery-ambiguous",
    phase: "starting",
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("exit", 1, null);

  assert.equal(supervisor.getStatus().phase, "blocked");
  assert.equal(supervisor.getStatus().lastError.reason, "persisted-recovery-ambiguous");
  assert.equal(timers.length, 0);
});

test("keeps retrying an idle transient failure at the capped delay instead of going permanently offline", async (t) => {
  const root = await temporaryRoot(t);
  const children = [];
  const timers = [];
  const supervisor = await createDouyinSupervisor({
    projectRoot: root,
    nodePath: process.execPath,
    fetchFn: readyFetch,
    now: () => 1_000,
    spawnProcess() {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    setTimer(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimer() {},
  });
  await supervisor.start();
  for (let failure = 0; failure < 7; failure += 1) {
    const child = children.at(-1);
    child.stdout.write('{"event":"bridge-ready","audioEnabled":true}\n');
    await new Promise((resolve) => setImmediate(resolve));
    child.stdout.write(`${JSON.stringify({
      version: 1,
      event: "bridge-terminal",
      disposition: "retry",
      reason: "runtime-retry-required",
      phase: "listening",
    })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("exit", 1, null);
    if (failure < 6) {
      timers.at(-1).callback();
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  const status = supervisor.getStatus();
  assert.equal(status.phase, "restarting");
  assert.equal(status.restartAttempt, 6);
  assert.equal(timers.at(-1).delay, 60_000);
  assert.notEqual(status.lastError?.reason, "restart-limit-reached");
  timers.at(-1).callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children.length, 8);
  const nextChild = children.at(-1);
  nextChild.stdout.write('{"event":"bridge-ready","audioEnabled":true}\n');
  nextChild.stdout.write(`${JSON.stringify({
    version: 1,
    event: "bridge-terminal",
    disposition: "retry",
    reason: "runtime-retry-required",
    phase: "listening",
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  nextChild.emit("exit", 1, null);
  assert.equal(supervisor.getStatus().phase, "restarting");
  assert.equal(timers.at(-1).delay, 60_000);
});

test("persists only a validated image-capable model and effort", async (t) => {
  const root = await temporaryRoot(t);
  const configPath = path.join(root, ".runtime", "supervisor", "config.json");
  const supervisor = await createDouyinSupervisor({
    projectRoot: root,
    configPath,
    nodePath: process.execPath,
    fetchFn: readyFetch,
    listModelsFn: async () => modelList(),
  });

  await assert.rejects(
    supervisor.setModelEffort({ model: "text-only", effort: "high" }),
    /cannot process Douyin media images/u,
  );
  await supervisor.setModelEffort({ model: "gpt-5.6-sol", effort: "high" });
  await supervisor.setMediaReactions(true);
  assert.equal((await loadSupervisorConfig(configPath)).effort, "high");
  assert.equal((await loadSupervisorConfig(configPath)).mediaReactionEnabled, true);
  assert.doesNotMatch(await readFile(configPath, "utf8"), /token|thread|chat/iu);
});

test("stops cooperatively through the bridge control channel", async (t) => {
  const root = await temporaryRoot(t);
  const child = new FakeChild({ exitOnStop: true });
  const supervisor = await createDouyinSupervisor({
    projectRoot: root,
    nodePath: process.execPath,
    fetchFn: readyFetch,
    spawnProcess: () => child,
  });
  await supervisor.start();
  child.stdout.write('{"event":"bridge-ready","audioEnabled":true}\n');
  await new Promise((resolve) => setImmediate(resolve));

  await supervisor.pause();
  assert.equal(supervisor.getStatus().phase, "paused");
  assert.equal(supervisor.getStatus().bridge, "offline");
});

test("rejects process and thread controls while automatic compaction is active", async (t) => {
  const root = await temporaryRoot(t);
  const child = new FakeChild();
  const supervisor = await createDouyinSupervisor({
    projectRoot: root,
    nodePath: process.execPath,
    fetchFn: readyFetch,
    spawnProcess: () => child,
  });
  await supervisor.start();
  child.stdout.write('{"event":"bridge-ready","audioEnabled":true}\n');
  child.stdout.write('{"event":"bridge-status","phase":"compacting"}\n');
  await new Promise((resolve) => setImmediate(resolve));

  const permissions = supervisor.getStatus().actionPermissions;
  assert.equal(permissions.pause, false);
  assert.equal(permissions.stop, false);
  assert.equal(permissions.reconnect, false);
  assert.equal(permissions.rotateThread, false);
  await assert.rejects(supervisor.pause(), /not allowed while phase is compacting/u);
  await assert.rejects(supervisor.stop(), /not allowed while phase is compacting/u);

  child.stdout.write('{"event":"bridge-status","phase":"listening"}\n');
  child.emit("exit", 0, null);
  await supervisor.close();
});
