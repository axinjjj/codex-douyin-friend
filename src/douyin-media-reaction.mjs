import {
  buildInspectOpenMediaLikeMenuExpression,
  buildLocateIncomingMediaReactionTargetExpression,
} from "./douyin-chat-page.mjs";

const CHAT_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function dismissOpenMenu(cdp) {
  await cdp.request("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await cdp.request("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
}

async function openContextMenu(cdp, point) {
  if (!Number.isInteger(point?.x) || !Number.isInteger(point?.y)
      || point.x < 0 || point.y < 0 || point.x > 8_192 || point.y > 8_192) {
    throw new Error("Douyin returned an invalid media reaction point.");
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

export async function likeIncomingDouyinMediaMessage({
  cdp,
  message,
  expectedChatFingerprint,
  ordinalShift = 1,
  sleepFn = sleep,
} = {}) {
  if (!cdp || typeof cdp.evaluate !== "function" || typeof cdp.request !== "function") {
    throw new Error("A connected CDP client is required for a Douyin media reaction.");
  }
  if (!CHAT_FINGERPRINT_PATTERN.test(expectedChatFingerprint || "")) {
    throw new Error("A locked Douyin chat fingerprint is required for a media reaction.");
  }
  if (typeof sleepFn !== "function") throw new Error("A media reaction sleep function is required.");

  await dismissOpenMenu(cdp);
  try {
    const locate = () => cdp.evaluate(
      buildLocateIncomingMediaReactionTargetExpression(message, ordinalShift),
    );
    const firstLocation = await locate();
    if (!firstLocation?.ok) {
      throw new Error(`The Douyin media reaction target is unavailable: ${firstLocation?.reason || "unknown"}.`);
    }
    if (firstLocation.chatFingerprint !== expectedChatFingerprint) {
      throw new Error("The Douyin chat changed before the media reaction.");
    }

    await openContextMenu(cdp, firstLocation.point);
    await sleepFn(250);
    const before = await cdp.evaluate(buildInspectOpenMediaLikeMenuExpression());
    if (!before?.ok) {
      throw new Error(`The Douyin media message menu is unavailable: ${before?.reason || "unknown"}.`);
    }
    if (!before.available) {
      return { ok: true, applied: false, reason: "like-unavailable-or-already-applied" };
    }

    const activation = await cdp.evaluate(
      buildInspectOpenMediaLikeMenuExpression({ activate: true }),
    );
    if (!activation?.ok || !activation.activated) {
      throw new Error("The Douyin media like action could not be activated.");
    }
    await sleepFn(500);

    const verificationLocation = await locate();
    if (!verificationLocation?.ok
        || verificationLocation.chatFingerprint !== expectedChatFingerprint) {
      throw new Error("The Douyin media reaction target changed before verification.");
    }
    await openContextMenu(cdp, verificationLocation.point);
    await sleepFn(250);
    const after = await cdp.evaluate(buildInspectOpenMediaLikeMenuExpression());
    if (!after?.ok || after.available) {
      throw new Error("The Douyin media like action could not be verified.");
    }
    return { ok: true, applied: true, reason: null };
  } finally {
    await dismissOpenMenu(cdp).catch(() => {});
  }
}
