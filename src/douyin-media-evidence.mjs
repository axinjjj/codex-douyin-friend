export const DOUYIN_EVIDENCE_MODES = Object.freeze({
  COMPLETE_VIDEO: "complete-video",
  VISUAL_ONLY: "visual-only",
  DECODED_BLACK: "decoded-black",
  COMPLETE_IMAGES: "complete-images",
  PARTIAL_IMAGES: "partial-images",
  DIRECT_IMAGE: "direct-image",
  COVER_ONLY: "cover-only",
});

export const DOUYIN_MEDIA_ERROR_CODES = Object.freeze({
  SOURCE_UNAVAILABLE: "SOURCE_UNAVAILABLE",
  DECODE_UNAVAILABLE: "DECODE_UNAVAILABLE",
  NO_DECODED_FRAME_WITHIN_DEADLINE: "NO_DECODED_FRAME_WITHIN_DEADLINE",
  ABORTED: "ABORTED",
  BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
  IDENTITY_MISMATCH: "IDENTITY_MISMATCH",
  RESOURCE_LIMIT: "RESOURCE_LIMIT",
  CANVAS_SECURITY: "CANVAS_SECURITY",
  INTERNAL: "INTERNAL",
});

const FALLBACK_ELIGIBLE = new Set([
  DOUYIN_MEDIA_ERROR_CODES.SOURCE_UNAVAILABLE,
  DOUYIN_MEDIA_ERROR_CODES.DECODE_UNAVAILABLE,
  DOUYIN_MEDIA_ERROR_CODES.NO_DECODED_FRAME_WITHIN_DEADLINE,
]);

export class DouyinMediaEvidenceError extends Error {
  constructor(code, reason = "media-evidence-failed", { failures = [] } = {}) {
    if (!Object.values(DOUYIN_MEDIA_ERROR_CODES).includes(code)) {
      throw new TypeError("Unknown Douyin media evidence error code.");
    }
    super(`Douyin media evidence failed (${code}:${reason}).`);
    this.name = "DouyinMediaEvidenceError";
    this.code = code;
    this.reason = /^[a-z0-9-]{1,80}$/u.test(reason) ? reason : "media-evidence-failed";
    this.failures = Array.isArray(failures)
      ? failures.filter((value) => /^[a-z0-9-]{1,80}$/u.test(value)).slice(0, 4)
      : [];
  }
}

export function isDouyinCoverFallbackEligible(error) {
  return error instanceof DouyinMediaEvidenceError && FALLBACK_ELIGIBLE.has(error.code);
}

export function createDouyinMediaEvidence({
  mode,
  assetCount,
  totalAssetCount = assetCount,
  audioStatus = "not-applicable",
  limitations = [],
}) {
  if (!Object.values(DOUYIN_EVIDENCE_MODES).includes(mode)
      || !Number.isSafeInteger(assetCount) || assetCount < 1 || assetCount > 18
      || !Number.isSafeInteger(totalAssetCount) || totalAssetCount < assetCount
      || totalAssetCount > 10_000
      || !/^[a-z0-9-]{1,80}$/u.test(audioStatus)) {
    throw new Error("Douyin media evidence is invalid.");
  }
  const safeLimitations = [...new Set(limitations)]
    .filter((value) => typeof value === "string" && /^[a-z0-9-]{1,80}$/u.test(value))
    .slice(0, 8);
  return Object.freeze({
    version: 1,
    mode,
    assetCount,
    totalAssetCount,
    audioStatus,
    limitations: Object.freeze(safeLimitations),
    orderedAssets: Object.freeze(Array.from({ length: assetCount }, (_, index) => Object.freeze({
      type: mode.includes("video") || mode === DOUYIN_EVIDENCE_MODES.VISUAL_ONLY
        || mode === DOUYIN_EVIDENCE_MODES.DECODED_BLACK ? "frame" : "image",
      ordinal: index + 1,
    }))),
  });
}
