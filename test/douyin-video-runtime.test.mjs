import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  assertCapturedVideoFrame,
  assertUsableVideoFrameVisuals,
  assertVideoAnalysisJobPath,
  buildCaptureFrameExpression,
  buildExtractAudioExpression,
  buildScanFrameSignaturesExpression,
  cleanupStaleVideoAnalysisJobs,
  DouyinVideoDecodeError,
  DouyinVideoSourcesExhaustedError,
  downloadCompatibleDouyinVideo,
  downloadDouyinVideo,
  isTrustedDouyinMediaUrl,
  prepareLatestDouyinVideoMedia,
  removeVideoAnalysisJob,
  resolveVideoAnalysisRoot,
} from "../src/douyin-video-runtime.mjs";
import {
  DouyinMediaEvidenceError,
  DOUYIN_MEDIA_ERROR_CODES,
} from "../src/douyin-media-evidence.mjs";

function canvasPngFixture(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function createRequestFn(responseFactory, inspectOptions = () => {}) {
  return (source, options, callback) => {
    inspectOptions(options);
    const request = new EventEmitter();
    request.destroy = (error) => {
      if (error) queueMicrotask(() => request.emit("error", error));
    };
    queueMicrotask(() => callback(responseFactory(source, options)));
    return request;
  };
}

test("allows only known HTTPS Douyin media hosts", () => {
  assert.equal(isTrustedDouyinMediaUrl("https://v5-dy.zjcdn.com/video.mp4"), true);
  assert.equal(isTrustedDouyinMediaUrl("https://api-play.amemv.com/aweme/v1/play/"), true);
  assert.equal(isTrustedDouyinMediaUrl("http://v5-dy.zjcdn.com/video.mp4"), false);
  assert.equal(isTrustedDouyinMediaUrl("https://api-play.amemv.com.attacker.invalid/video.mp4"), false);
  assert.equal(isTrustedDouyinMediaUrl("https://zjcdn.com.attacker.invalid/video.mp4"), false);
  assert.equal(isTrustedDouyinMediaUrl("file:///C:/private/video.mp4"), false);
});

test("cleans only stale UUID video jobs and leaves recent or unrelated directories", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-douyin-video-cleanup-"));
  const analysisRoot = resolveVideoAnalysisRoot(projectRoot);
  const oldJob = path.join(analysisRoot, "123e4567-e89b-42d3-a456-426614174000");
  const recentJob = path.join(analysisRoot, "123e4567-e89b-42d3-a456-426614174001");
  const unrelatedDirectory = path.join(analysisRoot, "keep-me");
  const now = Date.now();
  try {
    for (const directory of [oldJob, recentJob, unrelatedDirectory]) {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "artifact.bin"), "fixture");
    }
    await utimes(oldJob, new Date(now - 3 * 60 * 60 * 1_000), new Date(now - 3 * 60 * 60 * 1_000));
    await utimes(recentJob, new Date(now - 10 * 60 * 1_000), new Date(now - 10 * 60 * 1_000));

    const removedCount = await cleanupStaleVideoAnalysisJobs(projectRoot, { now });
    assert.equal(removedCount, 1);
    await assert.rejects(access(oldJob));
    await access(recentJob);
    await access(unrelatedDirectory);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("builds a bounded local-only Web Audio extraction expression", () => {
  const expression = buildExtractAudioExpression({
    uploadPath: "/audio-token.wav",
    maxAudioBytes: 1024 * 1024,
    maxDurationSeconds: 30,
  });
  assert.match(expression, /OfflineAudioContext/u);
  assert.match(expression, /targetRate = 16000/u);
  assert.match(expression, /audio-duration-limit/u);
  assert.match(expression, /\/audio-token\.wav/u);
  assert.match(expression, /1048576/u);
  assert.doesNotMatch(expression, /https?:\/\//u);

  const callerCannotRaiseLimits = buildExtractAudioExpression({
    uploadPath: "/audio-token.wav",
    maxAudioBytes: 500 * 1024 * 1024,
    maxDurationSeconds: 10_000,
  });
  assert.match(callerCannotRaiseLimits, /41943040/u);
  assert.match(callerCannotRaiseLimits, /video\.duration > 900 \+ 0\.25/u);
  assert.doesNotMatch(callerCannotRaiseLimits, /524288000|10000/u);
});

test("builds sequential in-memory scene scanning and bounded final capture expressions", () => {
  const scanExpression = buildScanFrameSignaturesExpression(
    Array.from({ length: 100 }, (_, index) => index),
    { maxWallTimeMs: 90_000 },
  );
  assert.match(scanExpression, /willReadFrequently/u);
  assert.match(scanExpression, /performance\.now\(\) >= interiorDeadline/u);
  assert.doesNotMatch(scanExpression, /toDataURL|fetch\(['"]https?:/u);
  assert.match(scanExpression, /performance\.now\(\) \+ 45000/u);
  assert.match(scanExpression, /boundary-scan-failed/u);
  assert.match(scanExpression, /requestVideoFrameCallback/u);
  assert.match(scanExpression, /video\.videoWidth < 2/u);
  assert.match(scanExpression, /maxLuminance/u);
  assert.match(scanExpression, /ending = await capture\(requestedTimes\.at\(-1\)\)/u);
  const requestedTimes = JSON.parse(/const requestedTimes = (\[[^;]+\]);/u.exec(scanExpression)[1]);
  assert.equal(requestedTimes.length, 72);

  const captureExpression = buildCaptureFrameExpression(5, 2_048);
  assert.match(captureExpression, /768 \/ video\.videoWidth/u);
  assert.match(captureExpression, /768 \/ video\.videoHeight/u);
  assert.match(captureExpression, /toDataURL\('image\/png'\)/u);
  assert.match(captureExpression, /requestVideoFrameCallback/u);
  assert.match(captureExpression, /nonBlackRatio/u);
  const modalCapture = buildCaptureFrameExpression(5, 768, 2_500, {
    videoSelector: ".commonModalFullScreenModalFullScreen video",
  });
  assert.match(modalCapture, /commonModalFullScreenModalFullScreen video/u);
});

test("distinguishes decoded black scenes from dimensionless video artifacts", () => {
  const black = {
    visual: {
      pixelCount: 160,
      meanLuminance: 0,
      maxLuminance: 0,
      nonBlackRatio: 0,
    },
  };
  const visible = {
    visual: {
      pixelCount: 160,
      meanLuminance: 42,
      maxLuminance: 180,
      nonBlackRatio: 0.75,
    },
  };
  assert.deepEqual(assertUsableVideoFrameVisuals([black, black]), {
    blankFrameCount: 2,
    usableFrameCount: 0,
    decodedFrameCount: 2,
    visualMode: "decoded-black",
    diagnosticReason: "blank-video-frames",
  });
  assert.deepEqual(assertUsableVideoFrameVisuals([black, visible]), {
    blankFrameCount: 1,
    usableFrameCount: 1,
    decodedFrameCount: 2,
    visualMode: "decoded-visible",
    diagnosticReason: null,
  });
  assert.throws(
    () => assertCapturedVideoFrame({ width: 1, height: 1, visual: visible.visual }, canvasPngFixture(1, 1)),
    (error) => error instanceof DouyinVideoDecodeError,
  );
  assert.doesNotThrow(() => assertCapturedVideoFrame(
    { width: 64, height: 64, visual: { ...visible.visual, pixelCount: 64 * 64 } },
    canvasPngFixture(64, 64),
  ));
});

test("caller options cannot raise the 100 MB Douyin download ceiling", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-douyin-video-limit-"));
  try {
    await assert.rejects(downloadDouyinVideo({
      source: "https://v5-dy.zjcdn.com/video.mp4",
      destination: path.join(projectRoot, "video.mp4"),
      maxBytes: 500 * 1024 * 1024,
      requestFn: createRequestFn(() => Object.assign(Readable.from([]), {
        statusCode: 206,
        headers: {
          "content-type": "video/mp4",
          "content-range": `bytes 0-0/${101 * 1024 * 1024}`,
        },
      })),
    }), /exceeds the local size limit/u);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("video download timeout measures inactivity instead of total transfer time", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-douyin-video-stream-"));
  const destination = path.join(projectRoot, "video.mp4");
  try {
    const requestFn = createRequestFn(
      (_source, options) => options.headers.Range === "bytes=0-0"
        ? Object.assign(Readable.from([Buffer.from([1])]), {
          statusCode: 206,
          headers: { "content-type": "video/mp4", "content-range": "bytes 0-0/3" },
        })
        : Object.assign(Readable.from((async function* streamChunks() {
          for (let chunk = 1; chunk <= 3; chunk += 1) {
            await new Promise((resolve) => setTimeout(resolve, 400));
            yield Buffer.from([chunk]);
          }
        }())), {
          statusCode: 206,
          headers: { "content-type": "video/mp4", "content-range": "bytes 0-2/3" },
        }),
      (options) => {
        assert.equal(options.headers["Accept-Encoding"], "identity");
        assert.equal(options.timeout, 1_000);
      },
    );
    const result = await downloadDouyinVideo({
      source: "https://v5-dy.zjcdn.com/video.mp4",
      destination,
      timeoutMs: 1_000,
      requestFn,
    });
    assert.equal(result.byteCount, 3);
    assert.deepEqual(await readFile(destination), Buffer.from([1, 2, 3]));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("video download follows only bounded trusted redirects", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-douyin-video-redirect-"));
  const destination = path.join(projectRoot, "video.mp4");
  const requests = [];
  try {
    const result = await downloadDouyinVideo({
      source: "https://api-play.amemv.com/aweme/v1/play/",
      destination,
      requestFn: createRequestFn((source) => {
        requests.push(source);
        if (requests.length === 1) {
          return Object.assign(Readable.from([]), {
            statusCode: 302,
            headers: { location: "https://v5-dy.zjcdn.com/fresh-video.mp4" },
          });
        }
        if (requests.length === 2) {
          return Object.assign(Readable.from([Buffer.from([1])]), {
            statusCode: 206,
            headers: { "content-type": "video/mp4", "content-range": "bytes 0-0/3" },
          });
        }
        return Object.assign(Readable.from([Buffer.from([1, 2, 3])]), {
          statusCode: 206,
          headers: { "content-type": "video/mp4", "content-range": "bytes 0-2/3" },
        });
      }),
    });
    assert.equal(requests.length, 3);
    assert.equal(result.byteCount, 3);
    assert.deepEqual(await readFile(destination), Buffer.from([1, 2, 3]));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("video download retries an incomplete range without writing duplicate bytes", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-douyin-video-range-retry-"));
  const destination = path.join(projectRoot, "video.mp4");
  let requestCount = 0;
  try {
    const result = await downloadDouyinVideo({
      source: "https://v5-dy.zjcdn.com/video.mp4",
      destination,
      requestFn: createRequestFn((_source, options) => {
        requestCount += 1;
        if (options.headers.Range === "bytes=0-0") {
          return Object.assign(Readable.from([Buffer.from([1])]), {
            statusCode: 206,
            headers: { "content-type": "video/mp4", "content-range": "bytes 0-0/3" },
          });
        }
        const bytes = requestCount === 2 ? Buffer.from([1]) : Buffer.from([1, 2, 3]);
        return Object.assign(Readable.from([bytes]), {
          statusCode: 206,
          headers: { "content-type": "video/mp4", "content-range": "bytes 0-2/3" },
        });
      }),
    });
    assert.equal(requestCount, 3);
    assert.equal(result.byteCount, 3);
    assert.deepEqual(await readFile(destination), Buffer.from([1, 2, 3]));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("video download fetches at most three verified ranges concurrently and writes them in order", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-douyin-video-concurrent-"));
  const destination = path.join(projectRoot, "video.mp4");
  const chunkBytes = 1024 * 1024;
  const totalBytes = (chunkBytes * 3) + 7;
  let activeRanges = 0;
  let peakActiveRanges = 0;
  try {
    const result = await downloadDouyinVideo({
      source: "https://v5-dy.zjcdn.com/video.mp4",
      destination,
      requestFn: createRequestFn((_source, options) => {
        if (options.headers.Range === "bytes=0-0") {
          return Object.assign(Readable.from([Buffer.from([1])]), {
            statusCode: 206,
            headers: { "content-type": "video/mp4", "content-range": `bytes 0-0/${totalBytes}` },
          });
        }
        const [, startText, endText] = /^bytes=(\d+)-(\d+)$/u.exec(options.headers.Range);
        const start = Number(startText);
        const end = Number(endText);
        const fill = Math.floor(start / chunkBytes) + 1;
        return Object.assign(Readable.from((async function* streamRange() {
          activeRanges += 1;
          peakActiveRanges = Math.max(peakActiveRanges, activeRanges);
          try {
            await new Promise((resolve) => setTimeout(resolve, 10));
            yield Buffer.alloc(end - start + 1, fill);
          } finally {
            activeRanges -= 1;
          }
        }())), {
          statusCode: 206,
          headers: { "content-type": "video/mp4", "content-range": `bytes ${start}-${end}/${totalBytes}` },
        });
      }),
    });
    const bytes = await readFile(destination);
    assert.equal(result.byteCount, totalBytes);
    assert.equal(peakActiveRanges, 3);
    assert.equal(bytes[0], 1);
    assert.equal(bytes[chunkBytes], 2);
    assert.equal(bytes[chunkBytes * 2], 3);
    assert.equal(bytes[chunkBytes * 3], 4);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("video download failure diagnostics stay content-free", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-douyin-video-failure-"));
  const destination = path.join(projectRoot, "video.mp4");
  try {
    await assert.rejects(downloadDouyinVideo({
      source: "https://v5-dy.zjcdn.com/private-media-name.mp4",
      destination,
      requestFn: createRequestFn((_source, options) => options.headers.Range === "bytes=0-0"
        ? Object.assign(Readable.from([Buffer.from([1])]), {
          statusCode: 206,
          headers: { "content-type": "video/mp4", "content-range": "bytes 0-0/3" },
        })
        : Object.assign(Readable.from([Buffer.from([1])]), {
          statusCode: 206,
          headers: { "content-type": "video/mp4", "content-range": "bytes 0-2/3" },
        })),
    }), (error) => {
      assert.match(error.message, /range 1\/1 failed after bounded retries \(incomplete-range\)/u);
      assert.doesNotMatch(error.message, /private-media-name|zjcdn/u);
      return true;
    });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("tries bounded trusted video source candidates in order", async () => {
  const calls = [];
  const result = await downloadCompatibleDouyinVideo({
    sourceResult: {
      source: "https://v1-dy.zjcdn.com/first.mp4",
      sources: [
        "https://v1-dy.zjcdn.com/first.mp4",
        "https://example.com/untrusted.mp4",
        "https://api-play.amemv.com/aweme/v1/play/",
        "https://v2-dy.zjcdn.com/second.mp4",
        "https://v2-dy.zjcdn.com/second.mp4",
      ],
    },
    destination: path.resolve("C:/bounded/video.mp4"),
    async downloadFn(options) {
      calls.push(options);
      if (calls.length === 1) throw new Error("candidate failed");
      return { byteCount: 123, contentType: "video/mp4" };
    },
  });
  assert.deepEqual(result, { byteCount: 123, contentType: "video/mp4" });
  assert.deepEqual(calls.map((call) => ({ source: call.source, timeoutMs: call.timeoutMs })), [
    { source: "https://api-play.amemv.com/aweme/v1/play/", timeoutMs: 30_000 },
    { source: "https://v1-dy.zjcdn.com/first.mp4", timeoutMs: 30_000 },
  ]);

  await assert.rejects(
    () => downloadCompatibleDouyinVideo({
      sourceResult: { source: "https://example.com/private.mp4" },
      destination: path.resolve("C:/bounded/video.mp4"),
      downloadFn: async () => ({ byteCount: 0 }),
    }),
    (error) => error instanceof DouyinMediaEvidenceError
      && error.code === DOUYIN_MEDIA_ERROR_CODES.SOURCE_UNAVAILABLE,
  );

  await assert.rejects(
    () => downloadCompatibleDouyinVideo({
      sourceResult: { source: "https://v1-dy.zjcdn.com/private-media-name.mp4" },
      destination: path.resolve("C:/bounded/video.mp4"),
      downloadFn: async () => {
        throw new Error("Douyin media range 2/4 failed after bounded retries (incomplete-range).");
      },
    }),
    (error) => {
      assert.ok(error instanceof DouyinVideoSourcesExhaustedError);
      assert.deepEqual(error.failures, ["range-2-of-4-incomplete-range"]);
      assert.doesNotMatch(error.message, /private-media-name|zjcdn/u);
      return true;
    },
  );
});

test("candidate fallback never deletes an unknown pre-existing destination", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-douyin-video-existing-"));
  const destination = path.join(projectRoot, "existing.mp4");
  try {
    await writeFile(destination, "keep");
    await assert.rejects(downloadCompatibleDouyinVideo({
      sourceResult: { source: "https://v1-dy.zjcdn.com/first.mp4" },
      destination,
      async downloadFn() {
        throw new Error("fixture download failed");
      },
    }), (error) => (
      error instanceof DouyinVideoSourcesExhaustedError
      && error.code === DOUYIN_MEDIA_ERROR_CODES.SOURCE_UNAVAILABLE
    ));
    assert.equal(await readFile(destination, "utf8"), "keep");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("retries the next video source only after an explicit local decode failure", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-douyin-video-decode-fallback-"));
  const calls = [];
  let activeSource = null;
  try {
    const result = await prepareLatestDouyinVideoMedia({
      cdp: null,
      projectRoot,
      sourceResult: {
        ok: true,
        source: "https://v1-dy.zjcdn.com/first.mp4",
        sources: [
          "https://v1-dy.zjcdn.com/first.mp4",
          "https://v2-dy.zjcdn.com/second.mp4",
        ],
      },
      async downloadFn({ source, destination }) {
        activeSource = source;
        calls.push({ operation: "download", source });
        await writeFile(destination, Buffer.from([1, 2, 3]));
        return { byteCount: 3, contentType: "video/mp4" };
      },
      async extractFn({ outputDirectory, extractAudio, maxOverallWallTimeMs }) {
        calls.push({ operation: "decode", source: activeSource });
        assert.equal(extractAudio, false);
        assert.ok(maxOverallWallTimeMs > 0);
        if (activeSource.includes("v1-dy")) {
          await writeFile(path.join(outputDirectory, "frame-01.png"), Buffer.from([9]));
          throw new DouyinVideoDecodeError("media-error-4");
        }
        await assert.rejects(access(path.join(outputDirectory, "frame-01.png")));
        return {
          framePaths: [path.join(outputDirectory, "frame-02.png")],
          duration: 1,
        };
      },
    });
    assert.equal(result.byteCount, 3);
    assert.equal(result.duration, 1);
    assert.deepEqual(calls.map(({ operation, source }) => ({ operation, source })), [
      { operation: "download", source: "https://v1-dy.zjcdn.com/first.mp4" },
      { operation: "decode", source: "https://v1-dy.zjcdn.com/first.mp4" },
      { operation: "download", source: "https://v2-dy.zjcdn.com/second.mp4" },
      { operation: "decode", source: "https://v2-dy.zjcdn.com/second.mp4" },
    ]);
    await removeVideoAnalysisJob(projectRoot, result.jobDirectory);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("does not hide non-decode video processing failures behind another source", async () => {
  let downloadCount = 0;
  await assert.rejects(
    () => downloadCompatibleDouyinVideo({
      sourceResult: {
        sources: [
          "https://v1-dy.zjcdn.com/first.mp4",
          "https://v2-dy.zjcdn.com/second.mp4",
        ],
      },
      destination: path.resolve("C:/bounded/video.mp4"),
      async downloadFn() {
        downloadCount += 1;
        return { byteCount: 3, contentType: "video/mp4" };
      },
      async validateFn() {
        throw new Error("frame pipeline failed");
      },
    }),
    /frame pipeline failed/u,
  );
  assert.equal(downloadCount, 1);
});

test("shares one bounded wall-clock budget across video download and validation", async () => {
  let currentTime = 0;
  let validationCalled = false;
  await assert.rejects(
    () => downloadCompatibleDouyinVideo({
      sourceResult: { source: "https://v1-dy.zjcdn.com/first.mp4" },
      destination: path.resolve("C:/bounded/video.mp4"),
      maxWallTimeMs: 1_000,
      now: () => currentTime,
      async downloadFn() {
        currentTime = 1_001;
        return { byteCount: 3, contentType: "video/mp4" };
      },
      async validateFn() {
        validationCalled = true;
        return {};
      },
    }),
    (error) => error instanceof DouyinMediaEvidenceError
      && error.code === DOUYIN_MEDIA_ERROR_CODES.BUDGET_EXCEEDED,
  );
  assert.equal(validationCalled, false);
});

test("video cleanup paths must be children of the dedicated runtime root", () => {
  const projectRoot = path.resolve("C:/project");
  const root = resolveVideoAnalysisRoot(projectRoot);
  assert.equal(
    assertVideoAnalysisJobPath(projectRoot, path.join(root, "job-1")),
    path.join(root, "job-1"),
  );
  assert.throws(() => assertVideoAnalysisJobPath(projectRoot, root));
  assert.throws(() => assertVideoAnalysisJobPath(projectRoot, path.join(projectRoot, "elsewhere")));
});
