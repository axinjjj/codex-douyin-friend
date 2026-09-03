import test from "node:test";
import assert from "node:assert/strict";
import {
  acquireDouyinMedia,
  DOUYIN_MEDIA_ADAPTER_REGISTRY,
  DOUYIN_SHARED_MANIFEST_HANDLER_REGISTRY,
  matchDouyinMediaAdapter,
} from "../src/douyin-media-pipeline.mjs";
import { DouyinVideoSourcesExhaustedError } from "../src/douyin-video-runtime.mjs";

const baseContext = Object.freeze({
  cdp: { async evaluate() { throw new Error("Unexpected real CDP read."); } },
  projectRoot: "C:/runtime/project",
  port: 9229,
  mediaMessage: {
    ordinalFromEnd: 1,
    fingerprint: "a".repeat(64),
    kind: "media",
    side: "left",
  },
  expectedChatFingerprint: "b".repeat(64),
});

test("uses a static, non-overlapping media adapter registry", () => {
  assert.equal(Object.isFrozen(DOUYIN_MEDIA_ADAPTER_REGISTRY), true);
  assert.deepEqual(
    DOUYIN_MEDIA_ADAPTER_REGISTRY.map(({ key, mediaTypes }) => ({ key, mediaTypes })),
    [
      { key: "direct-image", mediaTypes: ["chat_image"] },
      { key: "shared-work", mediaTypes: ["shared_aweme"] },
      { key: "comment-share", mediaTypes: ["comment_share"] },
    ],
  );
  assert.deepEqual(
    DOUYIN_SHARED_MANIFEST_HANDLER_REGISTRY.map(({ key, mediaTypes }) => ({ key, mediaTypes })),
    [
      { key: "video", mediaTypes: ["video"] },
      { key: "image-post", mediaTypes: ["image_post"] },
      { key: "cover-only", mediaTypes: ["shared_cover"] },
    ],
  );
  assert.equal(matchDouyinMediaAdapter("chat_image").key, "direct-image");
  assert.equal(matchDouyinMediaAdapter("comment_share").key, "comment-share");
  assert.equal(matchDouyinMediaAdapter("unknown"), null);
  assert.throws(() => matchDouyinMediaAdapter("chat_image", [
    { mediaTypes: ["chat_image"], acquire() {} },
    { mediaTypes: ["chat_image"], acquire() {} },
  ]), /Multiple Douyin media registry entries/u);
});

test("keeps direct chat image acquisition isolated from shared-work dependencies", async () => {
  const calls = [];
  const result = await acquireDouyinMedia({
    ...baseContext,
    mediaType: "chat_image",
    dependencies: {
      captureChatImage: async ({ mediaMessage }) => {
        calls.push(mediaMessage);
        return { jobDirectory: "C:/runtime/image-job", imagePaths: ["C:/runtime/image.png"] };
      },
      readSharedWorkManifest: async () => {
        throw new Error("Shared adapter must not run.");
      },
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(result, {
    kind: "chat_image",
    jobDirectory: "C:/runtime/image-job",
    imagePaths: ["C:/runtime/image.png"],
  });
});

test("routes a complete shared video directly through video preparation", async () => {
  let sourceResult;
  const result = await acquireDouyinMedia({
    ...baseContext,
    mediaType: "shared_aweme",
    analyzeAudio: async () => ({ processed: true }),
    dependencies: {
      readSharedWorkManifest: async () => ({
        ok: true,
        mediaType: "video",
        source: "https://v3-dy.zjcdn.com/video.mp4",
        sources: ["https://v3-dy.zjcdn.com/video.mp4"],
      }),
      prepareVideo: async (options) => {
        sourceResult = options.sourceResult;
        assert.equal(typeof options.analyzeAudio, "function");
        return { jobDirectory: "C:/runtime/video-job", framePaths: ["C:/runtime/frame.png"] };
      },
    },
  });
  assert.equal(sourceResult.mediaType, "video");
  assert.equal(result.kind, "video");
  assert.deepEqual(result.framePaths, ["C:/runtime/frame.png"]);
});

test("routes one or many image-post sources through the image-post adapter", async () => {
  for (const sources of [
    ["https://p3.douyinpic.com/image-1"],
    ["https://p3.douyinpic.com/image-1", "https://p3.douyinpic.com/image-2"],
  ]) {
    let preparedManifest;
    const result = await acquireDouyinMedia({
      ...baseContext,
      mediaType: "shared_aweme",
      dependencies: {
        readSharedWorkManifest: async () => ({
          ok: true,
          mediaType: "image_post",
          sources,
          totalImageCount: sources.length,
        }),
        prepareImagePost: async ({ manifest }) => {
          preparedManifest = manifest;
          return {
            kind: "image_post",
            imagePaths: sources.map((_, index) => `C:/runtime/image-${index + 1}.png`),
          };
        },
      },
    });
    assert.equal(preparedManifest.sources.length, sources.length);
    assert.equal(result.imagePaths.length, sources.length);
  }
});

test("uses muted open-player MSE media without invoking download or cover preparation", async () => {
  const result = await acquireDouyinMedia({
    ...baseContext,
    mediaType: "shared_aweme",
    dependencies: {
      readSharedWorkManifest: async () => ({
        ok: true,
        mediaType: "shared_cover",
        sources: ["https://p3.douyinpic.com/cover"],
        totalImageCount: 1,
      }),
      resolvePlayerFallback: async () => ({
        kind: "media",
        media: {
          kind: "video",
          jobDirectory: "C:/runtime/mse-job",
          framePaths: ["C:/runtime/mse-frame.png"],
          audioReason: "open-player-mse-visual-only",
        },
      }),
      prepareVideo: async () => { throw new Error("MSE media is already prepared."); },
      prepareImagePost: async () => { throw new Error("MSE media must not become a cover."); },
    },
  });
  assert.equal(result.kind, "video");
  assert.equal(result.audioReason, "open-player-mse-visual-only");
});

test("preserves an explicit cover boundary only after the bounded player fallback fails", async () => {
  const initialManifest = {
    ok: true,
    mediaType: "shared_cover",
    sources: ["https://p3.douyinpic.com/cover"],
    totalImageCount: 1,
  };
  let fallbackCalled = false;
  const result = await acquireDouyinMedia({
    ...baseContext,
    mediaType: "comment_share",
    dependencies: {
      readSharedWorkManifest: async () => initialManifest,
      resolvePlayerFallback: async ({ initialManifest: received }) => {
        fallbackCalled = true;
        assert.equal(received, initialManifest);
        return { kind: "manifest", manifest: received };
      },
      prepareImagePost: async ({ manifest }) => ({
        kind: manifest.mediaType,
        imagePaths: ["C:/runtime/cover.png"],
      }),
    },
  });
  assert.equal(fallbackCalled, true);
  assert.equal(result.kind, "shared_cover");
});

test("degrades an undecodable full video to its explicit cover instead of passing black frames", async () => {
  let preparedCover = null;
  const result = await acquireDouyinMedia({
    ...baseContext,
    mediaType: "shared_aweme",
    dependencies: {
      readSharedWorkManifest: async () => ({
        ok: true,
        mediaType: "video",
        source: "https://v3-dy.zjcdn.com/video.mp4",
        sources: ["https://v3-dy.zjcdn.com/video.mp4"],
        coverSources: ["https://p3.douyinpic.com/video-cover"],
      }),
      prepareVideo: async () => {
        throw new DouyinVideoSourcesExhaustedError(["decode-blank-video-frames"]);
      },
      prepareImagePost: async ({ manifest }) => {
        preparedCover = manifest;
        return { kind: manifest.mediaType, imagePaths: ["C:/runtime/video-cover.png"] };
      },
    },
  });
  assert.equal(result.kind, "shared_cover");
  assert.equal(preparedCover.originalMediaType, "video");
  assert.deepEqual(preparedCover.sources, ["https://p3.douyinpic.com/video-cover"]);
});

test("fails closed on an unregistered media type without touching acquisition dependencies", async () => {
  let touched = false;
  await assert.rejects(acquireDouyinMedia({
    ...baseContext,
    mediaType: "unknown",
    dependencies: {
      captureChatImage: async () => { touched = true; },
      readSharedWorkManifest: async () => { touched = true; },
    },
  }), /unsupported/u);
  assert.equal(touched, false);
});
