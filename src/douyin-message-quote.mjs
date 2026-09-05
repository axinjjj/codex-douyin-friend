import {
  buildBindDouyinMediaQuoteExpression,
  buildCancelDouyinMediaQuoteExpression,
  buildInspectOpenMediaReplyMenuExpression,
  buildLocateIncomingMediaReactionTargetExpression,
  buildPrepareDouyinMediaQuoteExpression,
  buildReleaseDouyinMediaQuoteExpression,
  buildVerifyDouyinMediaQuoteClearedExpression,
} from "./douyin-chat-page.mjs";

const CHAT_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const QUOTE_NONCE_PATTERN = /^[0-9a-f]{24}$/u;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function shouldQuoteDouyinMediaReply({
  replyKind,
  mediaType,
  quoteTargetFingerprint,
} = {}) {
  return replyKind === "video" && mediaType === "shared_aweme"
    && /^[0-9a-f]{64}$/u.test(quoteTargetFingerprint || "");
}

async function openContextMenu(cdp, point) {
  if (!Number.isInteger(point?.x) || !Number.isInteger(point?.y)
      || point.x < 0 || point.y < 0 || point.x > 8_192 || point.y > 8_192) {
    throw new Error("Douyin returned an invalid media quote point.");
  }
  await cdp.request("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "right",
    buttons: 2,
    clickCount: 1,
  });
  await cdp.request("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "right",
    buttons: 0,
    clickCount: 1,
  });
}

async function clickPoint(cdp, point) {
  if (!Number.isInteger(point?.x) || !Number.isInteger(point?.y)
      || point.x < 0 || point.y < 0 || point.x > 8_192 || point.y > 8_192) {
    throw new Error("Douyin returned an invalid media quote control point.");
  }
  await cdp.request("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await cdp.request("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

export async function bindIncomingDouyinMediaQuote({
  cdp,
  message,
  expectedChatFingerprint,
  quoteNonce,
  quoteTargetFingerprint,
  expectedText,
  sleepFn = sleep,
} = {}) {
  if (!cdp || typeof cdp.evaluate !== "function" || typeof cdp.request !== "function") {
    throw new Error("A connected CDP client is required for a Douyin media quote.");
  }
  if (!CHAT_FINGERPRINT_PATTERN.test(expectedChatFingerprint || "")) {
    throw new Error("A locked Douyin chat fingerprint is required for a media quote.");
  }
  if (!QUOTE_NONCE_PATTERN.test(quoteNonce || "")) {
    throw new Error("A media quote nonce is required.");
  }
  if (!CHAT_FINGERPRINT_PATTERN.test(quoteTargetFingerprint || "")) {
    throw new Error("A stable media quote target fingerprint is required.");
  }
  if (typeof expectedText !== "string" || !expectedText.trim()) {
    throw new Error("The exact media quote reply text is required.");
  }
  if (typeof sleepFn !== "function") throw new Error("A media quote sleep function is required.");

  let owned = false;
  try {
    const preparation = await cdp.evaluate(
      buildPrepareDouyinMediaQuoteExpression({
        message,
        expectedChatFingerprint,
        quoteNonce,
        quoteTargetFingerprint,
        expectedText,
      }),
    );
    if (!preparation?.ok) {
      throw new Error(`The Douyin media quote editor is unavailable: ${preparation?.reason || "unknown"}.`);
    }
    owned = true;
    if (preparation.state === "bound") {
      return {
        ok: true,
        nonce: quoteNonce,
        resumed: true,
        draftPresent: Boolean(preparation.draftPresent),
      };
    }
    const location = await cdp.evaluate(
      buildLocateIncomingMediaReactionTargetExpression(message, 0),
    );
    if (!location?.ok) {
      throw new Error(`The Douyin media quote target is unavailable: ${location?.reason || "unknown"}.`);
    }
    if (location.chatFingerprint !== expectedChatFingerprint) {
      throw new Error("The Douyin chat changed before the media quote.");
    }
    await openContextMenu(cdp, location.point);
    await sleepFn(250);
    const menu = await cdp.evaluate(buildInspectOpenMediaReplyMenuExpression());
    if (!menu?.ok) {
      throw new Error(`The Douyin media reply action is unavailable: ${menu?.reason || "unknown"}.`);
    }
    const activation = await cdp.evaluate(
      buildInspectOpenMediaReplyMenuExpression({ activate: true }),
    );
    if (!activation?.ok || !activation.activated) {
      throw new Error("The Douyin media reply action could not be activated.");
    }
    await sleepFn(250);
    const binding = await cdp.evaluate(buildBindDouyinMediaQuoteExpression({
      message,
      expectedChatFingerprint,
      quoteNonce,
      quoteTargetFingerprint,
      expectedText,
    }));
    if (!binding?.ok) {
      throw new Error(`The Douyin media quote could not be bound: ${binding?.reason || "unknown"}.`);
    }
    return {
      ok: true,
      nonce: quoteNonce,
      resumed: Boolean(preparation.resumed),
      draftPresent: Boolean(binding.draftPresent),
    };
  } catch (error) {
    if (owned) {
      await cancelBoundDouyinMediaQuote({
        cdp,
        expectedChatFingerprint,
        quoteNonce,
        quoteTargetFingerprint,
        sleepFn,
      }).catch(() => {});
    }
    throw error;
  }
}

export async function cancelBoundDouyinMediaQuote({
  cdp,
  expectedChatFingerprint,
  quoteNonce,
  quoteTargetFingerprint,
  requireBoundPreview = false,
  sleepFn = sleep,
} = {}) {
  if (typeof sleepFn !== "function") throw new Error("A media quote sleep function is required.");
  const authority = await cdp.evaluate(buildCancelDouyinMediaQuoteExpression({
    expectedChatFingerprint,
    quoteNonce,
    quoteTargetFingerprint,
    requireBoundPreview,
  }));
  if (!authority?.ok) {
    throw new Error(`The owned Douyin media quote could not be cancelled: ${authority?.reason || "unknown"}.`);
  }
  if (!authority.armedOnly) {
    await clickPoint(cdp, authority.point);
    await sleepFn(100);
  }
  const verification = await cdp.evaluate(buildVerifyDouyinMediaQuoteClearedExpression({
    expectedChatFingerprint,
    quoteNonce,
    quoteTargetFingerprint,
  }));
  if (!verification?.ok) {
    throw new Error(`The owned Douyin media quote cleanup could not be verified: ${verification?.reason || "unknown"}.`);
  }
  return verification;
}

export async function releaseBoundDouyinMediaQuote({
  cdp,
  expectedChatFingerprint,
  quoteNonce,
  quoteTargetFingerprint,
  allowMissing = false,
} = {}) {
  const result = await cdp.evaluate(buildReleaseDouyinMediaQuoteExpression({
    expectedChatFingerprint,
    quoteNonce,
    quoteTargetFingerprint,
    allowMissing,
  }));
  if (!result?.ok) {
    throw new Error(`The Douyin media quote binding could not be released: ${result?.reason || "unknown"}.`);
  }
  return result;
}

export async function cleanupRecoveredDouyinMediaQuote({
  cdp,
  expectedChatFingerprint,
  quoteNonce,
  quoteTargetFingerprint,
  sleepFn = sleep,
} = {}) {
  const release = await cdp.evaluate(buildReleaseDouyinMediaQuoteExpression({
    expectedChatFingerprint,
    quoteNonce,
    quoteTargetFingerprint,
    allowMissing: true,
  }));
  if (release?.ok) return release;
  if (release?.reason !== "media-quote-send-cleanup-unverified") {
    throw new Error(`The recovered Douyin media quote binding could not be released: ${release?.reason || "unknown"}.`);
  }
  return cancelBoundDouyinMediaQuote({
    cdp,
    expectedChatFingerprint,
    quoteNonce,
    quoteTargetFingerprint,
    requireBoundPreview: true,
    sleepFn,
  });
}
