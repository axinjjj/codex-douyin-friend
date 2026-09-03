import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAdaptiveScanTimes,
  buildAudioAnchorsFromSegments,
  computeVisualDifference,
  deriveSceneThreshold,
  findSceneChanges,
  getAdaptiveFramePlan,
  MAX_FINAL_FRAME_COUNT,
  MAX_SCAN_SAMPLE_COUNT,
  selectAdaptiveFrameSamples,
} from "../src/video-frame-selection.mjs";

const signature = (value) => Array(160).fill(value);

test("uses duration tiers with hard scan and final-frame ceilings", () => {
  assert.deepEqual(getAdaptiveFramePlan(10), { frameBudget: 5, scanBudget: 12 });
  assert.deepEqual(getAdaptiveFramePlan(60), { frameBudget: 8, scanBudget: 24 });
  assert.deepEqual(getAdaptiveFramePlan(180), { frameBudget: 12, scanBudget: 40 });
  assert.deepEqual(getAdaptiveFramePlan(480), { frameBudget: 16, scanBudget: 56 });
  assert.deepEqual(getAdaptiveFramePlan(3_600), {
    frameBudget: MAX_FINAL_FRAME_COUNT,
    scanBudget: MAX_SCAN_SAMPLE_COUNT,
  });
  assert.throws(() => getAdaptiveFramePlan(Number.POSITIVE_INFINITY));
});

test("builds bounded scan coverage while retaining boundaries and explicit audio anchors", () => {
  const times = buildAdaptiveScanTimes(900, {
    scanBudget: 12,
    audioAnchors: [
      { time: 123.45, weight: 5 },
      { time: 456.78, weight: 4 },
    ],
  });
  assert.ok(times.length <= 12);
  assert.ok(times[0] <= 0.11);
  assert.ok(times.at(-1) >= 899.89);
  assert.ok(times.some((time) => Math.abs(time - 123.45) < 0.001));
  assert.ok(times.some((time) => Math.abs(time - 456.78) < 0.001));

  const capped = buildAdaptiveScanTimes(7_200, { scanBudget: 10_000 });
  assert.equal(capped.length, MAX_SCAN_SAMPLE_COUNT);
  assert.equal(buildAdaptiveScanTimes(60, { scanBudget: Number.NaN }).length, 24);

  const weighted = buildAdaptiveScanTimes(60, {
    scanBudget: 6,
    audioAnchors: [
      { time: 5, weight: 1 },
      { time: 15, weight: 1 },
      { time: 25, weight: 5 },
      { time: 45, weight: 1 },
    ],
  });
  assert.ok(weighted.some((time) => Math.abs(time - 25) < 0.001));
});

test("computes visual differences and a robust scene threshold deterministically", () => {
  assert.equal(computeVisualDifference(signature(3), signature(3)), 0);
  assert.ok(computeVisualDifference(signature(0), signature(15)) > 0.75);
  const threshold = deriveSceneThreshold([0.01, 0.02, 0.02, 0.03, 0.7]);
  assert.ok(threshold >= 0.12 && threshold < 0.7);

  const sceneResult = findSceneChanges([
    { time: 0, signature: signature(0) },
    { time: 1, signature: signature(0) },
    { time: 2, signature: signature(15) },
    { time: 3, signature: signature(15) },
  ]);
  assert.deepEqual(sceneResult.changes.map(({ index }) => index), [2]);
});

test("derives bounded speech and tag-change anchors only from timed segments", () => {
  const anchors = buildAudioAnchorsFromSegments([
    {
      startSeconds: 2,
      endSeconds: 5,
      emotions: ["NEUTRAL"],
      events: ["SPEECH"],
    },
    {
      startSeconds: 8,
      endSeconds: 11,
      emotions: ["HAPPY"],
      events: ["SPEECH", "LAUGHTER"],
    },
    { startSeconds: null, endSeconds: 15, emotions: [], events: [] },
  ], 20, { maxAnchors: 4 });
  assert.ok(anchors.length <= 4);
  assert.ok(anchors.some((anchor) => anchor.time === 8 && anchor.reason === "audio-tag-change"));
  assert.ok(anchors.every((anchor) => anchor.time >= 0 && anchor.time <= 20));
  assert.deepEqual(buildAudioAnchorsFromSegments([], 20), []);
});

test("fuses audio anchors, time coverage, scene changes, and visual deduplication", () => {
  const samples = Array.from({ length: 13 }, (_, index) => ({
    time: index * 5,
    signature: signature(index === 4 ? 15 : index),
  }));
  samples[3].signature = samples[2].signature;
  const result = selectAdaptiveFrameSamples({
    samples,
    durationSeconds: 60,
    frameBudget: 6,
    audioAnchors: [{ time: 20, weight: 5, reason: "audio-tag-change" }],
  });
  assert.ok(result.selected.some((sample) => sample.time === 20));
  assert.ok(result.selected.some((sample) => sample.time === 0));
  assert.ok(result.selected.some((sample) => sample.time === 60));
  assert.ok(result.selected.length <= 6);
  assert.equal(result.selected.some((sample) => sample.time === 15), false);
});

test("reserves remaining capacity for both scene changes and distributed audio anchors", () => {
  const samples = [
    { time: 0, signature: signature(0) },
    { time: 10, signature: signature(15) },
    { time: 20, signature: signature(14) },
    { time: 30, signature: signature(1) },
    { time: 40, signature: signature(8) },
    { time: 50, signature: signature(8) },
    { time: 60, signature: signature(2) },
  ];
  const result = selectAdaptiveFrameSamples({
    samples,
    durationSeconds: 60,
    frameBudget: 5,
    audioAnchors: [{ time: 40, weight: 5, reason: "audio-tag-change" }],
  });
  assert.ok(result.selected.some((sample) => sample.reasons.includes("scene-change")));
  assert.ok(result.selected.some((sample) => sample.reasons.includes("audio-tag-change")));
});

test("never lets caller-provided budgets bypass the final-frame hard cap", () => {
  const samples = Array.from({ length: 100 }, (_, index) => ({
    time: index * 100 / 99,
    signature: Array.from({ length: 160 }, (__, cell) => (index + cell) % 16),
  }));
  const result = selectAdaptiveFrameSamples({
    samples,
    durationSeconds: 100,
    frameBudget: 10_000,
  });
  assert.ok(result.selected.length <= MAX_FINAL_FRAME_COUNT);

  const nanBudgetResult = selectAdaptiveFrameSamples({
    samples,
    durationSeconds: 100,
    frameBudget: Number.NaN,
    audioAnchors: samples.map((sample) => ({ time: sample.time, weight: 5 })),
  });
  assert.equal(nanBudgetResult.selected.length <= 8, true);
});

test("fails closed when a truncated scan does not contain real boundary samples", () => {
  assert.throws(() => selectAdaptiveFrameSamples({
    samples: [
      { time: 0.1, signature: signature(0) },
      { time: 10, signature: signature(5) },
      { time: 20, signature: signature(10) },
    ],
    durationSeconds: 60,
    frameBudget: 5,
  }), /Opening or ending scan samples are missing/u);
});
