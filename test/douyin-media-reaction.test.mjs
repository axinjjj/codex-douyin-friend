import test from "node:test";
import assert from "node:assert/strict";
import { likeIncomingDouyinMediaMessage } from "../src/douyin-media-reaction.mjs";

const message = {
  ordinalFromEnd: 1,
  fingerprint: "a".repeat(64),
  kind: "media",
  side: "left",
};
const chatFingerprint = "b".repeat(64);

test("likes one exact incoming media message and verifies the menu action disappeared", async () => {
  const requests = [];
  let inspectCount = 0;
  const result = await likeIncomingDouyinMediaMessage({
    cdp: {
      async evaluate(expression) {
        if (expression.includes("incoming-media-reaction-target-changed")) {
          return { ok: true, chatFingerprint, point: { x: 120, y: 240 } };
        }
        if (expression.includes(".click()")) {
          return { ok: true, available: true, activated: true };
        }
        inspectCount += 1;
        return {
          ok: true,
          available: inspectCount === 1,
          activated: false,
        };
      },
      async request(method, params) {
        requests.push({ method, params });
      },
    },
    message,
    expectedChatFingerprint: chatFingerprint,
    sleepFn: async () => {},
  });
  assert.deepEqual(result, { ok: true, applied: true, reason: null });
  assert.equal(requests.filter((entry) => entry.method === "Input.dispatchMouseEvent").length, 4);
  assert.ok(requests.filter((entry) => entry.method === "Input.dispatchKeyEvent").length >= 4);
  assert.equal(requests.find((entry) => entry.method === "Input.dispatchMouseEvent").params.button, "right");
});

test("does not click when the exact media menu has no available like action", async () => {
  let activationAttempted = false;
  const result = await likeIncomingDouyinMediaMessage({
    cdp: {
      async evaluate(expression) {
        if (expression.includes("incoming-media-reaction-target-changed")) {
          return { ok: true, chatFingerprint, point: { x: 120, y: 240 } };
        }
        if (expression.includes(".click()")) activationAttempted = true;
        return { ok: true, available: false, activated: false };
      },
      async request() {},
    },
    message,
    expectedChatFingerprint: chatFingerprint,
    sleepFn: async () => {},
  });
  assert.deepEqual(result, {
    ok: true,
    applied: false,
    reason: "like-unavailable-or-already-applied",
  });
  assert.equal(activationAttempted, false);
});

test("refuses a media reaction after the active chat identity changes", async () => {
  let mouseRequested = false;
  await assert.rejects(likeIncomingDouyinMediaMessage({
    cdp: {
      async evaluate() {
        return { ok: true, chatFingerprint: "c".repeat(64), point: { x: 120, y: 240 } };
      },
      async request(method) {
        if (method === "Input.dispatchMouseEvent") mouseRequested = true;
      },
    },
    message,
    expectedChatFingerprint: chatFingerprint,
    sleepFn: async () => {},
  }), /chat changed/u);
  assert.equal(mouseRequested, false);
});
