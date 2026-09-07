import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import readline from "node:readline";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000;
const MIN_TURN_TIMEOUT_MS = 5 * 60_000;
const MAX_TURN_TIMEOUT_MS = 60 * 60_000;

export function resolveCodexTurnTimeoutMs(environment = process.env) {
  const raw = environment.CODEX_DOUYIN_TURN_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_TURN_TIMEOUT_MS;
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/u.test(raw)) {
    throw new Error("CODEX_DOUYIN_TURN_TIMEOUT_MS must be an integer number of milliseconds.");
  }
  const timeoutMs = Number(raw);
  if (!Number.isSafeInteger(timeoutMs)
      || timeoutMs < MIN_TURN_TIMEOUT_MS
      || timeoutMs > MAX_TURN_TIMEOUT_MS) {
    throw new Error(
      `CODEX_DOUYIN_TURN_TIMEOUT_MS must be between ${MIN_TURN_TIMEOUT_MS} and ${MAX_TURN_TIMEOUT_MS}.`,
    );
  }
  return timeoutMs;
}

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

// item/completed is the authoritative item snapshot. Keep this projection shared
// by live completion and crash recovery; commentary is never a chat reply.
export function selectCompletedCodexReply(items) {
  const messages = (items ?? []).filter((item) => item?.type === "agentMessage");
  if (messages.length > 64) throw new Error("Too many Codex reply items.");
  const finals = messages.filter((item) => item.phase === "final_answer");
  let selected;
  if (finals.length === 1) {
    selected = finals[0];
  } else if (finals.length === 0 && messages.length === 1
      && (messages[0].phase === undefined || messages[0].phase === null)) {
    // Older App Server item snapshots omit phase. Only a single item is unambiguous.
    selected = messages[0];
  } else {
    throw new Error("The Codex turn has no unique completed final reply.");
  }
  const text = extractAgentText(selected);
  if (!text.trim() || Buffer.byteLength(text, "utf8") > 128 * 1024) {
    throw new Error("The completed Codex reply is empty or exceeds its bound.");
  }
  return text;
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

  async setThreadName({ threadId, name }) {
    return this.request("thread/name/set", { threadId, name });
  }

  async injectItems({ threadId, items }) {
    return this.request("thread/inject_items", { threadId, items });
  }

  async readTurn({ threadId, turnId }) {
    const result = await this.request("thread/read", { threadId, includeTurns: true });
    const turn = result?.thread?.turns?.find((candidate) => candidate?.id === turnId);
    if (!turn) return { found: false, status: null, text: "" };
    const text = turn.status === "completed"
      ? selectCompletedCodexReply(turn.items ?? [])
      : "";
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
    timeoutMs = resolveCodexTurnTimeoutMs(),
  }) {
    const chunks = [];
    const completedItems = new Map();
    let anonymousItemCount = 0;
    let sawStructuredAgent = false;
    let legacyBytes = 0;
    const bufferedNotifications = [];
    let expectedTurnId = null;
    let turnStartCommitted = false;

    return new Promise((resolve, reject) => {
      let settled = false;
      let journalInFlight = false;
      let hasDeferredFailure = false;
      let deferredFailure = null;
      const cleanup = () => {
        clearTimeout(timeout);
        this.off("notification", onNotification);
        this.off("exit", onExit);
      };
      const finish = (callback, value) => {
        if (settled) return;
        if (journalInFlight) {
          // Do not release the caller/run lock while its durable write can still land.
          if (callback === reject && !hasDeferredFailure) {
            hasDeferredFailure = true;
            deferredFailure = value;
          }
          return;
        }
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
        if (settled || notificationTurnId(message) !== expectedTurnId) return;
        try {
          const item = message.params?.item;
          if (message.method === "item/started" && item?.type === "agentMessage") {
            sawStructuredAgent = true;
          }
          if (message.method === "item/agentMessage/delta") {
            if (message.params?.itemId) sawStructuredAgent = true;
            // Compatibility for legacy streams that carry no structured items or item id.
            // Modern item-id streams must supply a completed item; partial deltas cannot win.
            if (!sawStructuredAgent && typeof message.params?.delta === "string") {
              legacyBytes += Buffer.byteLength(message.params.delta, "utf8");
              if (legacyBytes > 128 * 1024) {
                throw new Error("Codex reply stream exceeded its bound.");
              }
              chunks.push(message.params.delta);
            }
          }
          if (message.method === "item/completed" && item?.type === "agentMessage") {
            sawStructuredAgent = true;
            const key = item.id ?? `anonymous-${++anonymousItemCount}`;
            if (completedItems.has(key)
                && JSON.stringify(completedItems.get(key)) !== JSON.stringify(item)) {
              throw new Error("A completed Codex reply item changed after completion.");
            }
            completedItems.set(key, item);
            if (completedItems.size > 64) throw new Error("Too many Codex reply items.");
          }
          if (message.method !== "turn/completed") return;
          const status = message.params?.turn?.status;
          if (status && status !== "completed") {
            throw new Error(`Codex turn ended with status ${status}.`);
          }
          const text = completedItems.size > 0
            ? selectCompletedCodexReply([...completedItems.values()])
            : !sawStructuredAgent && legacyBytes > 0
              ? chunks.join("")
              : selectCompletedCodexReply([]);
          finish(resolve, text);
        } catch (error) {
          finish(reject, error);
        }
      };
      const onNotification = (message) => {
        if (settled || message?.params?.threadId !== threadId) return;
        if (expectedTurnId && notificationTurnId(message) !== expectedTurnId) return;
        if (!["item/started", "item/agentMessage/delta", "item/completed", "turn/completed"]
            .includes(message.method)) return;
        if (!turnStartCommitted) {
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
      Promise.resolve().then(() => this.request("turn/start", params)).then(async (result) => {
        // A late response must not begin a stale journal write after timeout or exit.
        if (settled) return;
        expectedTurnId = result?.turn?.id ?? null;
        if (!expectedTurnId) throw new Error("turn/start did not return a turn id.");
        if (typeof onTurnStarted === "function") {
          journalInFlight = true;
          try {
            await onTurnStarted({ threadId, turnId: expectedTurnId });
          } catch (error) {
            if (!hasDeferredFailure) {
              hasDeferredFailure = true;
              deferredFailure = error;
            }
          } finally {
            journalInFlight = false;
          }
        }
        if (hasDeferredFailure) {
          finish(reject, deferredFailure);
          return;
        }
        if (settled) return;
        turnStartCommitted = true;
        for (const message of bufferedNotifications.splice(0)) {
          if (settled) break;
          consumeNotification(message);
        }
      }).catch((error) => finish(reject, error));
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

    if (message.id !== undefined && typeof message.method === "string") {
      // Server requests have their own id namespace. Never interpret them as responses
      // to our requests and never grant tools/permissions implicitly.
      try {
        this.#writePayload(this.process, {
          id: message.id,
          error: { code: -32601, message: "Server requests are not supported by this bridge." },
        });
      } catch {
        // #writePayload already tears down a failed transport.
      }
      this.emit("serverRequestRejected", { reason: "unsupported-server-request" });
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
