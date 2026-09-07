import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("latest-message diagnostics have no outbound send path and share the run lock", async () => {
  for (const scriptName of [
    "reply-latest-douyin-message.mjs",
    "reply-latest-douyin-video.mjs",
  ]) {
    const source = await readFile(path.join(projectRoot, "scripts", scriptName), "utf8");
    assert.doesNotMatch(source, /DOUYIN_SEND_ENABLED|sendAndVerifyDouyinReply|Input\.dispatchKeyEvent/u);
    assert.match(source, /acquireBridgeRunLock/u);
    assert.match(source, /reply-generated-not-sent/u);
  }
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  assert.equal(Object.hasOwn(packageJson.scripts, "reply-latest:douyin-chat"), false);
  assert.equal(Object.hasOwn(packageJson.scripts, "reply-latest:douyin-video"), false);
  assert.match(packageJson.scripts["diagnose:douyin-chat"], /reply-latest-douyin-message/u);
  assert.match(packageJson.scripts["diagnose:douyin-video"], /reply-latest-douyin-video/u);
});
