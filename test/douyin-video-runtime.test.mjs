import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  assertVideoAnalysisJobPath,
  buildCaptureFrameExpression,
  buildExtractAudioExpression,
  buildScanFrameSignaturesExpression,
  cleanupStaleVideoAnalysisJobs,
  downloadCompatibleDouyinVideo,
  downloadDouyinVideo,
  isTrustedDouyinMediaUrl,
  resolveVideoAnalysisRoot,
} from "../src/douyin-video-runtime.mjs";

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
  assert.match(scanExpression, /ending = await capture\(requestedTimes\.at\(-1\)\)/u);
  const requestedTimes = JSON.parse(/const requestedTimes = (\[[^;]+\]);/u.exec(scanExpression)[1]);
  assert.equal(requestedTimes.length, 72);

  const captureExpression = buildCaptureFrameExpression(5, 2_048);
  assert.match(captureExpression, /768 \/ video\.videoWidth/u);
  assert.match(captureExpression, /768 \/ video\.videoHeight/u);
  assert.match(captureExpression, /toDataURL\('image\/png'\)/u);
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
    /no trusted compatible source candidate/u,
  );
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
