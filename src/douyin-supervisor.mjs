import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";

const SAFETY_EXIT_CODES = new Set([3, 4, 5, 6, 7]);
const DANGEROUS_PHASES = new Set(["processing", "reply-ready", "sending", "compacting"]);
const MODEL_PATTERN = /^[A-Za-z0-9._/\[\]-]{1,96}$/u;
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const RESTART_DELAYS_MS = [2_000, 5_000, 15_000, 60_000];
const RESTART_WINDOW_MS = 10 * 60_000;
const MAX_RESTARTS_PER_WINDOW = 6;
const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  model: "gpt-5.6-sol",
  effort: "xhigh",
  sendEnabled: false,
  mediaReactionEnabled: false,
  bridgeTimeoutMs: 86_400_000,
  debugPort: 9229,
  autoLaunchEdge: true,
});

function validateConfig(value) {
  const config = { ...DEFAULT_CONFIG, ...(value ?? {}) };
  if (config.version !== 1) throw new Error("Unsupported supervisor config version.");
  if (!MODEL_PATTERN.test(config.model)) throw new Error("Invalid Codex model id.");
  if (!EFFORTS.has(config.effort)) throw new Error("Invalid Codex reasoning effort.");
  if (typeof config.sendEnabled !== "boolean"
      || typeof config.mediaReactionEnabled !== "boolean"
      || typeof config.autoLaunchEdge !== "boolean") {
    throw new Error("Supervisor boolean config is invalid.");
  }
  if (!Number.isInteger(config.bridgeTimeoutMs) || config.bridgeTimeoutMs < 60_000) {
    throw new Error("Bridge timeout must be at least one minute.");
  }
  if (!Number.isInteger(config.debugPort) || config.debugPort < 1024 || config.debugPort > 65_535) {
    throw new Error("Douyin debugger port is invalid.");
  }
  return config;
}

export async function loadSupervisorConfig(configPath) {
  try {
    return validateConfig(JSON.parse(await fs.readFile(configPath, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return { ...DEFAULT_CONFIG };
    throw error;
  }
}

export async function saveSupervisorConfig(configPath, config) {
  const validated = validateConfig(config);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.tmp-${process.pid}`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await fs.rename(temporaryPath, configPath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
  return validated;
}

export function acquireSupervisorLock(pipeName = "codex-douyin-supervisor-v1") {
  if (process.platform !== "win32") {
    return Promise.resolve({ close: async () => {} });
  }
  const endpoint = `\\\\.\\pipe\\${pipeName}`;
  return new Promise((resolve, reject) => {
    const server = net.createServer(() => {});
    server.once("error", (error) => {
      if (error?.code === "EADDRINUSE") {
        reject(new Error("Another Douyin supervisor instance is already running."));
      } else {
        reject(error);
      }
    });
    server.listen(endpoint, () => resolve({
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

export function findInstalledEdge(env = process.env) {
  const candidates = [
    env["ProgramFiles(x86)"],
    env.PROGRAMFILES_X86,
    env.ProgramFiles,
    env.PROGRAMFILES,
  ]
    .filter(Boolean)
    .map((root) => path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
  return [...new Set(candidates)];
}

function safeModelEntry(entry) {
  const id = String(entry?.id || entry?.model || "");
  if (!MODEL_PATTERN.test(id)) return null;
  return {
    id,
    displayName: String(entry?.displayName || id).slice(0, 120),
    supportedEfforts: (entry?.supportedReasoningEfforts ?? [])
      .map((item) => typeof item === "string" ? item : item?.reasoningEffort)
      .filter((effort) => EFFORTS.has(effort)),
    inputModalities: (entry?.inputModalities ?? ["text", "image"])
      .filter((modality) => modality === "text" || modality === "image"),
  };
}

function actionPermissions(status) {
  const phase = status.phase;
  const idle = phase === "listening" || phase === "paused" || phase === "offline";
  const running = status.bridge === "running";
  return {
    start: !running && phase !== "blocked",
    pause: running && phase === "listening",
    stop: running && !DANGEROUS_PHASES.has(phase),
    reconnect: !DANGEROUS_PHASES.has(phase),
    compact: running && phase === "listening",
    rotateThread: (running && phase === "listening") || phase === "blocked",
    setAutoSend: idle,
    setMediaReactions: idle,
    setModelEffort: idle,
  };
}

export class DouyinSupervisor extends EventEmitter {
  constructor({
    projectRoot,
    configPath = path.join(projectRoot, ".runtime", "supervisor", "config.json"),
    config = DEFAULT_CONFIG,
    nodePath = process.execPath,
    spawnProcess = spawn,
    fetchFn = fetch,
    listModelsFn = async () => [],
    fileExists = async (filePath) => fs.access(filePath).then(() => true, () => false),
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    super();
    if (!path.isAbsolute(projectRoot)) throw new Error("Supervisor project root must be absolute.");
    if (!path.isAbsolute(nodePath)) throw new Error("Supervisor Node path must be absolute.");
    this.projectRoot = projectRoot;
    this.configPath = configPath;
    this.config = validateConfig(config);
    this.nodePath = nodePath;
    this.spawnProcess = spawnProcess;
    this.fetchFn = fetchFn;
    this.listModelsFn = listModelsFn;
    this.fileExists = fileExists;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.child = null;
    this.stdoutReader = null;
    this.desiredRunning = false;
    this.plannedStop = false;
    this.restartTimer = null;
    this.restartTimes = [];
    this.forceFreshThread = false;
    this.models = [];
    this.status = {
      supervisor: "ready",
      edge: "unknown",
      bridge: "offline",
      appServer: "offline",
      audio: "unknown",
      phase: "offline",
      model: this.config.model,
      effort: this.config.effort,
      sendEnabled: this.config.sendEnabled,
      mediaReactionEnabled: this.config.mediaReactionEnabled,
      lastLatencyMs: null,
      contextUsage: null,
      compaction: "idle",
      cacheBytes: 0,
      lastError: null,
      restartAttempt: 0,
    };
  }

  getStatus() {
    const snapshot = structuredClone(this.status);
    snapshot.actionPermissions = actionPermissions(snapshot);
    return snapshot;
  }

  async listModels({ refresh = false } = {}) {
    if (refresh || this.models.length === 0) {
      const entries = await this.listModelsFn();
      this.models = (entries ?? []).map(safeModelEntry).filter(Boolean);
    }
    return structuredClone(this.models);
  }

  async start() {
    this.desiredRunning = true;
    if (this.child) return this.getStatus();
    this.#cancelRestart();
    if (!(await this.#ensureEdge())) return this.getStatus();
    this.#spawnBridge();
    return this.getStatus();
  }

  async pause() {
    this.desiredRunning = false;
    this.#cancelRestart();
    await this.#stopBridge("pause");
    this.#update({ phase: "paused", bridge: "offline", appServer: "offline" });
    return this.getStatus();
  }

  async stop() {
    this.desiredRunning = false;
    this.#cancelRestart();
    await this.#stopBridge("stop");
    this.#update({ phase: "offline", bridge: "offline", appServer: "offline" });
    return this.getStatus();
  }

  async reconnect() {
    this.#requireAllowed("reconnect");
    this.#update({ phase: this.child ? "stopping" : "offline", lastError: null });
    await this.#restartBridge();
    return this.getStatus();
  }

  compact(requestId = `compact_${this.now()}`) {
    this.#requireAllowed("compact");
    this.#writeCommand("compact", requestId);
    return { ok: true, accepted: true };
  }

  async rotateThread() {
    this.#requireAllowed("rotateThread");
    this.forceFreshThread = true;
    await this.#restartBridge();
    return this.getStatus();
  }

  async setAutoSend(sendEnabled) {
    this.#requireAllowed("setAutoSend");
    if (typeof sendEnabled !== "boolean") throw new Error("sendEnabled must be boolean.");
    this.config = await saveSupervisorConfig(this.configPath, { ...this.config, sendEnabled });
    this.#update({ sendEnabled });
    if (this.child) await this.#restartBridge();
    return this.getStatus();
  }

  async setMediaReactions(mediaReactionEnabled) {
    this.#requireAllowed("setMediaReactions");
    if (typeof mediaReactionEnabled !== "boolean") {
      throw new Error("mediaReactionEnabled must be boolean.");
    }
    this.config = await saveSupervisorConfig(this.configPath, {
      ...this.config,
      mediaReactionEnabled,
    });
    this.#update({ mediaReactionEnabled });
    if (this.child) await this.#restartBridge();
    return this.getStatus();
  }

  async setModelEffort({ model, effort }) {
    this.#requireAllowed("setModelEffort");
    const models = await this.listModels();
    const selected = models.find((entry) => entry.id === model);
    if (!selected) throw new Error("Selected model is not available.");
    if (!selected.inputModalities.includes("image")) {
      throw new Error("Selected model cannot process Douyin media images.");
    }
    if (!selected.supportedEfforts.includes(effort)) {
      throw new Error("Selected reasoning effort is not supported.");
    }
    this.config = await saveSupervisorConfig(this.configPath, { ...this.config, model, effort });
    this.#update({ model, effort });
    if (this.child) await this.#restartBridge();
    return this.getStatus();
  }

  async performAction(action, payload = {}) {
    if (action === "start") return this.start();
    if (action === "pause") return this.pause();
    if (action === "stop") return this.stop();
    if (action === "reconnect") return this.reconnect();
    if (action === "compact") return this.compact();
    if (action === "rotateThread") return this.rotateThread();
    if (action === "setAutoSend") return this.setAutoSend(payload.sendEnabled);
    if (action === "setMediaReactions") {
      return this.setMediaReactions(payload.mediaReactionEnabled);
    }
    if (action === "setModelEffort") return this.setModelEffort(payload);
    throw new Error("Unknown supervisor action.");
  }

  async close() {
    this.desiredRunning = false;
    this.#cancelRestart();
    await this.#stopBridge("shutdown");
    this.removeAllListeners();
  }

  async #ensureEdge() {
    try {
      const response = await this.fetchFn(`http://127.0.0.1:${this.config.debugPort}/json/list`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (response.ok) {
        this.#update({ edge: "ready" });
        return true;
      }
    } catch {
      // The dedicated browser can be launched below when configured.
    }
    this.#update({ edge: "offline" });
    if (!this.config.autoLaunchEdge) {
      this.#block("edge-offline");
      return false;
    }
    const edgePath = await this.#resolveEdgePath();
    if (!edgePath) {
      this.#block("edge-not-found");
      return false;
    }
    const profileDirectory = path.join(this.projectRoot, ".runtime", "edge-profile");
    const edge = this.spawnProcess(edgePath, [
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${this.config.debugPort}`,
      `--remote-allow-origins=http://127.0.0.1:${this.config.debugPort}`,
      `--user-data-dir=${profileDirectory}`,
      "--no-first-run",
      "--new-window",
      "https://www.douyin.com/chat",
    ], {
      cwd: this.projectRoot,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    edge.unref?.();
    this.#update({ edge: "starting", phase: "waiting-for-edge" });
    this.#scheduleRestart(2_000);
    return false;
  }

  async #resolveEdgePath() {
    for (const candidate of findInstalledEdge()) {
      if (await this.fileExists(candidate)) return candidate;
    }
    return null;
  }

  #spawnBridge() {
    const scriptPath = path.join(this.projectRoot, "scripts", "run-douyin-bridge.mjs");
    const child = this.spawnProcess(this.nodePath, [scriptPath], {
      cwd: this.projectRoot,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        DOUYIN_SUPERVISED: "true",
        DOUYIN_SEND_ENABLED: String(this.config.sendEnabled),
        DOUYIN_MEDIA_REACTION_ENABLED: String(this.config.mediaReactionEnabled),
        DOUYIN_BRIDGE_TIMEOUT_MS: String(this.config.bridgeTimeoutMs),
        DOUYIN_DEBUG_PORT: String(this.config.debugPort),
        DOUYIN_FORCE_FRESH_THREAD: String(this.forceFreshThread),
        CODEX_DOUYIN_MODEL: this.config.model,
        CODEX_DOUYIN_EFFORT: this.config.effort,
      },
    });
    this.forceFreshThread = false;
    this.child = child;
    this.plannedStop = false;
    this.#update({ bridge: "running", appServer: "starting", phase: "starting", lastError: null });
    this.stdoutReader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.stdoutReader.on("line", (line) => this.#handleBridgeLine(line));
    child.stderr.on("data", () => {
      this.#update({ lastError: { event: "bridge-stderr", reason: "private-diagnostics-hidden" } });
    });
    child.once("error", () => this.#handleBridgeExit(null, "spawn-error"));
    child.once("exit", (code, signal) => this.#handleBridgeExit(code, signal));
  }

  #handleBridgeLine(line) {
    if (Buffer.byteLength(line, "utf8") > 64 * 1024) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!event || typeof event.event !== "string") return;
    if (event.event === "bridge-ready") {
      this.restartTimes = [];
      this.#update({
        bridge: "running",
        appServer: "ready",
        audio: event.audioEnabled ? "ready" : "unavailable",
        edge: "ready",
        phase: "listening",
        model: String(event.model || this.config.model),
        effort: String(event.effort || this.config.effort),
        mediaReactionEnabled: Boolean(event.mediaReactionEnabled),
      });
      return;
    }
    if (event.event === "bridge-status") {
      this.#update({
        phase: String(event.phase || this.status.phase),
        lastLatencyMs: Number.isFinite(event.lastLatencyMs) ? event.lastLatencyMs : this.status.lastLatencyMs,
        contextUsage: event.contextUsage ?? this.status.contextUsage,
      });
      return;
    }
    if (event.event === "context-usage-updated") {
      this.#update({ contextUsage: event.contextUsage ?? null });
      return;
    }
    if (event.event === "context-compaction-completed") {
      this.#update({ compaction: "idle" });
      return;
    }
    if (event.event === "context-compaction-failed") {
      this.#update({
        compaction: "failed",
        lastError: { event: "context-compaction-failed", reason: String(event.reason || "unknown") },
      });
      return;
    }
    if (event.event === "bridge-command-accepted" && event.command === "compact") {
      this.#update({ compaction: "running" });
      return;
    }
    if (event.event === "bridge-command-result" && event.command === "compact") {
      this.#update({ compaction: event.ok ? "idle" : "failed" });
      return;
    }
    if (/bridge-stopped|send-unverified|ambiguous|chat-changed/u.test(event.event)) {
      this.#block(event.event);
    }
  }

  #handleBridgeExit(code, signal) {
    if (!this.child) return;
    this.stdoutReader?.close();
    this.stdoutReader = null;
    this.child = null;
    const wasPlanned = this.plannedStop;
    this.plannedStop = false;
    this.#update({ bridge: "offline", appServer: "offline" });
    if (!this.desiredRunning || wasPlanned) return;
    if (SAFETY_EXIT_CODES.has(code) || DANGEROUS_PHASES.has(this.status.phase)) {
      this.#block(`bridge-exit-${code ?? signal ?? "unknown"}`);
      return;
    }
    this.#scheduleRestart();
  }

  #scheduleRestart(delayOverride = null) {
    if (!this.desiredRunning || this.restartTimer) return;
    const cutoff = this.now() - RESTART_WINDOW_MS;
    this.restartTimes = this.restartTimes.filter((timestamp) => timestamp >= cutoff);
    if (this.restartTimes.length >= MAX_RESTARTS_PER_WINDOW) {
      this.#block("restart-limit-reached");
      return;
    }
    const attempt = this.restartTimes.length;
    const delay = delayOverride ?? RESTART_DELAYS_MS[Math.min(attempt, RESTART_DELAYS_MS.length - 1)];
    this.restartTimes.push(this.now());
    this.#update({ phase: "restarting", restartAttempt: attempt + 1 });
    this.restartTimer = this.setTimer(() => {
      this.restartTimer = null;
      this.start().catch(() => this.#block("restart-failed"));
    }, delay);
  }

  async #restartBridge() {
    this.desiredRunning = true;
    await this.#stopBridge("restart");
    return this.start();
  }

  async #stopBridge(reason) {
    const child = this.child;
    if (!child) return;
    this.plannedStop = true;
    this.#update({ phase: "stopping" });
    let cancelWait = () => {};
    const exitWait = new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.clearTimer(timeout);
        child.off("exit", finish);
        resolve();
      };
      const timeout = this.setTimer(finish, 10_000);
      child.once("exit", finish);
      cancelWait = finish;
    });
    try {
      this.#writeCommand("stop", `${reason}_${this.now()}`);
      await exitWait;
    } catch (error) {
      cancelWait();
      this.plannedStop = false;
      throw error;
    }
    if (this.child === child) {
      this.#block("bridge-stop-timeout");
      throw new Error("Bridge did not stop cleanly within ten seconds.");
    }
  }

  #writeCommand(command, requestId) {
    if (!this.child?.stdin?.writable) throw new Error("Bridge control channel is unavailable.");
    this.child.stdin.write(`${JSON.stringify({ version: 1, command, requestId })}\n`);
  }

  #requireAllowed(action) {
    if (!actionPermissions(this.getStatus())[action]) {
      throw new Error(`Supervisor action is not allowed while phase is ${this.status.phase}.`);
    }
  }

  #block(reason) {
    this.desiredRunning = false;
    this.#cancelRestart();
    this.#update({
      bridge: this.child ? "running" : "offline",
      phase: "blocked",
      lastError: { event: "supervisor-blocked", reason: String(reason).slice(0, 160) },
    });
  }

  #cancelRestart() {
    if (this.restartTimer) this.clearTimer(this.restartTimer);
    this.restartTimer = null;
  }

  #update(patch) {
    Object.assign(this.status, patch);
    this.emit("status", this.getStatus());
  }
}

export async function createDouyinSupervisor(options) {
  const configPath = options.configPath
    ?? path.join(options.projectRoot, ".runtime", "supervisor", "config.json");
  const config = options.config ?? await loadSupervisorConfig(configPath);
  return new DouyinSupervisor({ ...options, configPath, config });
}
