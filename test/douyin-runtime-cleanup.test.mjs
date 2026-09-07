import test from "node:test";
import assert from "node:assert/strict";
import { runDouyinCleanupSteps } from "../src/douyin-runtime-cleanup.mjs";

test("runs every cleanup step in order even when earlier resources fail", async () => {
  const calls = [];
  await assert.rejects(() => runDouyinCleanupSteps([
    async () => {
      calls.push("media");
      throw new Error("media cleanup failed");
    },
    async () => calls.push("codex"),
    () => calls.push("cdp"),
    async () => calls.push("lock"),
  ]), /media cleanup failed/u);
  assert.deepEqual(calls, ["media", "codex", "cdp", "lock"]);
});

test("reports multiple cleanup failures only after all resources were attempted", async () => {
  const calls = [];
  await assert.rejects(() => runDouyinCleanupSteps([
    () => {
      calls.push("first");
      throw new Error("first failure");
    },
    () => {
      calls.push("second");
      throw new Error("second failure");
    },
    () => calls.push("last"),
  ]), AggregateError);
  assert.deepEqual(calls, ["first", "second", "last"]);
});
