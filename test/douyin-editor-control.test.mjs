import test from "node:test";
import assert from "node:assert/strict";
import { replaceChatEditorText, verifyChatEditorReady } from "../src/douyin-editor-control.mjs";

test("uses CDP native text insertion and returns only comparison metadata", async () => {
  const calls = [];
  let evaluateCount = 0;
  const client = {
    async evaluate() {
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
  assert.match(expression, /document\.activeElement !== editor/u);
  assert.match(expression, /ownsInsertedText = actual === expected/u);
  assert.match(expression, /canClear: ownsInsertedText/u);
  assert.match(expression, /aria-disabled/u);
  assert.doesNotMatch(expression, /private chat/u);
});
