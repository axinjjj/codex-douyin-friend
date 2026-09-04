import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import readline from "node:readline";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_TIMEOUT_MS = 120_000;

export class CodexAppServerRequestError extends Error {
  constructor({ method, code, message, data }) {
    super(message || `Codex App Server rejected ${method}.`);
    this.name = "CodexAppServerRequestError";
    this.method = method;
    this.code = code;
    this.data = data;
  }
}

export function extractAgentText(item) {
  if (!item || item.type !== "agentMessage") {
    return "";
  }

  if (typeof item.text === "string") {
    return item.text;
  }

  if (!Array.isArray(item.content)) {
    return "";
  }

  return item.content
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      return "";
    })
    .join("");
}

export function instructionSourcesContain(instructionSources, expectedPath) {
  const normalizedExpected = expectedPath.replaceAll("\\", "/").toLowerCase();
  return (instructionSources ?? []).some((source) => {
    const candidate = typeof source === "string" ? source : source?.path;
    return (
      typeof candidate === "string" &&
      candidate.replaceAll("\\", "/").toLowerCase() === normalizedExpected
    );
  });
}

export class CodexAppServerClient extends EventEmitter {
  constructor({
    codexPath = process.env.CODEX_BIN || "codex",
    spawnProcess = spawn,
  } = {}) {
    super();
    this.codexPath = codexPath;
    this.spawnProcess = spawnProcess;
    this.process = null;
    this.reader = null;
    this.startPromise = null;
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    if (this.process) return;
    const operation = this.#startOnce();
    const trackedOperation = operation.finally(() => {
      if (this.startPromise === trackedOperation) this.startPromise = null;
    });
    this.startPromise = trackedOperation;
    return trackedOperation;
  }

  async #startOnce() {
    let child;
    try {
      child = this.spawnProcess(this.codexPath, ["app-server", "--listen", "stdio://"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      throw new Error("Codex App Server could not be started.");
    }
    this.process = child;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => this.emit("stderr", chunk));
    child.stdin.once("error", () => {
      this.#handleTransportFailure(child, "Codex App Server input stream failed.");
    });
    child.once("error", () => {
      this.#handleTransportFailure(child, "Codex App Server process failed to start.");
    });
    child.once("exit", (code, signal) => {
      this.#handleProcessExit(child, code, signal);
    });

    this.reader = readline.createInterface({ input: child.stdout });
    this.reader.on("line", (line) => this.#handleLine(line));

    try {
      await this.request("initialize", {
        clientInfo: {
          name: "codex_douyin_friend",
          title: "Codex Douyin Friend",
          version: "0.1.0",
        },
      });
      this.notify("initialized", {});
    } catch (error) {
      this.#disposeProcess(child, "Codex App Server initialization failed.");
      throw error;
    }
  }

  #handleTransportFailure(child, message) {
    if (!this.#clearProcess(child, new Error(message))) return;
    child.kill?.();
    this.emit("exit", { code: null, signal: "transport-error" });
  }

  #handleProcessExit(child, code, signal) {
    const error = new Error(
      `Codex App Server exited unexpectedly (code=${code}, signal=${signal}).`,
    );
    if (!this.#clearProcess(child, error)) return;
    this.emit("exit", { code, signal });
  }

  #clearProcess(child, error) {
    if (this.process !== child) return false;
    this.process = null;
    this.reader?.close();
    this.reader = null;
    this.#rejectPending(error);
    return true;
  }

  #disposeProcess(child, message) {
    this.#clearProcess(child, new Error(message));
    try {
      child.stdin?.end();
    } catch {
      // The failed transport is already unusable.
    }
    child.kill?.();
  }

  #rejectPending(error) {
    for (const pending of this.pendingRequests.values()) pending.reject(error);
    this.pendingRequests.clear();
  }

  #writePayload(child, payload) {
    if (this.process !== child || !child.stdin?.writable) {
      throw new Error("Codex App Server is not running.");
    }
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
        if (error) this.#handleTransportFailure(child, "Codex App Server input stream failed.");
      });
    } catch {
      this.#handleTransportFailure(child, "Codex App Server input stream failed.");
      throw new Error("Codex App Server input stream failed.");
    }
  }

  request(method, params = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    const child = this.process;
    if (!child?.stdin?.writable) {
      return Promise.reject(new Error("Codex App Server is not running."));
    }

    const id = this.nextRequestId++;
    const payload = { id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timed out waiting for ${method} response.`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      try {
        this.#writePayload(child, payload);
      } catch (error) {
        this.pendingRequests.get(id)?.reject(error);
        this.pendingRequests.delete(id);
      }
    });
  }

  notify(method, params = {}) {
    const child = this.process;
    if (!child?.stdin?.writable) {
      throw new Error("Codex App Server is not running.");
    }
    this.#writePayload(child, { method, params });
  }

  async startThread({ cwd, model, ephemeral = true }) {
    const params = {
      cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral,
      serviceName: "codex_douyin_friend",
    };
    if (model) params.model = model;
    return this.request("thread/start", params);
  }

  async resumeThread({ threadId, cwd, model }) {
    const params = {
      threadId,
      cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
    };
    if (model) params.model = model;
    return this.request("thread/resume", params);
  }

  async injectItems({ threadId, items }) {
    return this.request("thread/inject_items", { threadId, items });
  }

  async readTurn({ threadId, turnId }) {
    const result = await this.request("thread/read", { threadId, includeTurns: true });
    const turn = result?.thread?.turns?.find((candidate) => candidate?.id === turnId);
    if (!turn) return { found: false, status: null, text: "" };
    const text = (turn.items ?? [])
      .map(extractAgentText)
      .filter(Boolean)
      .join("");
    return {
      found: true,
      status: String(turn.status || ""),
      text,
    };
  }

  async runTurn({
    threadId,
    text,
    input,
    model,
    effort,
    onTurnStarted = null,
    timeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  }) {
    const chunks = [];
    const bufferedNotifications = [];
    let expectedTurnId = null;

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timeout);
        this.off("notification", onNotification);
        this.off("exit", onExit);
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const timeout = setTimeout(() => {
        finish(reject, new Error("Timed out waiting for turn/completed."));
      }, timeoutMs);
      const notificationTurnId = (message) => (
        message?.params?.turnId ?? message?.params?.turn?.id ?? null
      );
      const consumeNotification = (message) => {
        if (notificationTurnId(message) !== expectedTurnId) return;
        if (message.method === "item/agentMessage/delta") {
          const delta = message.params?.delta;
          if (typeof delta === "string") chunks.push(delta);
        }
        if (message.method === "item/completed") {
          const completedText = extractAgentText(message.params?.item);
          if (completedText && chunks.length === 0) chunks.push(completedText);
        }
        if (message.method !== "turn/completed") return;
        const status = message.params?.turn?.status;
        if (status && status !== "completed") {
          finish(reject, new Error(`Codex turn ended with status ${status}.`));
          return;
        }
        finish(resolve, chunks.join(""));
      };
      const onNotification = (message) => {
        if (message?.params?.threadId !== threadId) return;
        if (!expectedTurnId) {
          if (bufferedNotifications.length >= 256) {
            finish(reject, new Error("Too many Codex notifications arrived before turn/start completed."));
            return;
          }
          bufferedNotifications.push(message);
          return;
        }
        consumeNotification(message);
      };
      const onExit = () => {
        finish(reject, new Error("Codex App Server exited before the turn completed."));
      };

      this.on("notification", onNotification);
      this.on("exit", onExit);
      const params = {
        threadId,
        input: input ?? [{ type: "text", text }],
      };
      if (model) params.model = model;
      if (effort) params.effort = effort;
      this.request("turn/start", params).then((result) => {
        expectedTurnId = result?.turn?.id ?? null;
        if (!expectedTurnId) {
          finish(reject, new Error("turn/start did not return a turn id."));
          return;
        }
        Promise.resolve(typeof onTurnStarted === "function"
          ? onTurnStarted({ threadId, turnId: expectedTurnId })
          : null).then(() => {
          for (const message of bufferedNotifications.splice(0)) {
            if (settled) break;
            consumeNotification(message);
          }
        }, (error) => finish(reject, error));
      }, (error) => finish(reject, error));
    });
  }

  async close() {
    const child = this.process;
    if (!child) return;
    this.#clearProcess(child, new Error("Codex App Server client was closed."));
    try {
      child.stdin.end();
    } catch {
      child.kill?.();
      return;
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill?.();
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("protocolError", new Error("Received non-JSON output from Codex."));
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) return;
      this.pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(new CodexAppServerRequestError({
          method: pending.method,
          code: message.error.code,
          message: message.error.message,
          data: message.error.data,
        }));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    this.emit("notification", message);
  }
}
