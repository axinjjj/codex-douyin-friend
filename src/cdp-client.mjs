export class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.socket = null;
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
  }

  async connect(timeoutMs = 5_000) {
    if (this.socket) return;

    const socket = new WebSocket(this.webSocketUrl);
    this.socket = socket;

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("Timed out connecting to the Electron debugger."));
      }, timeoutMs);

      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error("Electron debugger connection failed."));
        },
        { once: true },
      );
    });

    socket.addEventListener("message", (event) => this.#handleMessage(event.data));
    socket.addEventListener("close", () => {
      const error = new Error("Electron debugger connection closed.");
      for (const pending of this.pendingRequests.values()) pending.reject(error);
      this.pendingRequests.clear();
    });
  }

  request(method, params = {}, timeoutMs = 5_000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
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
      this.socket.send(JSON.stringify({ id, method, params }));
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
    this.socket?.close();
    this.socket = null;
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
