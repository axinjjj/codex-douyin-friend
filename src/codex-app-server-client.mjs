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
  constructor({ codexPath = process.env.CODEX_BIN || "codex" } = {}) {
    super();
    this.codexPath = codexPath;
    this.process = null;
    this.reader = null;
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
  }

  async start() {
    if (this.process) return;

    this.process = spawn(this.codexPath, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk) => this.emit("stderr", chunk));
    this.process.once("exit", (code, signal) => {
      const error = new Error(
        `Codex App Server exited unexpectedly (code=${code}, signal=${signal}).`,
      );
      for (const pending of this.pendingRequests.values()) {
        pending.reject(error);
      }
      this.pendingRequests.clear();
      this.emit("exit", { code, signal });
    });

    this.reader = readline.createInterface({ input: this.process.stdout });
    this.reader.on("line", (line) => this.#handleLine(line));

    await this.request("initialize", {
      clientInfo: {
        name: "codex_douyin_friend",
        title: "Codex Douyin Friend",
        version: "0.1.0",
      },
    });
    this.notify("initialized", {});
  }

  request(method, params = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    if (!this.process?.stdin?.writable) {
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

      this.process.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
    });
  }

  notify(method, params = {}) {
    if (!this.process?.stdin?.writable) {
      throw new Error("Codex App Server is not running.");
    }
    this.process.stdin.write(`${JSON.stringify({ method, params })}\n`, "utf8");
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

  async runTurn({
    threadId,
    text,
    input,
    model,
    effort,
    timeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  }) {
    const chunks = [];

    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for turn/completed."));
      }, timeoutMs);

      const onNotification = (message) => {
        if (message?.params?.threadId && message.params.threadId !== threadId) {
          return;
        }

        if (message.method === "item/agentMessage/delta") {
          const delta = message.params?.delta;
          if (typeof delta === "string") chunks.push(delta);
        }

        if (message.method === "item/completed") {
          const completedText = extractAgentText(message.params?.item);
          if (completedText && chunks.length === 0) chunks.push(completedText);
        }

        if (message.method === "turn/completed") {
          cleanup();
          const status = message.params?.turn?.status;
          if (status && status !== "completed") {
            reject(new Error(`Codex turn ended with status ${status}.`));
            return;
          }
          resolve(chunks.join(""));
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.off("notification", onNotification);
      };

      this.on("notification", onNotification);
      try {
        const params = {
          threadId,
          input: input ?? [{ type: "text", text }],
        };
        if (model) params.model = model;
        if (effort) params.effort = effort;
        await this.request("turn/start", params);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  async close() {
    if (!this.process) return;
    this.reader?.close();
    this.process.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.process?.kill();
        resolve();
      }, 2_000);
      this.process.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.process = null;
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
