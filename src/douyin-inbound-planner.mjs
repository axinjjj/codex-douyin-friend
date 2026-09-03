export function planDouyinIncomingQueue(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 12) {
    return { ok: false, batches: [] };
  }
  if (messages.some((message) => (
    message?.side !== "left" || (message.kind !== "text" && message.kind !== "media")
  ))) {
    return { ok: false, batches: [] };
  }
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
