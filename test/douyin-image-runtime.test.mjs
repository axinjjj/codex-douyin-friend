import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertImageAnalysisJobPath,
  captureLatestDouyinChatImage,
  cleanupStaleImageAnalysisJobs,
  prepareDouyinImagePost,
  removeImageAnalysisJob,
  resolveImageAnalysisRoot,
} from "../src/douyin-image-runtime.mjs";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function temporaryRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "douyin-image-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("captures only a bounded visible chat-image clip into an isolated job", async (t) => {
  const projectRoot = await temporaryRoot(t);
  const calls = [];
  const result = await captureLatestDouyinChatImage({
    projectRoot,
    cdp: {
      async evaluate(expression) {
        assert.match(expression, /chat-image-not-found/u);
        return {
          ok: true,
          clip: { x: 10, y: 20, width: 240, height: 180, scale: 1 },
        };
      },
      async request(method, params, timeoutMs) {
        calls.push({ method, params, timeoutMs });
        return { data: ONE_PIXEL_PNG.toString("base64") };
      },
    },
  });
  assert.equal(result.imagePaths.length, 1);
  assert.equal(result.byteCount, ONE_PIXEL_PNG.length);
  assert.equal(calls[0].method, "Page.captureScreenshot");
  assert.equal(calls[0].params.captureBeyondViewport, false);
  await access(result.imagePaths[0]);
  await removeImageAnalysisJob(projectRoot, result.jobDirectory);
  await assert.rejects(access(result.imagePaths[0]));
});

test("refuses invalid clips, non-PNG captures, and paths outside the job root", async (t) => {
  const projectRoot = await temporaryRoot(t);
  await assert.rejects(captureLatestDouyinChatImage({
    projectRoot,
    cdp: {
      async evaluate() {
        return { ok: true, clip: { x: -1, y: 0, width: 10, height: 10, scale: 1 } };
      },
      async request() {
        throw new Error("must not capture");
      },
    },
  }), /invalid chat-image capture boundary/u);
  await assert.rejects(captureLatestDouyinChatImage({
    projectRoot,
    cdp: {
      async evaluate() {
        return { ok: true, clip: { x: 1, y: 1, width: 40, height: 40, scale: 1 } };
      },
      async request() {
        return { data: Buffer.from("not png").toString("base64") };
      },
    },
  }), /not a valid bounded PNG/u);
  assert.throws(() => assertImageAnalysisJobPath(projectRoot, projectRoot), /outside/u);
});

test("stale cleanup removes only UUID job directories", async (t) => {
  const projectRoot = await temporaryRoot(t);
  const root = resolveImageAnalysisRoot(projectRoot);
  const staleJob = path.join(root, randomUUID());
  const unrelated = path.join(root, "keep-me");
  await mkdir(staleJob, { recursive: true });
  await mkdir(unrelated, { recursive: true });
  assert.equal(await cleanupStaleImageAnalysisJobs(projectRoot, {
    minimumAgeMs: 0,
    now: Date.now() + 1_000,
  }), 1);
  await assert.rejects(access(staleJob));
  await access(unrelated);
});

test("downloads an ordered image-post sample from trusted Douyin media hosts", async (t) => {
  const projectRoot = await temporaryRoot(t);
  const requested = [];
  const result = await prepareDouyinImagePost({
    projectRoot,
    manifest: {
      ok: true,
      mediaType: "image_post",
      sources: [
        "https://p3.douyinpic.com/first",
        "https://p6.byteimg.com/second",
      ],
      totalImageCount: 5,
      sampled: true,
    },
    async fetchFn(url, options) {
      requested.push({ url, options });
      return new Response(ONE_PIXEL_PNG, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    },
  });
  assert.equal(result.kind, "image_post");
  assert.equal(result.totalImageCount, 5);
  assert.equal(result.sampled, true);
  assert.deepEqual(result.imagePaths.map((value) => path.extname(value)), [".png", ".png"]);
  assert.deepEqual(requested.map((value) => value.url), [
    "https://p3.douyinpic.com/first",
    "https://p6.byteimg.com/second",
  ]);
  assert.equal(requested[0].options.redirect, "error");
  for (const imagePath of result.imagePaths) await access(imagePath);
  await removeImageAnalysisJob(projectRoot, result.jobDirectory);
});

test("refuses image-post downloads from an untrusted host", async (t) => {
  const projectRoot = await temporaryRoot(t);
  await assert.rejects(prepareDouyinImagePost({
    projectRoot,
    manifest: {
      ok: true,
      mediaType: "image_post",
      sources: ["https://example.com/private.png"],
      totalImageCount: 1,
      sampled: false,
    },
    async fetchFn() {
      throw new Error("must not fetch");
    },
  }), /untrusted Douyin image URL/u);
});
