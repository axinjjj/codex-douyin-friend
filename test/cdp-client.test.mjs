import test from "node:test";
import assert from "node:assert/strict";
import { CdpClient } from "../src/cdp-client.mjs";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;

  static instances = [];

  constructor() {
    this.readyState = FakeWebSocket.CONNECTING;
    this.listeners = new Map();
    this.throwOnSend = false;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(name, listener, options = {}) {
    const entries = this.listeners.get(name) ?? [];
    entries.push({ listener, once: Boolean(options.once) });
    this.listeners.set(name, entries);
  }

  emit(name, event = {}) {
    const entries = [...(this.listeners.get(name) ?? [])];
    for (const entry of entries) {
      entry.listener(event);
      if (entry.once) {
        this.listeners.set(name, (this.listeners.get(name) ?? []).filter((value) => value !== entry));
      }
    }
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  send() {
    if (this.throwOnSend) throw new Error("private transport detail");
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close");
  }
}

test.beforeEach(() => {
  FakeWebSocket.instances = [];
});

test("clears a failed connection so the same CDP client can reconnect", async () => {
  const client = new CdpClient("ws://127.0.0.1/test", { WebSocketImpl: FakeWebSocket });
  const first = client.connect(1_000);
  FakeWebSocket.instances[0].emit("error");
  await assert.rejects(first, /connection failed/u);

  const second = client.connect(1_000);
  FakeWebSocket.instances[1].open();
  await second;
  assert.equal(FakeWebSocket.instances.length, 2);
  client.close();
});

test("remote close clears the live socket and rejects pending requests", async () => {
  const client = new CdpClient("ws://127.0.0.1/test", { WebSocketImpl: FakeWebSocket });
  const connected = client.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await connected;
  const pending = client.request("Runtime.evaluate");
  socket.close();
  await assert.rejects(pending, /connection closed/u);
  await assert.rejects(client.request("Runtime.evaluate"), /not connected/u);
});

test("synchronous send failure removes the pending request and disconnects", async () => {
  const client = new CdpClient("ws://127.0.0.1/test", { WebSocketImpl: FakeWebSocket });
  const connected = client.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await connected;
  socket.throwOnSend = true;
  await assert.rejects(client.request("Runtime.evaluate"), /could not be written/u);
  assert.equal(client.pendingRequests.size, 0);
  await assert.rejects(client.request("Runtime.evaluate"), /not connected/u);
});
