export class CdpClient {
  constructor(webSocketUrl, { WebSocketImpl = globalThis.WebSocket } = {}) {
    if (typeof WebSocketImpl !== "function") {
      throw new Error("A WebSocket implementation is required.");
    }
    this.webSocketUrl = webSocketUrl;
    this.WebSocketImpl = WebSocketImpl;
    this.socket = null;
    this.connectPromise = null;
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
  }

  async connect(timeoutMs = 5_000) {
    if (this.socket?.readyState === (this.WebSocketImpl.OPEN ?? 1)) return;
    if (this.connectPromise) return this.connectPromise;
    this.socket?.close();
    this.socket = null;

    const socket = new this.WebSocketImpl(this.webSocketUrl);
    this.socket = socket;
    const operation = new Promise((resolve, reject) => {
      let connected = false;
      let settled = false;
      const failConnection = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (this.socket === socket) this.socket = null;
        try {
          socket.close();
        } catch {
          // The failed transport is already unusable.
        }
        reject(error);
      };
      const timeout = setTimeout(() => {
        failConnection(new Error("Timed out connecting to the CDP debugger."));
      }, timeoutMs);

      socket.addEventListener("message", (event) => this.#handleMessage(event.data));
      socket.addEventListener("close", () => {
        const error = new Error("CDP debugger connection closed.");
        if (!connected) {
          failConnection(error);
          return;
        }
        this.#handleDisconnect(socket, error);
      }, { once: true });
      socket.addEventListener("error", () => {
        const error = new Error("CDP debugger connection failed.");
        if (!connected) {
          failConnection(error);
          return;
        }
        this.#handleDisconnect(socket, error);
      }, { once: true });
      socket.addEventListener("open", () => {
        if (settled) return;
        connected = true;
        settled = true;
        clearTimeout(timeout);
        resolve();
      }, { once: true });
    });
    const trackedOperation = operation.finally(() => {
      if (this.connectPromise === trackedOperation) this.connectPromise = null;
    });
    this.connectPromise = trackedOperation;
    return trackedOperation;
  }

  request(method, params = {}, timeoutMs = 5_000) {
    if (!this.socket || this.socket.readyState !== (this.WebSocketImpl.OPEN ?? 1)) {
      return Promise.reject(new Error("CDP client is not connected."));
    }

    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      const socket = this.socket;
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch {
        const error = new Error("CDP debugger request could not be written.");
        this.pendingRequests.get(id)?.reject(error);
        this.pendingRequests.delete(id);
        this.#handleDisconnect(socket, error);
      }
    });
  }

  async evaluate(expression, timeoutMs = 5_000) {
    const result = await this.request("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, timeoutMs);

    if (result?.exceptionDetails) {
      throw new Error("The page rejected the safe inspection expression.");
    }
    return result?.result?.value;
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    this.#rejectPending(new Error("CDP client was closed."));
    socket?.close();
  }

  #handleDisconnect(socket, error) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.#rejectPending(error);
  }

  #rejectPending(error) {
    for (const pending of this.pendingRequests.values()) pending.reject(error);
    this.pendingRequests.clear();
  }

  #handleMessage(rawMessage) {
    let message;
    try {
      message = JSON.parse(rawMessage);
    } catch {
      return;
    }

    if (message.id === undefined) return;
    const pending = this.pendingRequests.get(message.id);
    if (!pending) return;
    this.pendingRequests.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error.message || "CDP request failed."));
    } else {
      pending.resolve(message.result);
    }
  }
}
export function summarizeTargets(targets) {
  return (targets ?? []).map((target) => ({
    type: target?.type ?? "unknown",
    hasDebuggerEndpoint: typeof target?.webSocketDebuggerUrl === "string",
    hasUrl: typeof target?.url === "string" && target.url.length > 0,
  }));
}
