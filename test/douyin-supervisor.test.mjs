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
