import test from "node:test";
import assert from "node:assert/strict";
import { replaceChatEditorText } from "../src/douyin-editor-control.mjs";

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
