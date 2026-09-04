import { createHash } from "node:crypto";

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const TARGET_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u;

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function normalizeDouyinChatPageUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:"
        || (url.hostname !== "douyin.com" && !url.hostname.endsWith(".douyin.com"))
        || !url.pathname.startsWith("/chat")) return null;
    return `${url.protocol}//${url.hostname}${url.pathname}`;
  } catch {
    return null;
  }
}

export function validateDouyinSendCapability(value) {
  if (!hasExactKeys(value, [
    "version",
    "chatFingerprint",
    "targetId",
    "pageEpoch",
    "pageUrlHash",
  ])) {
    throw new Error("Douyin send capability has an invalid shape.");
  }
  if (value.version !== 1
      || !HASH_PATTERN.test(value.chatFingerprint)
      || !TARGET_ID_PATTERN.test(value.targetId)
      || !HASH_PATTERN.test(value.pageEpoch)
      || !HASH_PATTERN.test(value.pageUrlHash)) {
    throw new Error("Douyin send capability is invalid.");
  }
  return { ...value };
}

export function parseDouyinSendCapability(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return null;
  try {
    return validateDouyinSendCapability(JSON.parse(value));
  } catch {
    return null;
  }
}

export function createDouyinSendCapability({ chatFingerprint, target, pageEpoch }) {
  const normalizedUrl = normalizeDouyinChatPageUrl(target?.url);
  return validateDouyinSendCapability({
    version: 1,
    chatFingerprint,
    targetId: String(target?.id || ""),
    pageEpoch,
    pageUrlHash: normalizedUrl ? digest(normalizedUrl) : "",
  });
}

export function computeDouyinSendCapabilityDigest(value) {
  const capability = validateDouyinSendCapability(value);
  return digest([
    "douyin-send-capability-v1",
    capability.chatFingerprint,
    capability.targetId,
    capability.pageEpoch,
    capability.pageUrlHash,
  ].join("|"));
}

export function douyinSendCapabilitiesMatch(left, right) {
  try {
    return computeDouyinSendCapabilityDigest(left) === computeDouyinSendCapabilityDigest(right);
  } catch {
    return false;
  }
}

export function selectDouyinChatTarget(targets, {
  capability = null,
  isChatTarget,
} = {}) {
  if (!Array.isArray(targets) || typeof isChatTarget !== "function") {
    throw new Error("Douyin target selection input is invalid.");
  }
  const chatTargets = targets.filter(isChatTarget);
  if (capability) {
    const expected = validateDouyinSendCapability(capability);
    const exact = chatTargets.filter((target) => {
      const normalizedUrl = normalizeDouyinChatPageUrl(target.url);
      return target.id === expected.targetId
        && normalizedUrl !== null
        && digest(normalizedUrl) === expected.pageUrlHash;
    });
    if (exact.length !== 1) {
      throw new Error("The verified Douyin chat target is unavailable or ambiguous.");
    }
    return exact[0];
  }
  if (chatTargets.length !== 1) {
    throw new Error("Exactly one Douyin chat target is required before send authorization.");
  }
  return chatTargets[0];
}

export function buildGetOrCreateDouyinPageEpochExpression() {
  return `(async () => {
    const key = '__codexDouyinPageEpochV1';
    if (!/^[0-9a-f]{64}$/.test(window[key] || '')) {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      window[key] = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    const normalizedUrl = location.protocol + '//' + location.hostname + location.pathname;
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalizedUrl));
    const pageUrlHash = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    return { ok: true, pageEpoch: window[key], pageUrlHash };
  })()`;
}
