import test from "node:test";
import assert from "node:assert/strict";
import {
  createDouyinMediaEvidence,
  DouyinMediaEvidenceError,
  DOUYIN_EVIDENCE_MODES,
  DOUYIN_MEDIA_ERROR_CODES,
  isDouyinCoverFallbackEligible,
} from "../src/douyin-media-evidence.mjs";

test("cover fallback is an explicit error-code allowlist", () => {
  for (const code of [
    DOUYIN_MEDIA_ERROR_CODES.SOURCE_UNAVAILABLE,
    DOUYIN_MEDIA_ERROR_CODES.DECODE_UNAVAILABLE,
    DOUYIN_MEDIA_ERROR_CODES.NO_DECODED_FRAME_WITHIN_DEADLINE,
  ]) {
    assert.equal(isDouyinCoverFallbackEligible(new DouyinMediaEvidenceError(code)), true);
  }
  for (const code of [
    DOUYIN_MEDIA_ERROR_CODES.ABORTED,
    DOUYIN_MEDIA_ERROR_CODES.BUDGET_EXCEEDED,
    DOUYIN_MEDIA_ERROR_CODES.IDENTITY_MISMATCH,
    DOUYIN_MEDIA_ERROR_CODES.RESOURCE_LIMIT,
    DOUYIN_MEDIA_ERROR_CODES.CANVAS_SECURITY,
    DOUYIN_MEDIA_ERROR_CODES.INTERNAL,
  ]) {
    assert.equal(isDouyinCoverFallbackEligible(new DouyinMediaEvidenceError(code)), false);
  }
  assert.equal(isDouyinCoverFallbackEligible(new Error("generic")), false);
});

test("structured evidence preserves order and honest limitations", () => {
  assert.deepEqual(createDouyinMediaEvidence({
    mode: DOUYIN_EVIDENCE_MODES.PARTIAL_IMAGES,
    assetCount: 2,
    totalAssetCount: 4,
    limitations: ["some-selected-images-unavailable", "some-selected-images-unavailable"],
  }), {
    version: 1,
    mode: "partial-images",
    assetCount: 2,
    totalAssetCount: 4,
    audioStatus: "not-applicable",
    limitations: ["some-selected-images-unavailable"],
    orderedAssets: [
      { type: "image", ordinal: 1 },
      { type: "image", ordinal: 2 },
    ],
  });
});
