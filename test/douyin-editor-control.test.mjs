import test from "node:test";
import assert from "node:assert/strict";
import { replaceChatEditorText, verifyChatEditorReady } from "../src/douyin-editor-control.mjs";

test("uses CDP native text insertion and returns only comparison metadata", async () => {
  const calls = [];
  const expressions = [];
  let evaluateCount = 0;
  const client = {
    async evaluate(expression) {
      expressions.push(expression);
      evaluateCount += 1;
      return evaluateCount === 1
        ? { ok: true }
        : { ok: true, actualLength: 5, expectedLength: 5 };
    },
    async request(method, params) {
      calls.push({ method, params });
      return {};
    },
  };

  const result = await replaceChatEditorText(client, "hello");
  assert.equal(result.ok, true);
  assert.equal(calls.at(-1).method, "Input.insertText");
  assert.equal(calls.at(-1).params.text, "hello");
  assert.equal(calls.some(({ params }) => params?.key === "Backspace"), false);
  assert.match(expressions[0], /innerWidth <= 100/u);
  assert.match(expressions[0], /visibilityState === 'hidden'/u);
  assert.match(expressions[0], /rect\.width > 0 \|\| minimizedViewport/u);
});

test("does not replace a pre-existing editor draft", async () => {
  let requestCount = 0;
  const result = await replaceChatEditorText({
    async evaluate() {
      return { ok: false, reason: "chat-input-not-empty" };
    },
    async request() {
      requestCount += 1;
    },
  }, "bridge reply");
  assert.deepEqual(result, { ok: false, reason: "chat-input-not-empty" });
  assert.equal(requestCount, 0);
});

test("builds one atomic chat and editor authority preflight", async () => {
  let expression = "";
  const result = await verifyChatEditorReady({
    async evaluate(value) {
      expression = value;
      return { ok: true, actualLength: 5, expectedLength: 5 };
    },
  }, {
    expectedText: "hello",
    expectedChatFingerprint: "a".repeat(64),
  });
  assert.equal(result.ok, true);
  assert.match(expression, /crypto\.subtle\.digest\('SHA-256'/u);
  assert.match(expression, /visibleEditors\.length !== 1/u);
  assert.match(expression, /innerWidth <= 100/u);
  assert.match(expression, /rectangle\.width > 0 \|\| minimizedViewport/u);
  assert.match(expression, /document\.activeElement !== editor/u);
  assert.match(expression, /ownsInsertedText = actual === expected/u);
  assert.match(expression, /canClear: ownsInsertedText/u);
  assert.match(expression, /aria-disabled/u);
  assert.match(expression, /unexpected-quote-draft/u);
  assert.doesNotMatch(expression, /private chat/u);
});

test("binds the exact media quote into the atomic editor preflight", async () => {
  let expression = "";
  const result = await verifyChatEditorReady({
    async evaluate(value) {
      expression = value;
      return { ok: true, actualLength: 5, expectedLength: 5 };
    },
  }, {
    expectedText: "hello",
    expectedChatFingerprint: "a".repeat(64),
    quoteBinding: {
      nonce: "b".repeat(24),
      quoteTargetFingerprint: "d".repeat(64),
      message: {
        ordinalFromEnd: 2,
        fingerprint: "c".repeat(64),
        kind: "media",
        side: "left",
      },
    },
  });
  assert.equal(result.ok, true);
  assert.match(expression, /incoming-media-identity-changed/u);
  assert.match(expression, /MessageItemShareAwemecontainer/u);
  assert.match(expression, /quoteBinding\.message !== message/u);
  assert.match(expression, /quoteBinding\.preview !== quotePreviews\[0\]/u);
  assert.match(expression, /quoteBinding\.editor !== editor/u);
  assert.match(expression, /quoteBinding\.inputColumn\?\.contains\(quotePreviews\[0\]\)/u);
  assert.match(expression, /quotePreviewTargetFingerprint/u);
  assert.match(expression, /media-quote-binding-lost/u);
  assert.doesNotThrow(() => new Function(`return ${expression}`));
});
