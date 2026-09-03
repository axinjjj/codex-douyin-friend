import test from "node:test";
import assert from "node:assert/strict";
import {
  generateDouyinImageReply,
  generateDouyinReply,
  generateDouyinVideoReply,
} from "../src/douyin-bridge-runtime.mjs";
import { planDouyinIncomingQueue } from "../src/douyin-inbound-planner.mjs";
import { acquireDouyinMedia } from "../src/douyin-media-pipeline.mjs";

const mediaMessage = Object.freeze({
  ordinalFromEnd: 1,
  fingerprint: "a".repeat(64),
  kind: "media",
  side: "left",
});
const acquisitionContext = Object.freeze({
  cdp: { async evaluate() { throw new Error("Unexpected CDP dependency."); } },
  projectRoot: "C:/runtime/project",
  mediaMessage,
  expectedChatFingerprint: "b".repeat(64),
});

test("product contract 1: pure text preserves one existing thread and persona instruction source", async () => {
  let turn;
  const reply = await generateDouyinReply({
    codex: { async runTurn(value) { turn = value; return "fixture reply"; } },
    threadId: "persistent-thread",
    inboundText: "fixture message",
  });
  assert.equal(reply, "fixture reply");
  assert.equal(turn.threadId, "persistent-thread");
  assert.match(turn.text, /全局 AGENTS\.md 人设/u);
});

test("product contract 2: direct chat images use only the direct-image adapter", async () => {
  const result = await acquireDouyinMedia({
    ...acquisitionContext,
    mediaType: "chat_image",
    dependencies: {
      captureChatImage: async () => ({ imagePaths: ["C:/runtime/direct.png"] }),
      readSharedWorkManifest: async () => { throw new Error("Wrong adapter."); },
    },
  });
  assert.equal(result.kind, "chat_image");
  assert.deepEqual(result.imagePaths, ["C:/runtime/direct.png"]);
});

test("product contract 3: shared video evidence and audio understanding enter one media turn", async () => {
  let turn;
  await generateDouyinVideoReply({
    codex: { async runTurn(value) { turn = value; return "fixture reply"; } },
    threadId: "persistent-thread",
    framePaths: ["C:/runtime/frame.png"],
    durationSeconds: 8,
    audioUnderstanding: {
      processed: true,
      transcript: "fixture transcript",
      language: "zh",
      emotions: [],
      events: ["MUSIC"],
    },
  });
  assert.equal(turn.threadId, "persistent-thread");
  assert.deepEqual(turn.input[1], { type: "localImage", path: "C:/runtime/frame.png" });
  assert.match(turn.input[0].text, /fixture transcript/u);
  assert.match(turn.input[0].text, /回应对方分享这条视频的意图/u);
});

test("product contract 4: confirmed one-image and multi-image works never become covers", async () => {
  for (const count of [1, 3]) {
    const sources = Array.from({ length: count }, (_, index) => (
      `https://p3.douyinpic.com/image-${index + 1}`
    ));
    const result = await acquireDouyinMedia({
      ...acquisitionContext,
      mediaType: "shared_aweme",
      dependencies: {
        readSharedWorkManifest: async () => ({
          ok: true,
          mediaType: "image_post",
          sources,
          totalImageCount: count,
        }),
        prepareImagePost: async ({ manifest }) => ({
          kind: manifest.mediaType,
          imagePaths: sources.map((_, index) => `C:/runtime/image-${index + 1}.png`),
        }),
      },
    });
    assert.equal(result.kind, "image_post");
    assert.equal(result.imagePaths.length, count);
  }
});

test("product contract 5: a shared comment remains distinct from its associated work and sender", async () => {
  let turn;
  await generateDouyinImageReply({
    codex: { async runTurn(value) { turn = value; return "fixture reply"; } },
    threadId: "persistent-thread",
    imagePaths: ["C:/runtime/work.png"],
    mediaType: "image_post",
    sharedComment: {
      author: "fixture author",
      text: "fixture comment",
      awemeTitle: "fixture work",
    },
  });
  assert.match(turn.input[0].text, /评论作者/u);
  assert.match(turn.input[0].text, /不要把评论作者误当成聊天对方/u);
  assert.deepEqual(turn.input[1], { type: "localImage", path: "C:/runtime/work.png" });
});

test("product contract 6: text immediately before or after media stays in that media turn", () => {
  const before = { kind: "text", side: "left", fingerprint: "c".repeat(64) };
  const after = { kind: "text", side: "left", fingerprint: "d".repeat(64) };
  for (const messages of [[before, mediaMessage], [mediaMessage, after]]) {
    const plan = planDouyinIncomingQueue(messages);
    assert.equal(plan.ok, true);
    assert.equal(plan.batches.length, 1);
    assert.equal(plan.batches[0].mode, "media");
    assert.equal(plan.batches[0].textMessages.length, 1);
  }
});

test("product contract 7: an optional like decision stays in the media turn and out of the reply", async () => {
  const decision = await generateDouyinImageReply({
    codex: {
      async runTurn({ input }) {
        const nonce = /nonce="([0-9a-f]{24})"/u.exec(input[0].text)?.[1];
        return `fixture reply\n<douyin-media-like nonce="${nonce}">yes</douyin-media-like>`;
      },
    },
    threadId: "persistent-thread",
    imagePaths: ["C:/runtime/direct.png"],
    mediaReactionEnabled: true,
  });
  assert.equal(decision.reply, "fixture reply");
  assert.equal(decision.shouldLike, true);
  assert.doesNotMatch(decision.reply, /douyin-media-like/u);
});
