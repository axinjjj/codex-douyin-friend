import test from "node:test";
import assert from "node:assert/strict";
import {
  bindIncomingDouyinMediaQuote,
  cancelBoundDouyinMediaQuote,
  cleanupRecoveredDouyinMediaQuote,
  shouldQuoteDouyinMediaReply,
} from "../src/douyin-message-quote.mjs";

const message = {
  ordinalFromEnd: 2,
  fingerprint: "a".repeat(64),
  kind: "media",
  side: "left",
};
const chatFingerprint = "b".repeat(64);
const quoteNonce = "c".repeat(24);
const quoteTargetFingerprint = "d".repeat(64);
const expectedText = "quoted reply";

test("quotes only fully acquired native shared-video replies", () => {
  assert.equal(shouldQuoteDouyinMediaReply({
    replyKind: "video",
    mediaType: "shared_aweme",
    quoteTargetFingerprint,
  }), true);
  for (const candidate of [
    { replyKind: "image", mediaType: "shared_aweme", quoteTargetFingerprint },
    { replyKind: "video", mediaType: "comment_share", quoteTargetFingerprint },
    { replyKind: "image", mediaType: "chat_image" },
    { replyKind: "video", mediaType: "shared_aweme", quoteTargetFingerprint: null },
  ]) {
    assert.equal(shouldQuoteDouyinMediaReply(candidate), false);
  }
});

test("binds one exact shared-work reply action without pressing Enter", async () => {
  const requests = [];
  let activated = false;
  const result = await bindIncomingDouyinMediaQuote({
    cdp: {
      async evaluate(expression) {
        if (expression.includes("state: 'armed'")) {
          return { ok: true, state: "armed", resumed: false };
        }
        if (expression.includes("incoming-media-reaction-target-changed")) {
          return { ok: true, chatFingerprint, point: { x: 120, y: 240 } };
        }
        if (expression.includes("media-reply-action-unavailable-or-ambiguous")) {
          if (expression.includes("button.click()")) {
            activated = true;
            return { ok: true, activated: true };
          }
          return { ok: true, activated: false };
        }
        if (expression.includes("media-quote-binding-identity-changed")) return { ok: true };
        throw new Error("unexpected expression");
      },
      async request(method, params) {
        requests.push({ method, params });
      },
    },
    message,
    expectedChatFingerprint: chatFingerprint,
    quoteNonce,
    quoteTargetFingerprint,
    expectedText,
    sleepFn: async () => {},
  });
  assert.deepEqual(result, {
    ok: true,
    nonce: quoteNonce,
    resumed: false,
    draftPresent: false,
  });
  assert.equal(activated, true);
  assert.equal(requests.filter(({ method }) => method === "Input.dispatchMouseEvent").length, 2);
  assert.equal(requests.some(({ params }) => params?.key === "Enter"), false);
});

test("resumes only the deterministic quote binding owned by the same action", async () => {
  let evaluationCount = 0;
  let requestCount = 0;
  const result = await bindIncomingDouyinMediaQuote({
    cdp: {
      async evaluate(expression) {
        evaluationCount += 1;
        assert.match(expression, new RegExp(quoteNonce, "u"));
        assert.match(expression, /expectedText/u);
        return { ok: true, state: "bound", resumed: true, draftPresent: true };
      },
      async request() {
        requestCount += 1;
      },
    },
    message,
    expectedChatFingerprint: chatFingerprint,
    quoteNonce,
    quoteTargetFingerprint,
    expectedText,
    sleepFn: async () => {},
  });
  assert.deepEqual(result, {
    ok: true,
    nonce: quoteNonce,
    resumed: true,
    draftPresent: true,
  });
  assert.equal(evaluationCount, 1);
  assert.equal(requestCount, 0);
});

test("does not activate an ambiguous reply menu and attempts bounded cleanup", async () => {
  let activated = false;
  let cleanupAttempted = false;
  await assert.rejects(bindIncomingDouyinMediaQuote({
    cdp: {
      async evaluate(expression) {
        if (expression.includes("state: 'armed'")) {
          return { ok: true, state: "armed", resumed: false };
        }
        if (expression.includes("incoming-media-reaction-target-changed")) {
          return { ok: true, chatFingerprint, point: { x: 120, y: 240 } };
        }
        if (expression.includes("media-reply-action-unavailable-or-ambiguous")) {
          if (expression.includes("button.click()")) activated = true;
          return { ok: false, reason: "media-reply-action-unavailable-or-ambiguous" };
        }
        if (expression.includes("media-quote-cancel-authority-lost")) {
          cleanupAttempted = true;
          return { ok: true, point: { x: 10, y: 10 }, armedOnly: true };
        }
        if (expression.includes("media-quote-cleanup-unverified")) {
          return { ok: true };
        }
        throw new Error("unexpected expression");
      },
      async request() {},
    },
    message,
    expectedChatFingerprint: chatFingerprint,
    quoteNonce,
    quoteTargetFingerprint,
    expectedText,
    sleepFn: async () => {},
  }), /reply action is unavailable/u);
  assert.equal(activated, false);
  assert.equal(cleanupAttempted, true);
});

test("never cleans or replaces a pre-existing user quote draft", async () => {
  let evaluationCount = 0;
  let requestCount = 0;
  await assert.rejects(bindIncomingDouyinMediaQuote({
    cdp: {
      async evaluate(expression) {
        evaluationCount += 1;
        assert.match(expression, /quote-draft-already-present/u);
        return { ok: false, reason: "quote-draft-already-present" };
      },
      async request() {
        requestCount += 1;
      },
    },
    message,
    expectedChatFingerprint: chatFingerprint,
    quoteNonce,
    quoteTargetFingerprint,
    expectedText,
    sleepFn: async () => {},
  }), /quote editor is unavailable/u);
  assert.equal(evaluationCount, 1);
  assert.equal(requestCount, 0);
});

test("cancels an owned quote through the exact SVG control point and verifies cleanup", async () => {
  const requests = [];
  let evaluationCount = 0;
  const result = await cancelBoundDouyinMediaQuote({
    cdp: {
      async evaluate() {
        evaluationCount += 1;
        return evaluationCount === 1
          ? { ok: true, point: { x: 320, y: 640 } }
          : { ok: true };
      },
      async request(method, params) {
        requests.push({ method, params });
      },
    },
    expectedChatFingerprint: chatFingerprint,
    quoteNonce,
    quoteTargetFingerprint,
    sleepFn: async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].params.button, "left");
  assert.equal(requests[0].params.x, 320);
  assert.equal(requests[0].params.y, 640);
});

test("releases a recovered quote binding without touching an unrelated editor", async () => {
  let evaluationCount = 0;
  let requestCount = 0;
  const result = await cleanupRecoveredDouyinMediaQuote({
    cdp: {
      async evaluate(expression) {
        evaluationCount += 1;
        assert.match(expression, /alreadyReleased/u);
        return { ok: true, alreadyReleased: true };
      },
      async request() {
        requestCount += 1;
      },
    },
    expectedChatFingerprint: chatFingerprint,
    quoteNonce,
    quoteTargetFingerprint,
  });
  assert.equal(result.alreadyReleased, true);
  assert.equal(evaluationCount, 1);
  assert.equal(requestCount, 0);
});

test("closes the exact recovered quote preview when Enter already succeeded", async () => {
  const requests = [];
  let evaluationCount = 0;
  const result = await cleanupRecoveredDouyinMediaQuote({
    cdp: {
      async evaluate(expression) {
        evaluationCount += 1;
        if (expression.includes("alreadyReleased")) {
          return { ok: false, reason: "media-quote-send-cleanup-unverified" };
        }
        if (expression.includes("media-quote-cancel-authority-lost")) {
          assert.match(expression, /binding\.preview !== previews\[0\]/u);
          return { ok: true, point: { x: 15, y: 25 } };
        }
        if (expression.includes("media-quote-cleanup-unverified")) return { ok: true };
        throw new Error("unexpected expression");
      },
      async request(method, params) {
        requests.push({ method, params });
      },
    },
    expectedChatFingerprint: chatFingerprint,
    quoteNonce,
    quoteTargetFingerprint,
    sleepFn: async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(evaluationCount, 3);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].params.button, "left");
});

test("never touches an unowned visible quote during recovered cleanup", async () => {
  let requestCount = 0;
  await assert.rejects(() => cleanupRecoveredDouyinMediaQuote({
    cdp: {
      async evaluate() {
        return { ok: false, reason: "media-quote-unowned-preview-present" };
      },
      async request() {
        requestCount += 1;
      },
    },
    expectedChatFingerprint: chatFingerprint,
    quoteNonce,
    quoteTargetFingerprint,
  }), /unowned-preview-present/u);
  assert.equal(requestCount, 0);
});

test("never adopts a replacement preview during recovered cleanup", async () => {
  let evaluationCount = 0;
  let requestCount = 0;
  await assert.rejects(() => cleanupRecoveredDouyinMediaQuote({
    cdp: {
      async evaluate(expression) {
        evaluationCount += 1;
        if (expression.includes("alreadyReleased")) {
          return { ok: false, reason: "media-quote-send-cleanup-unverified" };
        }
        assert.match(expression, /binding\.preview !== previews\[0\]/u);
        return { ok: false, reason: "media-quote-cancel-authority-lost" };
      },
      async request() {
        requestCount += 1;
      },
    },
    expectedChatFingerprint: chatFingerprint,
    quoteNonce,
    quoteTargetFingerprint,
  }), /could not be cancelled/u);
  assert.equal(evaluationCount, 2);
  assert.equal(requestCount, 0);
});
