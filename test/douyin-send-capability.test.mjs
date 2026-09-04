import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGetOrCreateDouyinPageEpochExpression,
  createDouyinSendCapability,
  douyinSendCapabilitiesMatch,
  parseDouyinSendCapability,
  selectDouyinChatTarget,
} from "../src/douyin-send-capability.mjs";

const chatFingerprint = "a".repeat(64);
const pageEpoch = "b".repeat(64);
const target = {
  id: "target-1",
  url: "https://www.douyin.com/chat/fixture-path?view=fixture",
};
const isChatTarget = (candidate) => candidate.url?.startsWith("https://www.douyin.com/chat");

test("binds send authority to one chat, target, page epoch, and query-free page hash", () => {
  const capability = createDouyinSendCapability({ chatFingerprint, target, pageEpoch });
  assert.equal(capability.chatFingerprint, chatFingerprint);
  assert.equal(capability.targetId, "target-1");
  assert.equal(capability.pageEpoch, pageEpoch);
  assert.match(capability.pageUrlHash, /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(JSON.stringify(capability), /fixture-path|view/u);
  assert.equal(douyinSendCapabilitiesMatch(
    capability,
    createDouyinSendCapability({
      chatFingerprint,
      pageEpoch,
      target: { ...target, url: `${target.url}&changed=true` },
    }),
  ), true);
  assert.equal(douyinSendCapabilitiesMatch(
    capability,
    createDouyinSendCapability({ chatFingerprint, target, pageEpoch: "c".repeat(64) }),
  ), false);
  assert.deepEqual(parseDouyinSendCapability(JSON.stringify(capability)), capability);
});

test("requires one exact target and never falls back after capability mismatch", () => {
  const capability = createDouyinSendCapability({ chatFingerprint, target, pageEpoch });
  const extra = { id: "target-2", url: "https://www.douyin.com/chat/other" };
  assert.equal(selectDouyinChatTarget([extra, target], { capability, isChatTarget }), target);
  assert.throws(
    () => selectDouyinChatTarget([extra], { capability, isChatTarget }),
    /unavailable or ambiguous/u,
  );
  assert.throws(
    () => selectDouyinChatTarget([target, extra], { isChatTarget }),
    /Exactly one/u,
  );
});

test("page epoch expression is content-free and hashes only the normalized page URL", () => {
  const expression = buildGetOrCreateDouyinPageEpochExpression();
  assert.match(expression, /crypto\.getRandomValues/u);
  assert.match(expression, /crypto\.subtle\.digest/u);
  assert.match(expression, /location\.pathname/u);
  assert.doesNotMatch(expression, /location\.search|textContent|innerText|document\.cookie/u);
  assert.doesNotThrow(() => new Function(`return ${expression}`));
});
