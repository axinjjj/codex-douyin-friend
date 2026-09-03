import test from "node:test";
import assert from "node:assert/strict";
import { createDouyinControlServer } from "../src/douyin-control-server.mjs";

function createController() {
  const calls = [];
  const status = {
    supervisor: "ready",
    edge: "ready",
    bridge: "running",
    appServer: "ready",
    audio: "ready",
    phase: "listening",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    sendEnabled: true,
    mediaReactionEnabled: true,
    lastLatencyMs: null,
    contextUsage: null,
    compaction: "idle",
    cacheBytes: 0,
    lastError: null,
    restartAttempt: 0,
    actionPermissions: { compact: true, setMediaReactions: true },
  };
  return {
    calls,
    getStatus: () => structuredClone(status),
    listModels: async () => [{
      id: "gpt-5.6-sol",
      displayName: "GPT 5.6 Sol",
      supportedEfforts: ["xhigh"],
      inputModalities: ["text", "image"],
    }],
    async performAction(action, payload) {
      calls.push({ action, payload });
      return { accepted: true };
    },
  };
}

test("serves a localhost-only dashboard without private conversation state", async (t) => {
  const controller = createController();
  const dashboard = createDouyinControlServer({ controller, port: 0, csrfToken: "test-token" });
  const url = await dashboard.listen();
  t.after(() => dashboard.close());

  const page = await fetch(url);
  assert.equal(page.status, 200);
  const pageText = await page.text();
  assert.match(pageText, /Codex · 抖音桥/u);
  assert.match(pageText, /允许模型给媒体点赞/u);
  assert.match(pageText, /保留在持久 Codex 任务/u);
  const appText = await (await fetch(`${url}/app.js`)).text();
  assert.match(appText, /queued:"排队处理中"/u);
  assert.match(appText, /产品数据设置约束/u);

  const status = await (await fetch(`${url}/api/status`)).json();
  assert.equal(status.phase, "listening");
  assert.equal(status.mediaReactionEnabled, true);
  assert.equal(status.threadId, undefined);
  assert.equal(status.chatText, undefined);

  const models = await (await fetch(`${url}/api/models`)).json();
  assert.equal(models[0].id, "gpt-5.6-sol");
  const session = await (await fetch(`${url}/api/session`)).json();
  assert.equal(session.csrfToken, "test-token");

  const reactionAction = await fetch(`${url}/api/action`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: url,
      "x-csrf-token": "test-token",
    },
    body: JSON.stringify({
      action: "setMediaReactions",
      payload: { mediaReactionEnabled: false },
    }),
  });
  assert.equal(reactionAction.status, 200);
  assert.deepEqual(controller.calls, [{
    action: "setMediaReactions",
    payload: { mediaReactionEnabled: false },
  }]);
});

test("requires exact origin and CSRF token for control actions", async (t) => {
  const controller = createController();
  const dashboard = createDouyinControlServer({ controller, port: 0, csrfToken: "test-token" });
  const url = await dashboard.listen();
  t.after(() => dashboard.close());
  const request = (origin, token) => fetch(`${url}/api/action`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "x-csrf-token": token,
    },
    body: JSON.stringify({ action: "compact", payload: {} }),
  });

  assert.equal((await request("https://example.com", "test-token")).status, 403);
  assert.equal((await request(url, "wrong-token")).status, 403);
  const accepted = await request(url, "test-token");
  assert.equal(accepted.status, 200);
  assert.deepEqual(controller.calls, [{ action: "compact", payload: {} }]);
});

test("rejects unlisted actions before they reach the supervisor", async (t) => {
  const controller = createController();
  const dashboard = createDouyinControlServer({ controller, port: 0, csrfToken: "test-token" });
  const url = await dashboard.listen();
  t.after(() => dashboard.close());
  const response = await fetch(`${url}/api/action`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: url,
      "x-csrf-token": "test-token",
    },
    body: JSON.stringify({ action: "sendArbitraryText", payload: { text: "private" } }),
  });
  assert.equal(response.status, 400);
  assert.equal(controller.calls.length, 0);
});
