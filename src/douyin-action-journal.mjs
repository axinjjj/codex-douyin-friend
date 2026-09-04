import { createHash } from "node:crypto";

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const TURN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u;
const REACTION_NONCE_PATTERN = /^[0-9a-f]{24}$/u;
const STAGES = new Set([
  "planned",
  "evidence-ready",
  "turn-starting",
  "turn-started",
  "reply-ready",
  "send-attempted",
  "send-verified",
  "reaction-attempted",
]);
const REPLY_KINDS = new Set(["text", "image", "video"]);
const REACTION_DECISIONS = new Set(["disabled", "yes", "no", "missing", "invalid"]);
const ALLOWED_TRANSITIONS = new Map([
  ["planned", new Set(["evidence-ready", "turn-starting"])],
  ["evidence-ready", new Set(["turn-starting"])],
  ["turn-starting", new Set(["turn-started"])],
  ["turn-started", new Set(["turn-started", "reply-ready"])],
  ["reply-ready", new Set(["send-attempted"])],
  ["send-attempted", new Set(["send-verified"])],
  ["send-verified", new Set(["reaction-attempted"])],
  ["reaction-attempted", new Set()],
]);

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exactObject(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function normalizeReactionTarget(value) {
  if (value === null) return null;
  if (!exactObject(value, ["fingerprint", "kind", "side", "ordinalFromEnd"])) {
    throw new Error("Douyin action reaction target has an invalid shape.");
  }
  if (!HASH_PATTERN.test(value.fingerprint) || value.kind !== "media" || value.side !== "left"
      || !Number.isSafeInteger(value.ordinalFromEnd) || value.ordinalFromEnd < 1
      || value.ordinalFromEnd > 12) {
    throw new Error("Douyin action reaction target is invalid.");
  }
  return { ...value };
}

export function validateDouyinAction(value) {
  if (!exactObject(value, [
    "version",
    "id",
    "generation",
    "stage",
    "promptDigest",
    "turnIds",
    "replyDigest",
    "replyKind",
    "reactionNonce",
    "reactionDecision",
    "reactionTarget",
    "reactionOrdinalShift",
  ])) {
    throw new Error("Douyin action journal entry has an invalid shape.");
  }
  if (value.version !== 1 || !HASH_PATTERN.test(value.id)
      || !Number.isSafeInteger(value.generation) || value.generation < 1
      || !STAGES.has(value.stage)) {
    throw new Error("Douyin action journal entry is invalid.");
  }
  if (value.promptDigest !== null && !HASH_PATTERN.test(value.promptDigest)) {
    throw new Error("Douyin action prompt digest is invalid.");
  }
  if (!Array.isArray(value.turnIds) || value.turnIds.length > 2
      || value.turnIds.some((turnId) => !TURN_ID_PATTERN.test(turnId))
      || new Set(value.turnIds).size !== value.turnIds.length) {
    throw new Error("Douyin action turn ids are invalid.");
  }
  if (value.replyDigest !== null && !HASH_PATTERN.test(value.replyDigest)) {
    throw new Error("Douyin action reply digest is invalid.");
  }
  if (value.replyKind !== null && !REPLY_KINDS.has(value.replyKind)) {
    throw new Error("Douyin action reply kind is invalid.");
  }
  if (value.reactionNonce !== null && !REACTION_NONCE_PATTERN.test(value.reactionNonce)) {
    throw new Error("Douyin action reaction nonce is invalid.");
  }
  if (value.reactionDecision !== null && !REACTION_DECISIONS.has(value.reactionDecision)) {
    throw new Error("Douyin action reaction decision is invalid.");
  }
  if (!Number.isSafeInteger(value.reactionOrdinalShift)
      || value.reactionOrdinalShift < 0 || value.reactionOrdinalShift > 12) {
    throw new Error("Douyin action reaction ordinal shift is invalid.");
  }
  const normalized = {
    ...value,
    turnIds: [...value.turnIds],
    reactionTarget: normalizeReactionTarget(value.reactionTarget),
  };
  if (["turn-started", "reply-ready", "send-attempted", "send-verified", "reaction-attempted"]
      .includes(normalized.stage) && normalized.turnIds.length === 0) {
    throw new Error("Douyin action stage requires a Codex turn id.");
  }
  if (["reply-ready", "send-attempted", "send-verified", "reaction-attempted"]
      .includes(normalized.stage)
      && (!normalized.replyDigest || !normalized.replyKind || normalized.reactionDecision === null)) {
    throw new Error("Douyin action stage requires a verified reply decision.");
  }
  return normalized;
}

export function createDouyinAction({ chatKey, generation, pending, replyKind = null }) {
  if (!HASH_PATTERN.test(chatKey) || !Number.isSafeInteger(generation) || generation < 1
      || !Array.isArray(pending) || pending.length === 0 || pending.length > 12) {
    throw new Error("Douyin action identity input is invalid.");
  }
  const identity = pending.map((message, index) => {
    if (!HASH_PATTERN.test(message?.fingerprint)
        || !["text", "media"].includes(message?.kind) || message?.side !== "left") {
      throw new Error("Douyin action pending message identity is invalid.");
    }
    const ordinal = Number.isSafeInteger(message.ordinalFromEnd) ? message.ordinalFromEnd : 0;
    return [index, message.fingerprint, message.kind, message.side, ordinal].join(":");
  });
  return validateDouyinAction({
    version: 1,
    id: digest(["douyin-inbound-action-v1", chatKey, generation, ...identity].join("|")),
    generation,
    stage: "planned",
    promptDigest: null,
    turnIds: [],
    replyDigest: null,
    replyKind,
    reactionNonce: null,
    reactionDecision: null,
    reactionTarget: null,
    reactionOrdinalShift: 0,
  });
}

export function transitionDouyinAction(action, stage, patch = {}) {
  const current = validateDouyinAction(action);
  if (!ALLOWED_TRANSITIONS.get(current.stage)?.has(stage)) {
    throw new Error(`Invalid Douyin action transition from ${current.stage} to ${stage}.`);
  }
  const candidate = {
    ...current,
    ...patch,
    stage,
    turnIds: patch.turnIds ? [...patch.turnIds] : current.turnIds,
  };
  return validateDouyinAction(candidate);
}

export function computeDouyinTurnPromptDigest(params) {
  const input = params?.input ?? [{ type: "text", text: params?.text }];
  return digest(JSON.stringify({
    version: 1,
    threadId: params?.threadId ?? null,
    model: params?.model ?? null,
    effort: params?.effort ?? null,
    input,
  }));
}

export function computeDouyinReplyDigest(reply) {
  return digest(String(reply ?? ""));
}
