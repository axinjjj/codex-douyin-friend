import { createDouyinAction, validateDouyinAction } from "./douyin-action-journal.mjs";

export function planDouyinIncomingQueue(messages, { action = null, chatKey = null } = {}) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 12) {
    return { ok: false, batches: [] };
  }
  if (messages.some((message) => (
    message?.side !== "left" || (message.kind !== "text" && message.kind !== "media")
  ))) {
    return { ok: false, batches: [] };
  }
  if (action !== null) return planCommittedActionQueue(messages, { action, chatKey });
  const batches = [];
  let index = 0;
  const leadingTextMessages = [];
  while (index < messages.length && messages[index].kind === "text") {
    leadingTextMessages.push(messages[index]);
    index += 1;
  }
  if (index === messages.length) {
    batches.push({
      mode: "text",
      textMessages: leadingTextMessages,
      mediaMessage: null,
      messages: [...leadingTextMessages],
    });
    return { ok: true, batches };
  }
  let textBeforeMedia = leadingTextMessages;
  while (index < messages.length) {
    const mediaMessage = messages[index];
    if (mediaMessage.kind !== "media") return { ok: false, batches: [] };
    index += 1;
    const textAfterMedia = [];
    while (index < messages.length && messages[index].kind === "text") {
      textAfterMedia.push(messages[index]);
      index += 1;
    }
    const textMessages = [...textBeforeMedia, ...textAfterMedia];
    batches.push({
      mode: "media",
      textMessages,
      mediaMessage,
      messages: [...textBeforeMedia, mediaMessage, ...textAfterMedia],
    });
    textBeforeMedia = [];
  }
  return { ok: batches.length > 0, batches };
}

// The existing v1 action-id algorithm commits to the ordered input and its original
// ordinals. Appends shift all surviving ordinals equally. Search the bounded 12-item
// domain and accept only a hash-proven unique prefix; never infer it from replyKind
// or regroup the enlarged queue. This also works across repeated v1/v2 restarts.
function planCommittedActionQueue(messages, { action, chatKey }) {
  const failure = { ok: false, batches: [], reason: "action-input-boundary-unavailable" };
  try {
    const committed = validateDouyinAction(action);
    if (messages.some((message, index) => (
      !Number.isSafeInteger(message.ordinalFromEnd)
      || message.ordinalFromEnd < 1 || message.ordinalFromEnd > 12
      || (index > 0 && messages[index - 1].ordinalFromEnd <= message.ordinalFromEnd)
    ))) return failure;
    const matches = new Set();
    for (let count = 1; count <= messages.length; count += 1) {
      const prefix = messages.slice(0, count);
      const prefixPlan = planDouyinIncomingQueue(prefix);
      if (!prefixPlan.ok || prefixPlan.batches.length !== 1) continue;
      // -1 is the exact all-zero ordinal convention already supported by
      // createDouyinAction for old callers, not an estimated DOM position.
      for (let shift = -1; shift < 12; shift += 1) {
        const original = prefix.map((message) => ({
          ...message,
          ordinalFromEnd: shift === -1 ? 0 : message.ordinalFromEnd - shift,
        }));
        if (shift !== -1
            && original.some((message) => message.ordinalFromEnd < 1)) continue;
        const candidate = createDouyinAction({
          chatKey,
          generation: committed.generation,
          pending: original,
        });
        if (candidate.id === committed.id) matches.add(count);
      }
    }
    if (matches.size !== 1) return failure;
    const count = [...matches][0];
    const first = planDouyinIncomingQueue(messages.slice(0, count));
    const remaining = count < messages.length
      ? planDouyinIncomingQueue(messages.slice(count))
      : { ok: true, batches: [] };
    if (!remaining.ok) return failure;
    return { ok: true, batches: [...first.batches, ...remaining.batches] };
  } catch {
    return failure;
  }
}
